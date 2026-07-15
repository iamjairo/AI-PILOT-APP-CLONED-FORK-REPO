# AI-Pilot Chat Exporter (Browser Extension)

A standalone **Chrome Manifest V3** extension that exports AI chat conversations
to **Markdown / HTML / PDF / JSON / ZIP**. It re-packages the exporter built
inside the AI-Pilot Electron app and **reuses the exact scraper + render code**,
so output is byte-for-byte identical to the desktop app.

Supported services: **ChatGPT, Claude, Gemini, DeepSeek, Le Chat (Mistral), Qwen.**

---

## What's inside

```
browser-extension/
├── manifest.json          # MV3 manifest (source; copied to dist/)
├── popup.html             # popup UI markup (source; copied to dist/)
├── options.html           # options page markup (source; copied to dist/)
├── build.mjs              # esbuild bundler + static-asset copy
├── make-icons.sh          # rasterize icon.svg → PNGs (rsvg-convert / magick)
├── package.json           # local deps (jszip, turndown, esbuild, typescript)
├── tsconfig.json          # strict TS, noEmit typecheck
├── icons/
│   ├── icon.svg           # emerald download glyph, transparent
│   └── icon16/32/48/128.png
├── src/
│   ├── types.ts           # local copy of the app's chat types
│   ├── scrapers.ts        # 6 per-platform DOM scrapers (ported BACK to fns)
│   ├── adapter.ts         # scrape result → ArchivedChat + codeBlocks + service detect
│   ├── chat-export.ts     # VERBATIM copy of the app's render pipeline (+ ./types import)
│   ├── export-runner.ts   # thin wrapper adding JSON + ZIP formats
│   ├── storage.ts         # chrome.storage helpers + defaults
│   ├── content.ts         # content script: pill + message listener
│   ├── background.ts      # service worker: FETCH_IMAGE + optional NAS_SYNC
│   ├── popup.ts           # popup controller
│   └── options.ts         # options controller (NAS sync)
└── dist/                  # BUILD OUTPUT (load this in Chrome)
    ├── manifest.json
    ├── content.js background.js popup.js options.js
    ├── popup.html options.html
    └── icons/
```

## Build

```bash
npm --prefix browser-extension install
npm --prefix browser-extension run build     # typecheck (tsc --noEmit) + esbuild → dist/
```

`build` runs `tsc --noEmit` first (0 errors required) then bundles the four
entry points into self-contained IIFE scripts in `dist/`. All deps are local to
`browser-extension/node_modules` — the root project is untouched.

Regenerate icons after editing `icons/icon.svg`:

```bash
./browser-extension/make-icons.sh          # needs rsvg-convert (preferred) or ImageMagick
```

## Load in Chrome (unpacked)

1. Run the build above so `browser-extension/dist/` exists.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top-right) **on**.
4. Click **Load unpacked**.
5. Select the **`browser-extension/dist/`** folder (not the repo root).
6. Open a conversation on a supported site (ChatGPT, Claude, Gemini, DeepSeek,
   Le Chat, Qwen). A floating emerald **⤓ Export** pill appears bottom-right,
   and the toolbar popup shows the detected site + export controls.

After code changes, re-run `npm --prefix browser-extension run build` and click
the **↻ reload** icon on the extension card in `chrome://extensions`.

## Convert to Safari (macOS + Xcode)

Chrome MV3 extensions run in Safari via Apple's converter. From the repo root:

```bash
npm --prefix browser-extension run safari
# equivalent to:
xcrun safari-web-extension-converter browser-extension/dist/ \
  --app-name "AI-Pilot Chat Exporter" \
  --bundle-identifier com.iamjairo.aipilot.chatexporter
```

Notes:
- Requires **macOS with Xcode** installed (the `safari` npm script guards on
  `process.platform === 'darwin'` and otherwise exits with a clear message).
- The converter generates an Xcode project. Open it, set your **Apple Team ID**
  for signing, and build/run to install the Safari app extension.
- Enable it in **Safari → Settings → Extensions**, and allow it on the chat
  sites when prompted.
- Build `dist/` first — the converter packages whatever is in that folder.

## Export formats

| Format   | Output                                                             |
|----------|-------------------------------------------------------------------|
| Markdown | `<slug>.md` — `## User` / `## Assistant`, fenced code preserved    |
| HTML     | `<slug>.html` — standalone One-Dark styled document               |
| PDF      | Browser print dialog (hidden iframe, A4 print stylesheet)         |
| JSON     | `<slug>.json` — the raw `ArchivedChat` object                     |
| ZIP      | `<slug>.zip` — document + `scripts/` (code blocks) + `attachments/`|

Options (persisted in `chrome.storage.sync`): theme (dark/light), include code,
syntax colors (One-Dark), download scripts, download attachments. Choosing
Markdown/HTML **with** scripts or attachments also produces a ZIP (same behavior
as the desktop app's `exportChat` orchestrator).

## Optional: Sync to NAS

Open the extension **Options** page. The **Sync to NAS** section is entirely
optional and **OFF / empty by default**:

- **Enable NAS sync** toggle + a **companion endpoint URL** field
  (e.g. `https://your-nas.example:18088/api/chat-archive`). No URL is hardcoded.
- When enabled, after each export the extension **also** POSTs the raw
  `ArchivedChat` JSON to that endpoint — **fire-and-forget**, wrapped in
  `try/catch`, and it never blocks or delays your download.
- The POST is routed through the background service worker in `no-cors` mode, so
  it needs no host permission for your (user-configured) NAS origin and is not
  blocked by the chat site's Content-Security-Policy. The response is opaque and
  ignored.

## How it works

- **`content.js`** detects the service from the hostname, injects the export
  pill, and listens for `{action:'EXPORT'}` from the popup. It runs the matching
  scraper, adapts the result to an `ArchivedChat` (`model`→`assistant`,
  `htmlContent`→`html`, deriving `codeBlocks` from `<pre><code class="language-*">`),
  then runs the reused export pipeline. Downloads use the blob+anchor path;
  PDF uses the hidden-iframe `window.print()` path.
- **`background.js`** answers `FETCH_IMAGE` (fetch → base64 data URL) so
  user-uploaded images survive export past the content script's CORS/CSP limits,
  and performs the optional `NAS_SYNC` POST.
- The scrapers and `chat-export.ts` are faithful ports of the AI-Pilot Electron
  sources (`electron/services/chat-scrapers.ts`,
  `src/components/exporter/chat-export.ts`).

## Selector maintenance

The scrapers rely on each site's DOM structure and will need occasional updates
as the sites change. Each scraper has a whole-page fallback that emits a
"DOM structure may have changed" warning message rather than failing silently.
ChatGPT's `[data-message-author-role]` selector is the most likely to drift —
see the parent report for current risk notes.
```
