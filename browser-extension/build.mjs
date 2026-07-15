/**
 * @file esbuild bundler for the AI-Pilot Chat Exporter extension.
 *
 * Bundles the four TS entry points from src/ into dist/ as self-contained IIFE
 * scripts (no ESM imports/exports survive — required for MV3 content scripts,
 * classic background workers and <script src> popup/options), then copies the
 * static files (manifest, HTML, icons) into dist/.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const entries = {
  content: join(root, 'src/content.ts'),
  background: join(root, 'src/background.ts'),
  popup: join(root, 'src/popup.ts'),
  options: join(root, 'src/options.ts'),
};

const results = await Promise.all(
  Object.entries(entries).map(([name, entry]) =>
    build({
      entryPoints: [entry],
      outfile: join(dist, `${name}.js`),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome110'],
      sourcemap: false,
      minify: false,
      legalComments: 'none',
      logLevel: 'info',
    }),
  ),
);

// Copy static assets into dist/.
for (const file of ['manifest.json', 'popup.html', 'options.html']) {
  cpSync(join(root, file), join(dist, file));
}
cpSync(join(root, 'icons'), join(dist, 'icons'), { recursive: true });

const warnings = results.flatMap((r) => r.warnings);
if (warnings.length) {
  console.warn(`Build finished with ${warnings.length} warning(s).`);
}
console.log('Build complete → dist/');
