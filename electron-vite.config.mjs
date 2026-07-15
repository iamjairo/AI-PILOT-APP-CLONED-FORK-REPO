import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

let gitSha = '';
try {
  gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {}

// Fix Rollup's _interopNamespaceDefault crashing on CJS modules with inherited props
// (e.g. `ws` inherits EventEmitter keys that have no own property descriptors)
function fixInteropPlugin() {
  return {
    name: 'fix-interop-namespace',
    generateBundle(_, bundle) {
      // Make getOwnPropertyDescriptor null-safe in the interop helper
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.code && file.code.includes('_interopNamespaceDefault')) {
          file.code = file.code.replace(
            /const (\w+) = Object\.getOwnPropertyDescriptor\((\w+), (\w+)\);\n(\s*)Object\.defineProperty/g,
            'const $1 = Object.getOwnPropertyDescriptor($2, $3);\n$4if (!$1) continue;\n$4Object.defineProperty'
          );
        }
      }
    }
  };
}

// Plugin to copy WASM files needed by bundled dependencies
function copyWasmPlugin() {
  return {
    name: 'copy-wasm',
    closeBundle() {
      const wasmSrc = path.resolve(__dirname, 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm');
      const wasmDest = path.resolve(__dirname, 'out/main/photon_rs_bg.wasm');
      try {
        if (fs.existsSync(wasmSrc)) {
          fs.mkdirSync(path.dirname(wasmDest), { recursive: true });
          fs.copyFileSync(wasmSrc, wasmDest);
        } else {
          console.warn('[copy-wasm] photon WASM not found, skipping:', wasmSrc);
        }
      } catch (err) {
        console.warn('[copy-wasm] Failed to copy WASM:', err.message);
      }
    }
  };
}

// Debug-only: connect the renderer to the standalone react-devtools (`npx react-devtools`).
// Injects the 8097 agent script BEFORE the app bundle (so it hooks React before
// react-dom loads) and adds localhost:8097 to script-src. Opt-in twice over:
// only in dev serve mode AND only when PILOT_DEVTOOLS=1 (use `npm run dev:debug`).
// Production builds and normal `npm run dev` are untouched.
function reactDevtoolsStandalonePlugin() {
  return {
    name: 'react-devtools-standalone',
    apply: (_, { command }) => command === 'serve' && process.env.PILOT_DEVTOOLS === '1',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return {
          html: html.replace("script-src 'self'", "script-src 'self' http://localhost:8097"),
          tags: [
            {
              tag: 'script',
              attrs: { src: 'http://localhost:8097' },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // The @earendil-works/pi-* packages are ESM-only (exports has no
        // `require`/`default` condition), so they must be BUNDLED into the CJS
        // main output rather than externalized (which would `require()` them and
        // throw ERR_PACKAGE_PATH_NOT_EXPORTED at runtime). Their transitive deps
        // are all CJS or dual, so they can stay external.
        exclude: [
          '@earendil-works/pi-coding-agent',
          '@earendil-works/pi-agent-core',
          '@earendil-works/pi-ai',
          '@earendil-works/pi-tui',
          // Bundled too: the pi packages import these via subpaths that the
          // packages' own `exports` maps don't expose (would throw
          // ERR_PACKAGE_PATH_NOT_EXPORTED if externalized/required at runtime).
          'highlight.js',
        ]
      }),
      fixInteropPlugin(),
      copyWasmPlugin(),
    ],
    build: {
      lib: {
        entry: path.resolve(__dirname, 'electron/main/index.ts')
      },
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate', '@homebridge/ciao', 'ws']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: path.resolve(__dirname, 'electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: path.resolve(__dirname, 'src'),
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, 'src/index.html')
      }
    },
    plugins: [react(), tailwindcss(), reactDevtoolsStandalonePlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __GIT_SHA__: JSON.stringify(gitSha),
    }
  }
});
