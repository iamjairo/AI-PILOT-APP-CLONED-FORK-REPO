import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PilotSessionManager } from './pi-session-manager';
import { DevCommandsService } from './dev-commands';
import { ExtensionManager } from './extension-manager';
import { TerminalService } from './terminal-service';
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
import { registerShellIpc } from '../ipc/shell';
import { registerTerminalIpc } from '../ipc/terminal';
import { registerMemoryIpc } from '../ipc/memory';
import { registerTasksIpc } from '../ipc/tasks';
import { registerPromptsIpc } from '../ipc/prompts';
import { registerCompanionIpc } from '../ipc/companion';
import { registerSubagentIpc } from '../ipc/subagent';
import { registerAttachmentIpc } from '../ipc/attachment';
import { registerMcpIpc } from '../ipc/mcp';
import { registerDesktopIpc } from '../ipc/desktop';
import { registerThemeIpc } from '../ipc/theme';
import { registerOllamaIpc } from '../ipc/ollama';
import { DesktopService } from './desktop-service';
import { ThemeService } from './theme-service';
import { OllamaService } from './ollama-service';
import { McpManager } from './mcp-manager';
import { PromptLibrary } from './prompt-library';
import { CommandRegistry } from './command-registry';
import { CompanionAuth } from './companion-auth';
import { CompanionServer } from './companion-server';
import { CompanionDiscovery } from './companion-discovery';
import { CompanionRemote } from './companion-remote';
import { companionBridge, syncAllHandlers } from './companion-ipc-bridge';
import { ensureTLSCert } from './companion-tls';
import { PILOT_APP_DIR } from './pilot-paths';
import { getEffectiveCompanionSettings, loadAppSettings } from './app-settings';
import { IPC } from '../../shared/ipc';
import { broadcastToRenderer } from '../utils/broadcast';

type ThemePayload = string | { resolved: string; bgColor?: string; fgColor?: string };

export interface BackendRuntimeOptions {
  mainWindow: BrowserWindow | null;
  docsDir: string;
  backendOnly: boolean;
}

export class BackendRuntime {
  public readonly themeService: ThemeService;
  public sessionManager: PilotSessionManager | null = null;
  public devService: DevCommandsService | null = null;
  public extensionManager: ExtensionManager | null = null;
  public terminalService: TerminalService | null = null;
  public promptLibrary: PromptLibrary | null = null;
  public companionAuth: CompanionAuth | null = null;
  public companionServer: CompanionServer | null = null;
  public companionDiscovery: CompanionDiscovery | null = null;
  public companionRemote: CompanionRemote | null = null;
  public mcpManager: McpManager | null = null;
  public desktopService: DesktopService | null = null;
  public ollamaService: OllamaService | null = null;

  constructor() {
    this.themeService = new ThemeService();
  }

  async start(options: BackendRuntimeOptions): Promise<void> {
    const { mainWindow, docsDir, backendOnly } = options;

    this.sessionManager = new PilotSessionManager();
    this.devService = new DevCommandsService();
    this.extensionManager = new ExtensionManager();
    this.mcpManager = new McpManager();
    this.sessionManager.mcpManager = this.mcpManager;
    this.terminalService = mainWindow ? new TerminalService(mainWindow) : null;

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
    registerShellIpc();
    if (this.terminalService) {
      registerTerminalIpc(this.terminalService);
    }
    registerMemoryIpc(this.sessionManager.memoryManager);
    registerTasksIpc(this.sessionManager.taskManager);
    registerSubagentIpc(this.sessionManager.subagentManager);
    registerMcpIpc(this.mcpManager);
    registerOllamaIpc(this.ollamaService);
    registerAttachmentIpc();
    registerThemeIpc(this.themeService);

    try {
      this.desktopService = new DesktopService();
      this.sessionManager.desktopService = this.desktopService;
      this.desktopService.reconcileOnStartup().catch((err) => {
        console.error('[Desktop] reconcileOnStartup failed:', err);
      });
    } catch (err) {
      console.error('[Desktop] Failed to initialize service:', err);
    }
    registerDesktopIpc(this.desktopService, this.sessionManager);

    CommandRegistry.register('memory', 'Memory', 'Open memory panel');
    CommandRegistry.register('tasks', 'Tasks', 'Open task board');
    CommandRegistry.register('prompts', 'Prompt Library', 'Open prompt picker');
    CommandRegistry.register('orchestrate', 'Orchestrator', 'Enter orchestrator mode');
    CommandRegistry.register('spawn', 'Subagent', 'Quick-spawn a subagent');

    await this.initializeCompanionSystem(backendOnly);

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

  handleThemeChanged(payload: ThemePayload, mainWindow: BrowserWindow | null, isWin: boolean): void {
    let bg: string;
    let fg: string;
    if (typeof payload === 'string') {
      bg = payload === 'light' ? '#ffffff' : '#1a1b1e';
      fg = payload === 'light' ? '#1a1b1e' : '#ffffff';
    } else {
      bg = payload.bgColor ?? (payload.resolved === 'light' ? '#ffffff' : '#1a1b1e');
      fg = payload.fgColor ?? (payload.resolved === 'light' ? '#1a1b1e' : '#ffffff');
    }
    if (mainWindow) {
      mainWindow.setBackgroundColor(bg);
      if (isWin) {
        mainWindow.setTitleBarOverlay({ color: bg, symbolColor: fg });
      }
    }
  }

  async beforeQuit(): Promise<void> {
    try {
      await this.desktopService?.stopAll();
    } catch {
      // Best effort — don't block quit if Docker is unresponsive
    }
  }

  dispose(): void {
    this.sessionManager?.disposeAll();
    this.mcpManager?.disposeAll();
    this.ollamaService?.dispose();
    this.devService?.dispose();
    this.terminalService?.disposeAll();
    this.promptLibrary?.dispose();
    void this.companionServer?.stop();
    this.companionDiscovery?.stop();
    this.companionRemote?.dispose();
    companionBridge.shutdown();
  }

  private async initializeCompanionSystem(backendOnly: boolean): Promise<void> {
    this.companionAuth = new CompanionAuth(PILOT_APP_DIR);
    this.companionAuth.init().catch(err => {
      console.error('Failed to initialize companion auth:', err);
    });
    this.companionDiscovery = new CompanionDiscovery();
    this.companionRemote = new CompanionRemote();

    const companionSettings = getEffectiveCompanionSettings();

    try {
      if (companionSettings.protocol === 'https') {
        const { cert, key } = await ensureTLSCert(PILOT_APP_DIR);
        this.companionServer = new CompanionServer({
          port: companionSettings.port,
          protocol: 'https',
          tlsCert: cert,
          tlsKey: key,
          ipcBridge: companionBridge,
          auth: this.companionAuth,
        });
      } else {
        this.companionServer = new CompanionServer({
          port: companionSettings.port,
          protocol: 'http',
          ipcBridge: companionBridge,
          auth: this.companionAuth,
        });
      }

      const shouldAutoStartCompanion = companionSettings.autoStart || backendOnly;
      if (shouldAutoStartCompanion && this.companionServer) {
        try {
          await this.companionServer.start();
          const computerName = await CompanionDiscovery.getComputerName();
          await this.companionDiscovery.start(this.companionServer.port, computerName);
          console.log('[Companion] Auto-started companion server');
        } catch (autoErr) {
          console.error('[Companion] Failed to auto-start companion server:', autoErr);
          if (backendOnly) {
            throw autoErr;
          }
        }
      }
    } catch (err) {
      console.error('Failed to initialize companion server:', err);
      if (backendOnly) {
        throw err;
      }
    }

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
