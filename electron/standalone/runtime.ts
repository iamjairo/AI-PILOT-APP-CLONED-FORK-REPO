import { ipcMain } from 'electron';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PilotSessionManager } from '../services/pi-session-manager';
import { DevCommandsService } from '../services/dev-commands';
import { ExtensionManager } from '../services/extension-manager';
import { registerAgentIpc, setPromptLibraryRef } from '../ipc/agent';
import { registerModelIpc } from '../ipc/model';
import { registerSandboxIpc } from '../ipc/sandbox';
import { registerSessionIpc } from '../ipc/session';
import { registerSettingsIpc } from '../ipc/settings';
import { registerAuthIpc } from '../ipc/auth';
import { registerGitIpc } from '../ipc/git';
import { registerProjectIpc } from '../ipc/project';
import { registerDevCommandsIpc } from '../ipc/dev-commands';
import { registerExtensionsIpc } from '../ipc/extensions';
import { registerWorkspaceIpc } from '../ipc/workspace';
import { registerMemoryIpc } from '../ipc/memory';
import { registerTasksIpc } from '../ipc/tasks';
import { registerPromptsIpc } from '../ipc/prompts';
import { registerCompanionIpc } from '../ipc/companion';
import { registerSubagentIpc } from '../ipc/subagent';
import { registerAttachmentIpc } from '../ipc/attachment';
import { registerMcpIpc } from '../ipc/mcp';
import { registerOllamaIpc } from '../ipc/ollama';
import { McpManager } from '../services/mcp-manager';
import { PromptLibrary } from '../services/prompt-library';
import { CommandRegistry } from '../services/command-registry';
import { CompanionAuth } from '../services/companion-auth';
import { CompanionServer } from '../services/companion-server';
import { CompanionDiscovery } from '../services/companion-discovery';
import { CompanionRemote } from '../services/companion-remote';
import { companionBridge, syncAllHandlers } from '../services/companion-ipc-bridge';
import { ensureTLSCert } from '../services/companion-tls';
import { PILOT_APP_DIR } from '../services/pilot-paths';
import { getEffectiveCompanionSettings } from '../services/app-settings';
import { IPC } from '../../shared/ipc';
import { broadcastToRenderer } from '../utils/broadcast';
import { OllamaService } from '../services/ollama-service';

export interface StandaloneBackendRuntimeOptions {
  docsDir: string;
  reactBundlePath: string;
}

export class StandaloneBackendRuntime {
  public sessionManager: PilotSessionManager | null = null;
  public devService: DevCommandsService | null = null;
  public extensionManager: ExtensionManager | null = null;
  public promptLibrary: PromptLibrary | null = null;
  public companionAuth: CompanionAuth | null = null;
  public companionServer: CompanionServer | null = null;
  public companionDiscovery: CompanionDiscovery | null = null;
  public companionRemote: CompanionRemote | null = null;
  public mcpManager: McpManager | null = null;
  public ollamaService: OllamaService | null = null;

  async start(options: StandaloneBackendRuntimeOptions): Promise<void> {
    const { docsDir, reactBundlePath } = options;

    this.sessionManager = new PilotSessionManager();
    this.devService = new DevCommandsService();
    this.extensionManager = new ExtensionManager();
    this.mcpManager = new McpManager();
    this.sessionManager.mcpManager = this.mcpManager;

    this.ollamaService = new OllamaService();
    this.ollamaService.init(this.sessionManager.getModelRegistry());

    registerAgentIpc(this.sessionManager);
    registerModelIpc(this.sessionManager);
    registerSandboxIpc(this.sessionManager);
    registerSessionIpc(this.sessionManager);
    registerSettingsIpc(this.sessionManager);
    registerAuthIpc(this.sessionManager);
    registerGitIpc();
    registerProjectIpc();
    registerDevCommandsIpc(this.devService);
    registerExtensionsIpc(this.extensionManager);
    registerWorkspaceIpc();
    registerMemoryIpc(this.sessionManager.memoryManager);
    registerTasksIpc(this.sessionManager.taskManager);
    registerSubagentIpc(this.sessionManager.subagentManager);
    registerMcpIpc(this.mcpManager);
    registerOllamaIpc(this.ollamaService);
    registerAttachmentIpc();

    CommandRegistry.register('memory', 'Memory', 'Open memory panel');
    CommandRegistry.register('tasks', 'Tasks', 'Open task board');
    CommandRegistry.register('prompts', 'Prompt Library', 'Open prompt picker');
    CommandRegistry.register('orchestrate', 'Orchestrator', 'Enter orchestrator mode');
    CommandRegistry.register('spawn', 'Subagent', 'Quick-spawn a subagent');

    await this.initializeCompanionSystem(reactBundlePath);

    this.devService.onCommandStopped = (commandId: string) => {
      this.companionRemote?.removeTunnelByCommand(commandId);
    };

    this.devService.onServerUrlDetected = async (commandId: string, localUrl: string) => {
      if (!this.companionRemote?.isActive()) return;
      try {
        const url = new URL(localUrl);
        const port = parseInt(url.port, 10);
        if (!port) return;
        const commands = this.devService?.loadConfig() ?? [];
        const cmd = commands.find(c => c.id === commandId);
        const label = cmd?.label ?? commandId;
        const tunnelUrl = await this.companionRemote.tunnelPort(port, commandId, label, localUrl);
        if (tunnelUrl) {
          broadcastToRenderer(IPC.DEV_SERVER_URL, [commandId, localUrl, tunnelUrl]);
        }
      } catch (err) {
        console.error('[Companion] Failed to auto-tunnel dev server:', err);
      }
    };

    this.promptLibrary = new PromptLibrary();
    try {
      await this.promptLibrary.init();
    } catch (err) {
      console.error('Failed to initialize prompt library:', err);
    }
    registerPromptsIpc(this.promptLibrary);
    setPromptLibraryRef(this.promptLibrary);

    this.registerDocsIpc(docsDir);
    syncAllHandlers();
  }

