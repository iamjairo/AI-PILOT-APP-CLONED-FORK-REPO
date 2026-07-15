---
name: build-sign-notarize
description: Build, code-sign, and notarize the AI-Pilot macOS app (dmg/zip). Use when producing distributable macOS artifacts or wiring signing/notarization.
---

# Build, sign & notarize (macOS)

Config lives in `electron-builder.yml` (`mac.notarize: true`, hardened runtime,
`resources/entitlements.mac.plist`). Signing is **env-driven — no secrets in the
repo**. `@electron/notarize` is already a dependency.

## Secrets (never in git / never pasted in chat)
Copy `.env.signing.example` → `.env.signing` (git-ignored) and fill:
- `CSC_LINK` — base64 of the "Developer ID Application" `.p12` (`base64 -i cert.p12`)
- `CSC_KEY_PASSWORD` — the `.p12` password
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (appleid.apple.com), `APPLE_TEAM_ID`

## Signed + notarized build
```bash
set -a; source .env.signing; set +a
npm run build:mac      # electron-vite build + electron-builder --mac
```
electron-builder signs with the Developer ID cert and submits to Apple's notary
service automatically. Verify:
```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/AI-Pilot.app"
spctl -a -vvv -t install "release/mac-arm64/AI-Pilot.app"   # should say: accepted, notarized
```

## Local unsigned dev build
Without `.env.signing`, `npm run build:mac` still produces an ad-hoc/unsigned
app (Gatekeeper will warn). Fine for local testing; not for distribution.

## Notes
- Entitlements are the Electron hardened-runtime set (allow-jit,
  allow-unsigned-executable-memory, disable-library-validation) — required for
  V8 JIT + native modules (node-pty). Don't remove them.
- Windows signing uses `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (see ci.yml).
