import { app, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions, Tray, nativeImage, net, protocol, shell, screen } from 'electron';
import { join } from 'path';
import { initLogger, getLogger, shutdownLogger } from '../services/logger';
import { loadAppSettings } from '../services/app-settings';
import { IPC } from '../../shared/ipc';
import { BackendRuntime } from '../services/backend-runtime';
import { registerSettingsIpc } from '../ipc/settings';
import { registerShellIpc } from '../ipc/shell';
import { registerThemeIpc } from '../ipc/theme';
import { registerEditorStoreIpc } from '../ipc/editor-store';
import { registerDocsIpc } from '../ipc/docs';
import { registerChatExporterIpc } from '../ipc/chat-exporter';
import { isBackendOnlyMode, resolveRemoteBackendUrl } from '../utils/runtime-mode';
import { shouldTrustRemoteBackendCertificate } from '../utils/remote-backend-cert';

let mainWindow: BrowserWindow | null = null;
// Module-scope ref — if the Tray is garbage-collected the menu-bar icon disappears.
let tray: Tray | null = null;
const backendRuntime = new BackendRuntime();
let developerModeEnabled = false;
const backendOnlyMode = isBackendOnlyMode();
const remoteBackendUrl = resolveRemoteBackendUrl(process.argv, process.env, loadAppSettings().remoteBackendUrl);
const remoteClientMode = Boolean(remoteBackendUrl) && !backendOnlyMode;

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function buildApplicationMenu() {
  const template: MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Conversation',
          accelerator: isMac ? 'Cmd+N' : 'Ctrl+N',
          click: () => mainWindow?.webContents.send('menu:new-conversation'),
        },
        { type: 'separator' as const },
        {
          label: 'Open Project…',
          accelerator: isMac ? 'Cmd+Shift+N' : 'Ctrl+Shift+N',
          click: () => mainWindow?.webContents.send('menu:open-project'),
        },
        { type: 'separator' as const },
        {
          label: 'Close Tab',
          accelerator: isMac ? 'Cmd+W' : 'Ctrl+W',
          click: () => mainWindow?.webContents.send('menu:close-tab'),
        },
        ...(isMac ? [
          {
            label: 'Close Window',
            accelerator: 'Cmd+Shift+W',
            click: () => mainWindow?.close(),
          },
        ] : [
          { type: 'separator' as const },
          {
            label: 'Exit',
            accelerator: 'Alt+F4',
            click: () => app.quit(),
          },
        ]),
      ]
    },
    { role: 'editMenu' as const },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        {
          label: 'e-Editor',
          accelerator: isMac ? 'Cmd+Shift+E' : 'Ctrl+Shift+E',
          click: () => mainWindow?.webContents.send('menu:open-editor'),
        },
        {
          label: 'Chat Exporter',
          accelerator: isMac ? 'Cmd+Shift+I' : 'Ctrl+Shift+I',
          click: () => mainWindow?.webContents.send('menu:open-exporter'),
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ]
    },
    // Terminal menu (only visible in developer mode)
    ...(developerModeEnabled ? [{
      label: 'Terminal',
      submenu: [
        {
          label: 'Toggle Terminal',
          accelerator: isMac ? 'Cmd+`' : 'Ctrl+`',
          click: () => mainWindow?.webContents.send('menu:toggle-terminal'),
        },
        {
          label: 'New Terminal',
          accelerator: isMac ? 'Cmd+Shift+`' : 'Ctrl+Shift+`',
          click: () => mainWindow?.webContents.send('menu:new-terminal'),
        },
      ]
    }] : []),
    { role: 'windowMenu' as const },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: isMac ? 'Cmd+/' : 'Ctrl+/',
          click: () => mainWindow?.webContents.send('menu:keyboard-shortcuts'),
        },
        { type: 'separator' as const },
        {
          label: 'Documentation',
          click: () => mainWindow?.webContents.send('menu:documentation'),
        },
        {
          label: 'Report Issue…',
          click: () => shell.openExternal('https://github.com/nicepkg/pilot/issues'),
        },
        { type: 'separator' as const },
        {
          label: 'About AI-Pilot',
          click: () => mainWindow?.webContents.send('menu:about'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  // Read persisted theme to set correct initial window chrome (avoid flash)
  const settings = loadAppSettings();
  let windowBg: string;
  let windowFg: string;
  if (settings.theme === 'custom' && settings.customThemeSlug) {
    // Try to read the custom theme for its bg-base color
    try {
      const ts = backendRuntime.themeService;
      const ct = ts.get(settings.customThemeSlug);
      windowBg = ct?.colors['bg-base'] ?? '#1a1b1e';
      // Estimate foreground from base type
      windowFg = ct?.base === 'light' ? '#1a1b1e' : '#ffffff';
    } catch {
      windowBg = '#1a1b1e';
      windowFg = '#ffffff';
    }
  } else {
    const isLightTheme = settings.theme === 'light';
    windowBg = isLightTheme ? '#ffffff' : '#1a1b1e';
    windowFg = isLightTheme ? '#1a1b1e' : '#ffffff';
  }

  // Size to ~90% of the primary display's work area (adapts to big monitors),
  // capped so it stays sane on very large screens.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const winWidth = Math.min(2000, Math.round(workAreaSize.width * 0.9));
  const winHeight = Math.min(1300, Math.round(workAreaSize.height * 0.9));

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 900,
    minHeight: 640,
    center: true,
    ...(!isWin ? { frame: false } : {}),
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(isWin ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        color: windowBg,
        symbolColor: windowFg,
        height: 36,
      },
    } : {}),
    icon: join(__dirname, '../../resources/icon.png'),
    backgroundColor: windowBg,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  // Position traffic lights on macOS
  if (isMac) {
    mainWindow.setWindowButtonPosition({ x: 12, y: 12 });
  }

  // Load the renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    if (remoteBackendUrl) {
      rendererUrl.searchParams.set('remoteBackendUrl', remoteBackendUrl);
    }
    mainWindow.loadURL(rendererUrl.toString());
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: remoteBackendUrl ? { remoteBackendUrl } : undefined,
    });
  }

  // Show window when ready to prevent flash
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    // DevTools no longer auto-opens in dev — opt in with PILOT_DEVTOOLS=1
    // (or use the standard toggle shortcut / View menu at any time).
    if (process.env.ELECTRON_RENDERER_URL && process.env.PILOT_DEVTOOLS === '1') {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // Send maximize state changes to renderer
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Detect iframe load failures (e.g. X-Frame-Options: DENY) and notify renderer
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDesc, validatedURL, isMainFrame) => {
    if (isMainFrame) return; // Only care about sub-frames (iframes)
    mainWindow?.webContents.send(IPC.WEB_TAB_LOAD_FAILED, { url: validatedURL, errorCode });
  });

  // Build application menu
  buildApplicationMenu();
}

