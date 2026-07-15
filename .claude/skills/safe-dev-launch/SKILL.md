---
name: safe-dev-launch
description: Launch or restart the AI-Pilot Electron dev app WITHOUT stacking instances or exhausting host memory. Use whenever running `npm run dev` / `dev:debug`, or when the user asks to "open/run/relaunch the app".
---

# Safe dev launch

Electron dev is heavy (Monaco workers, Vite, the Electron runtime). Stacking
instances once caused system memory pressure that killed the user's other apps
(Outlook). Follow this every time.

## Before launching
1. Kill any prior instance first — never run two:
   ```bash
   pkill -f "electron-vite dev" 2>/dev/null; sleep 2
   ```
2. Confirm none survive + memory is healthy:
   ```bash
   ps aux | grep -iE "electron-vite|AI-PILOT-APP-CLONED-FORK" | grep -v grep | wc -l   # want 0
   ```

## Launch
- Normal: `npm run dev` (background). No DevTools, no react-devtools.
- Debug only when asked: `npm run dev:debug` (sets `PILOT_DEVTOOLS=1` → Electron DevTools + the localhost:8097 react-devtools bridge). react-devtools runs a SECOND Electron — heavy. Don't use by default.
- Only launch when the user explicitly asks. Prefer `npm run build` for verification (transient, far lighter than a live server).

## After
- When done, or before switching tasks, stop it: `pkill -f "electron-vite dev"`.
- If the user reports the host is slow / apps crashing, check for orphans + `memory_pressure` and kill strays immediately.