  dispose(): void {
    this.sessionManager?.disposeAll();
    this.mcpManager?.disposeAll();
    this.ollamaService?.dispose();
    this.devService?.dispose();
    this.promptLibrary?.dispose();
    void this.companionServer?.stop();
    this.companionDiscovery?.stop();
    this.companionRemote?.dispose();
    companionBridge.shutdown();
  }

  private async initializeCompanionSystem(reactBundlePath: string): Promise<void> {
    this.companionAuth = new CompanionAuth(PILOT_APP_DIR);
    this.companionAuth.init().catch(err => {
      console.error('Failed to initialize companion auth:', err);
    });
    this.companionDiscovery = new CompanionDiscovery();
    this.companionRemote = new CompanionRemote();

    const companionSettings = getEffectiveCompanionSettings();

    if (companionSettings.protocol === 'https') {
      const { cert, key } = await ensureTLSCert(PILOT_APP_DIR);
      this.companionServer = new CompanionServer({
        port: companionSettings.port,
        protocol: 'https',
        reactBundlePath,
        tlsCert: cert,
        tlsKey: key,
        ipcBridge: companionBridge,
        auth: this.companionAuth,
      });
    } else {
      this.companionServer = new CompanionServer({
        port: companionSettings.port,
        protocol: 'http',
        reactBundlePath,
        ipcBridge: companionBridge,
        auth: this.companionAuth,
      });
    }

    await this.companionServer.start();
    const computerName = await CompanionDiscovery.getComputerName();
    await this.companionDiscovery.start(this.companionServer.port, computerName);
    console.log('[Companion] Standalone backend companion server started');

    let originalTlsCert: Buffer | null = null;
    let originalTlsKey: Buffer | null = null;

    this.companionRemote.onTlsCertChanged = (cert: Buffer, key: Buffer) => {
      if (this.companionServer) {
        if (!originalTlsCert) {
          originalTlsCert = this.companionServer['config'].tlsCert ?? null;
          originalTlsKey = this.companionServer['config'].tlsKey ?? null;
        }
        this.companionServer.updateTlsCerts(cert, key);
      }
    };

    const origDispose = this.companionRemote.dispose.bind(this.companionRemote);
    this.companionRemote.dispose = () => {
      origDispose();
      if (originalTlsCert && originalTlsKey && this.companionServer) {
        this.companionServer.updateTlsCerts(originalTlsCert, originalTlsKey);
        originalTlsCert = null;
        originalTlsKey = null;
        console.log('[Companion] Restored self-signed TLS certs');
      }
    };

    registerCompanionIpc({
      auth: this.companionAuth,
      getServer: () => this.companionServer,
      discovery: this.companionDiscovery,
      remote: this.companionRemote,
    });
  }

  private registerDocsIpc(docsDir: string): void {
    ipcMain.handle(IPC.DOCS_READ, (_event, page: string) => {
      try {
        const safePage = page.replace(/[^a-zA-Z0-9_-]/g, '');
        const filePath = join(docsDir, `${safePage}.md`);
        return readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    });

    ipcMain.handle(IPC.DOCS_LIST, () => {
      try {
        return readdirSync(docsDir)
          .filter(f => f.endsWith('.md'))
          .map(f => f.replace(/\.md$/, ''));
      } catch {
        return [];
      }
    });
  }
}