function configureRemoteBackendCertificateTrust(remoteUrl: string | null): void {
  if (!remoteUrl) {
    return;
  }

  app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    if (shouldTrustRemoteBackendCertificate(url, remoteUrl)) {
      event.preventDefault();
      callback(true);
      return;
    }

    callback(false);
  });
}

// Enable native Wayland support on Linux when available
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

// Single-instance lock — without it a second launch spawns a duplicate app
// that fails to bind the companion port (:18088) and throws "A JavaScript error
// occurred in the main process". Only the desktop app enforces this (the
// headless backend may run intentionally alongside).
if (!backendOnlyMode) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    });
  }
}

// Register custom protocol for serving local attachment files in the renderer.
// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  { scheme: 'pilot-attachment', privileges: { bypassCSP: true, supportFetchAPI: true } },
  { scheme: 'pilot-html', privileges: { bypassCSP: true, supportFetchAPI: true, standard: true, secure: true } },
]);

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
  // Initialize logger first
  initLogger();
  const log = getLogger('main');
  log.info('Pilot starting', {
    version: app.getVersion(),
    platform: process.platform,
    dev: !!process.env.ELECTRON_RENDERER_URL,
    mode: backendOnlyMode ? 'backend-only' : remoteClientMode ? 'remote-client' : 'desktop',
    remoteBackendUrl,
  });

  if (remoteClientMode) {
    configureRemoteBackendCertificateTrust(remoteBackendUrl);
  }

  // Handle pilot-attachment:// URLs → read local files
  protocol.handle('pilot-attachment', (request) => {
    // URL format: pilot-attachment:///absolute/path/to/file.png
    const filePath = decodeURIComponent(new URL(request.url).pathname);
    return net.fetch(`file://${filePath}`);
  });

  // Handle pilot-html:// URLs → serve local HTML and assets from project directories
  // URL format: pilot-html://localhost/<absolute-path-to-file>
  // Uses standard: true so relative asset references (CSS, JS, images) resolve correctly.
  protocol.handle('pilot-html', (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname);
    const { resolve } = require('path');
    const { existsSync } = require('fs');
    const resolved = resolve(filePath);

    if (!existsSync(resolved)) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }

    return net.fetch(`file://${resolved}`);
  });
  if (!backendOnlyMode) {
    createWindow();
  } else if (isMac && app.dock) {
    app.dock.hide();
  }

  if (!remoteClientMode) {
    await backendRuntime.start({
      mainWindow,
      docsDir: join(app.getAppPath(), 'docs', 'user'),
      backendOnly: backendOnlyMode,
    });
  } else {
    registerSettingsIpc();
    registerShellIpc();
    registerThemeIpc(backendRuntime.themeService);
    registerEditorStoreIpc();
    registerDocsIpc();
    registerChatExporterIpc(() => mainWindow);
  }

  // Window control IPC handlers
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('window:is-maximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.handle('shell:open-external', (_event, url: string) => {
    return shell.openExternal(url);
  });

  // Terminal menu visibility (driven by developer mode in renderer)
  ipcMain.on(IPC.TERMINAL_SET_MENU_VISIBLE, (event, visible: boolean) => {
    developerModeEnabled = visible;
    buildApplicationMenu();
  });

  // Theme changed — update window chrome (background, titlebar overlay)
  // Payload: { resolved: 'dark' | 'light', bgColor?: string, fgColor?: string }
  ipcMain.on(IPC.APP_THEME_CHANGED, (_event, payload: string | { resolved: string; bgColor?: string; fgColor?: string }) => {
    // Support both legacy string payload and new object payload
    backendRuntime.handleThemeChanged(payload, mainWindow, isWin);
  });

  // Set dock icon on macOS (BrowserWindow icon only applies to Windows/Linux)
  if (!backendOnlyMode && isMac && app.dock) {
    app.dock.setIcon(join(__dirname, '../../resources/icon.png'));
  }

  // Menu-bar tray (macOS): the AI-Pilot robot in full color (user's artwork,
  // tight-cropped, transparent background). Not a template image on purpose —
  // the robot keeps its colors in both light and dark menu bars. @2x is
  // picked up automatically for Retina.
  if (!backendOnlyMode && isMac) {
    const trayImage = nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'));
    if (!trayImage.isEmpty()) {
      tray = new Tray(trayImage);
      tray.setToolTip('AI-Pilot');
      const showApp = () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow();
        } else {
          mainWindow?.show();
          mainWindow?.focus();
        }
      };
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open AI-Pilot', click: showApp },
          { type: 'separator' },
          { label: 'New Conversation', click: () => { showApp(); mainWindow?.webContents.send(IPC.TRAY_NEW_CONVERSATION); } },
          { type: 'separator' },
          { label: 'Quit AI-Pilot', role: 'quit' },
        ])
      );
      tray.on('click', showApp);
    }
  }

  app.on('activate', () => {
    // On macOS it's common to re-create a window when the dock icon is clicked
    if (!backendOnlyMode && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (!backendOnlyMode && process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit — async cleanup (container stop) runs in before-quit,
// synchronous cleanup runs in will-quit.
let cleanupStarted = false;
let cleanupFinished = false;

app.on('before-quit', async (e) => {
  if (cleanupFinished) return; // Cleanup complete — let quit proceed
  e.preventDefault(); // Always prevent quit while cleanup is pending
  if (cleanupStarted) return; // Already in progress — wait for it
  cleanupStarted = true;

  // Stop Docker containers gracefully before the process exits.
  // Without this, stopAll()'s returned Promise is discarded and
  // containers are left running after the app quits.
  try {
    await backendRuntime.beforeQuit();
  } catch {}

  cleanupFinished = true;
  app.quit();
});

app.on('will-quit', () => {
  backendRuntime.dispose();
  shutdownLogger();
});
