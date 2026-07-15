# AI-Pilot — project guide for Claude Code

AI-Pilot is an Electron desktop coding-agent app (fork of espennilsen/pilot),
rebranded and extended. It wraps the **pi** coding-agent SDK and adds an
in-app **e-Editor**, a **Chat Exporter**, and a **Postgres**-backed archive.

## Stack
- Electron 40 + React 19 + TypeScript + Vite (electron-vite) + Zustand + Tailwind 4.
- Three processes: `electron/main` (Node), `electron/preload`, `src/` (renderer).
- Agent backend: **@earendil-works/pi-coding-agent / -pi-ai / -pi-agent-core** (ESM-only, v0.80+). NOT the deprecated `@mariozechner/pi-*`.

## Build / verify
- Typecheck (must stay 0/0): `npm run typecheck` (node + web tsconfigs).
- Build: `npm run build` (electron-vite; transpiles without typechecking).
- Dev app: `npm run dev`. Debug build (react-devtools bridge + DevTools): `npm run dev:debug` (`PILOT_DEVTOOLS=1`).

## ⚠️ Dev-launch discipline (avoid crashing the host)
Electron dev is heavy (Monaco's multi-MB workers, etc.). Stacking instances
caused system memory pressure that killed other apps once. So:
- **Never stack instances** — `pkill -f "electron-vite dev"` before relaunching.
- **Don't auto-launch** — only start the window when the user asks.
- **No react-devtools by default** — it runs a *second* Electron. Only `dev:debug`.
- Prefer `npm run build` (transient) over a live dev server for verification.

## Key gotchas
- **electron-vite externalization**: the ESM-only `@earendil-works/pi-*` packages MUST be in `externalizeDepsPlugin({ exclude: [...] })` in `electron-vite.config.mjs` (+ `highlight.js`), or they externalize and throw `ERR_PACKAGE_PATH_NOT_EXPORTED` at launch (builds green, app won't run).
- **yauzl override** (`overrides.yauzl: ^3.3.1`) fixes electron#51619 — without it the Electron binary silently fails to extract on install.
- **Native module**: `node-pty` (terminal) — `asarUnpack`ed; postinstall chmods its prebuild.

## Signing / notarization
`electron-builder.yml` `mac.notarize: true`; signing is env-driven — see
`.env.signing.example`. Secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) live in `.env.signing`
(git-ignored) or CI. Skill: `build-sign-notarize`.

## Feature map
- **e-Editor** (`src/components/editor/`): Monaco playground (HTML/CSS/JS + live blob preview), AI review panel (`completeSimple`), settings (skin/accent/font/size), Docs/Reader (URL → Readability → print A4). Grey/dark theme. Sidebar rail + View menu (⌘⇧E).
- **Chat Exporter** (`src/components/exporter/`, `electron/services/chat-capture.ts`): app-wide export module. Login-webview → session harvest → API replay (ChatGPT) / DOM scrape (others) → normalize → **Postgres `chat_archive`**. View menu (⌘⇧I) + sidebar. Exports (MD/PDF/HTML/DOCX/PNG/ZIP) also cached server-side.
- **Postgres store** (`electron/services/editor-store.ts`): `editor_store` + `chat_archive` tables, LISTEN/NOTIFY cross-device sync. Configured via `PILOT_EDITOR_PG_URL`; degrades to localStorage when absent.
- **Companion server** (`electron/services/companion-*`, `electron/standalone/`): HTTPS + WS on :18088, headless-capable → becomes the **NAS backend (.spk)**.

## Security notes / TODO
- Provider tokens are stored by the pi SDK's AuthStorage at `~/.config/pilot/auth.json` in **plaintext** — migrate to Electron `safeStorage` (Keychain-backed).
- NAS companion UI: build with WebKitGTK via the SYNO-driver runtimes (C#/GTK# `SYNO-WebviewCS`), NOT Swift (no mature Swift+WebKitGTK binding on Linux). Swift/SynologyKit is for a future *native mobile companion*, not the on-NAS SPK.

## Branding
User-visible name is **AI-Pilot** (not "Pilot"); internal ids/paths
(`dev.e9n.pilot`, `~/.config/pilot`, `pilot-html:`) stay unchanged. Icons:
glass squircle (Dock/app) + robot menu-bar tray badge. Launch greeting =
`src/components/shared/LaunchGreeting.tsx`.
