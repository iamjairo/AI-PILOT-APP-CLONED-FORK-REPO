import express, { Express, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { join, extname, resolve, normalize, relative } from 'path';
import { existsSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { CompanionAuth } from './companion-server-types';
import packageJson from '../../package.json';

/** Constant-time string comparison (avoids leaking length/timing on the token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

let warnedNoAdminToken = false;

/**
 * Guards the backend-admin surface (status / generate-pin / the Synology page),
 * which can otherwise hand an anonymous caller the pairing PIN -> a full companion
 * token -> shell + file access.
 *
 *  - If PILOT_ADMIN_TOKEN is set: require it via `x-admin-token` header or `?token=`.
 *  - If it is NOT set: allow ONLY loopback connections (the NAS host / an SSH tunnel),
 *    so an un-configured, publicly/proxy-exposed backend is not wide open.
 */
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const expected = (process.env.PILOT_ADMIN_TOKEN || '').trim();
  if (expected.length > 0) {
    const provided = (req.get('x-admin-token') || (req.query.token as string) || '').toString().trim();
    if (provided.length > 0 && safeEqual(provided, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // No token configured -> loopback only. Use the raw socket address, not req.ip
  // (req.ip can be spoofed via X-Forwarded-For behind a proxy).
  const remote = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const isLoopback = remote === '127.0.0.1' || remote === '::1';
  if (isLoopback) {
    next();
    return;
  }
  if (!warnedNoAdminToken) {
    warnedNoAdminToken = true;
    console.warn(
      '[companion] backend-admin reached from a non-loopback address with no PILOT_ADMIN_TOKEN set — blocking. ' +
        'Set PILOT_ADMIN_TOKEN to enable remote admin access.'
    );
  }
  res.status(403).json({
    error: 'Admin access is restricted to localhost. Set PILOT_ADMIN_TOKEN to enable remote admin.',
  });
}

function getAdminStatus(config: {
  port: number;
  protocol: 'http' | 'https';
  auth: CompanionAuth;
}) {
  const activePairing = config.auth.getActivePairing();
  const now = Date.now();
  return {
    ok: true,
    service: 'pilot-backend',
    appVersion: packageJson.version,
    protocol: config.protocol,
    port: config.port,
    pairedDeviceCount: config.auth.getDevices().length,
    activePairing: activePairing
      ? {
          pin: activePairing.pin,
          expiresAt: activePairing.expiresAt,
          secondsRemaining: Math.max(0, Math.ceil((activePairing.expiresAt - now) / 1000)),
        }
      : null,
  };
}

function renderSynologyAdminPage(
  config: {
    port: number;
    protocol: 'http' | 'https';
  },
  adminToken = ''
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pilot Backend Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #1d1e22;
        --panel: #2b2d33;
        --panel-border: #3b3e46;
        --text: #f1f1f3;
        --muted: #b3b6bf;
        --accent: #55c2ff;
        --accent-hover: #72ccff;
        --success: #67d17a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      .wrap {
        max-width: 860px;
        margin: 0 auto;
        padding: 48px 20px 64px;
      }
      .hero {
        text-align: center;
        margin-bottom: 28px;
      }
      .hero .emoji {
        font-size: 40px;
        margin-bottom: 12px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 44px;
        line-height: 1.1;
      }
      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 18px;
      }
      .grid {
        display: grid;
        gap: 18px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 20px;
        padding: 22px;
      }
      .card h2 {
        margin: 0 0 14px;
        font-size: 22px;
      }
      .meta {
        display: grid;
        grid-template-columns: 180px 1fr;
        gap: 10px 14px;
        margin: 0;
      }
      .meta dt {
        color: var(--muted);
      }
      .meta dd {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        word-break: break-word;
      }
      .pin-row {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .pin-box {
        min-width: 200px;
        padding: 14px 18px;
        border-radius: 16px;
        background: #17181c;
        border: 1px solid var(--panel-border);
        font-size: 34px;
        letter-spacing: 0.35em;
        text-align: center;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      button, a.button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 42px;
        padding: 0 16px;
        border-radius: 12px;
        border: 0;
        background: var(--accent);
        color: #082334;
        font-weight: 700;
        text-decoration: none;
        cursor: pointer;
      }
      button:hover, a.button:hover {
        background: var(--accent-hover);
      }
      .muted {
        color: var(--muted);
      }
      .success {
        color: var(--success);
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 14px;
      }
      .help {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .hidden {
        display: none;
      }
      @media (max-width: 700px) {
        h1 { font-size: 34px; }
        .meta { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <header class="hero">
        <div class="emoji">🧑‍✈️</div>
        <h1>Pilot Backend Admin</h1>
        <p class="subtitle">Use this Synology page to generate a pairing PIN for Pilot Desktop.</p>
      </header>

      <section class="grid">
        <article class="card">
          <h2>Backend status</h2>
          <dl class="meta">
            <dt>Service</dt>
            <dd class="success">Running</dd>
            <dt>Version</dt>
            <dd id="version">-</dd>
            <dt>Protocol</dt>
            <dd id="protocol">-</dd>
            <dt>Port</dt>
            <dd id="port">-</dd>
            <dt>Paired devices</dt>
            <dd id="devices">-</dd>
            <dt>Desktop backend URL</dt>
            <dd id="backend-url">-</dd>
          </dl>
        </article>

        <article class="card">
          <h2>Generate pairing PIN</h2>
          <div class="pin-row">
            <div class="pin-box" id="pin">------</div>
            <button id="generate-pin">Generate PIN</button>
          </div>
          <p class="help" style="margin-top: 12px;">
            Enter this PIN in the Pilot Desktop pairing screen. The PIN is valid for 30 seconds.
          </p>
          <p class="help" id="pin-status" style="margin-top: 8px;">No active PIN.</p>
        </article>

        <article class="card">
          <h2>How to pair</h2>
          <p class="help">
            1. Open Pilot Desktop on your Mac.<br />
            2. Set the remote backend URL to the value shown above.<br />
            3. Click <strong>Generate PIN</strong> here.<br />
            4. Enter the PIN in Pilot Desktop before it expires.
          </p>
          <div class="actions">
            <a class="button" href="/" target="_blank" rel="noreferrer">Open companion web UI</a>
            <a class="button" href="/api/backend-health" target="_blank" rel="noreferrer">Open health endpoint</a>
          </div>
        </article>
      </section>
    </main>

    <script>
      const pinEl = document.getElementById('pin');
      const pinStatusEl = document.getElementById('pin-status');
      const versionEl = document.getElementById('version');
      const protocolEl = document.getElementById('protocol');
      const portEl = document.getElementById('port');
      const devicesEl = document.getElementById('devices');
      const backendUrlEl = document.getElementById('backend-url');
      const generateBtn = document.getElementById('generate-pin');

      let currentExpiry = null;

      function renderStatus(status) {
        versionEl.textContent = status.appVersion;
        protocolEl.textContent = status.protocol.toUpperCase();
        portEl.textContent = String(status.port);
        devicesEl.textContent = String(status.pairedDeviceCount);
        backendUrlEl.textContent = status.protocol + '://' + window.location.hostname + ':' + status.port;

        if (status.activePairing) {
          pinEl.textContent = status.activePairing.pin.split('').join(' ');
          currentExpiry = status.activePairing.expiresAt;
          updateCountdown();
        } else {
          pinEl.textContent = '------';
          currentExpiry = null;
          pinStatusEl.textContent = 'No active PIN.';
        }
      }

      function updateCountdown() {
        if (!currentExpiry) {
          pinStatusEl.textContent = 'No active PIN.';
          return;
        }

        const secondsRemaining = Math.max(0, Math.ceil((currentExpiry - Date.now()) / 1000));
        if (secondsRemaining === 0) {
          currentExpiry = null;
          pinEl.textContent = '------';
          pinStatusEl.textContent = 'PIN expired. Generate a new one.';
          return;
        }

        pinStatusEl.textContent = 'PIN expires in ' + secondsRemaining + ' second' + (secondsRemaining === 1 ? '' : 's') + '.';
      }

      const ADMIN_TOKEN = ${JSON.stringify(adminToken)};
      function adminHeaders(extra) {
        const h = Object.assign({ Accept: 'application/json' }, extra || {});
        if (ADMIN_TOKEN) h['x-admin-token'] = ADMIN_TOKEN;
        return h;
      }

      async function fetchStatus() {
        const response = await fetch('/api/backend-admin/status', {
          headers: adminHeaders(),
        });
        if (!response.ok) {
          throw new Error('Failed to load backend status');
        }
        const status = await response.json();
        renderStatus(status);
      }

      async function generatePin() {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating…';
        try {
          const response = await fetch('/api/backend-admin/generate-pin', {
            method: 'POST',
            headers: adminHeaders(),
          });
          if (!response.ok) {
            throw new Error('Failed to generate PIN');
          }
          const status = await response.json();
          renderStatus(status);
        } catch (error) {
          pinStatusEl.textContent = error instanceof Error ? error.message : 'Failed to generate PIN.';
        } finally {
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate PIN';
        }
      }

      generateBtn.addEventListener('click', () => { void generatePin(); });
      setInterval(updateCountdown, 1000);
      setInterval(() => { void fetchStatus(); }, 10000);
      void fetchStatus();
    </script>
  </body>
</html>`;
}

/**
 * Set up all Express routes for the CompanionServer
 */
export function setupCompanionRoutes(
  app: Express,
  config: {
    port: number;
    reactBundlePath: string;
    protocol: 'http' | 'https';
    auth: CompanionAuth;
  }
): void {
  // Trust only a loopback reverse proxy (e.g. Caddy on the same host), so
  // express-rate-limit keys on the real client IP via X-Forwarded-For instead
  // of lumping every proxied request under the proxy's single IP.
  app.set('trust proxy', 'loopback');

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // max requests per client per window
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  // CORS headers - restrict to same-origin; companion clients connect via WebSocket, not CORS
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // JSON middleware for API routes
  app.use(express.json());

  const attachmentsRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // limit each IP to 60 attachment requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  // Companion mode detection endpoint
  // The renderer checks this to know it's running in companion mode
  app.get('/api/companion-mode', (_req: Request, res: Response) => {
    res.json({ companion: true });
  });

  // Companion WebSocket connection info
  // Returns the WebSocket connection details for the companion client
  app.get('/api/companion-config', (_req: Request, res: Response) => {
    res.json({
      wsPort: config.port,
      wsPath: '/',
      secure: config.protocol === 'https',
      tokenRequired: true,
    });
  });

  app.get('/api/backend-health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'pilot-backend',
      appVersion: packageJson.version,
      protocol: config.protocol,
      tokenRequired: true,
      companion: true,
    });
  });

  app.get('/api/backend-admin/status', requireAdminToken, (_req: Request, res: Response) => {
    res.json(getAdminStatus(config));
  });

  app.post('/api/backend-admin/generate-pin', requireAdminToken, (_req: Request, res: Response) => {
    config.auth.generatePIN();
    res.json(getAdminStatus(config));
  });

  app.get('/synology', requireAdminToken, (req: Request, res: Response) => {
    const token = (req.get('x-admin-token') || (req.query.token as string) || '').toString().trim();
    res.type('html').send(renderSynologyAdminPage(config, token));
  });

  // Serve attachment files (images saved by the renderer)
  // Validates the path is inside a .pilot/attachments directory.
  app.get('/api/attachments', attachmentsRateLimiter, (req: Request, res: Response) => {
    const filePath = req.query.path as string | undefined;
    if (!filePath) {
    res.status(403).json({ error: 'Forbidden' });
    return;
    }

    // Resolve against a trusted attachments root and enforce containment.
    const attachmentsRoot = resolve(process.env.HOME || '', '.pilot', 'attachments');
    const normalizedPath = normalize(resolve(attachmentsRoot, filePath));
    const rel = relative(attachmentsRoot, normalizedPath);
    if (rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) {
    res.status(403).json({ error: 'Forbidden' });
    return;
    }

    // Only allow image extensions
    const ext = extname(normalizedPath).toLowerCase();
    const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (!allowedExtensions.includes(ext)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
    }

    // Verify file exists
    if (!existsSync(normalizedPath)) {
    res.status(404).json({ error: 'Not found' });
    return;
    }

    // Serve the file with proper content type
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.sendFile(normalizedPath);
  });

  // Serve static files from the React bundle directory
  const staticPath = config.reactBundlePath;
  app.use(express.static(staticPath));

  // Pairing endpoint — mobile app submits PIN/QR token here to get a session token
  app.post('/api/companion-pair', async (req: Request, res: Response) => {
    const { credential, deviceName } = req.body || {};
    if (!credential || !deviceName) {
      res.status(400).json({ error: 'Missing credential or deviceName' });
      return;
    }
    try {
      const token = await config.auth.pair(credential, deviceName);
      if (!token) {
        res.status(401).json({ error: 'Invalid or expired credential' });
        return;
      }
      // Return token + WS URL so the client can connect
      const wsProto = config.protocol === 'https' ? 'wss' : 'ws';
      res.json({ token, wsUrl: `${wsProto}://${req.hostname}:${config.port}/` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // SPA fallback - all other routes return index.html
  // Injects companion connection params into the HTML as a <script> tag
  // so the WebSocket IPC client can bootstrap without manual configuration.
  app.get('/{*path}', (req: Request, res: Response, next: NextFunction) => {
    // Skip API routes
    if (req.path.startsWith('/api/')) {
      return next();
    }

    const indexPath = join(staticPath, 'index.html');
    
    if (!existsSync(indexPath)) {
      res.status(404).send('Renderer bundle not found. Build the app first.');
      return;
    }

    // Serve the HTML as-is. The renderer's initCompanionPolyfill() detects
    // companion mode (no window.api from preload) and derives the WS URL
    // from location.hostname:port. No inline script injection needed.
    res.sendFile(indexPath);
  });
}
