import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/** content hash of public/models: a changed model gets a new browser cache (src/ner/worker.ts) */
function modelsVersion() {
  const dir = new URL('public/models', import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)).sort();
  const h = createHash('sha1');
  for (const f of files) h.update(f.slice(dir.length)).update(readFileSync(f));
  return h.digest('hex').slice(0, 12);
}

// Nothing may leave the machine: the built page is locked down by CSP.
// (Only in the build — the dev server needs inline scripts and a websocket for HMR.)
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'", // monaco sets inline styles
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// cross-origin isolation gives onnxruntime threads (src/ner/worker.ts); on GitHub Pages public/coi-sw.js adds the same headers
const COI = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig(({ command }) => ({
  base: './',
  define: { __MODELS__: JSON.stringify(command === 'build' ? modelsVersion() : 'dev') },
  server: { headers: COI },
  preview: { headers: COI },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  plugins: [
    {
      // onnxruntime-web's bundle references a 27 MB WebGPU/asyncify wasm we never load (device: 'wasm', see src/ner/worker.ts)
      name: 'drop-unused-ort-wasm',
      generateBundle(_, bundle) {
        for (const k of Object.keys(bundle)) if (/ort-wasm.*asyncify.*\.wasm$/.test(k)) delete bundle[k];
      },
    },
    {
      name: 'csp',
      apply: 'build',
      transformIndexHtml: (html) =>
        html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  ],
  test: { include: ['tests/**/*.{test,bench}.ts'] },
}));
