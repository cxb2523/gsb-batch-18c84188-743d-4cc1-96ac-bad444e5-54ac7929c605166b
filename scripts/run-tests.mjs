/**
 * Bundles the TypeScript test suite with esbuild and runs it through Node's built-in
 * test runner (`node --test`).  No third-party test framework dependency is required.
 *
 * Usage: node scripts/run-tests.mjs
 */
import { glsl } from 'esbuild-plugin-glsl';
import esbuild from 'esbuild';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.test-build');
const outFile = path.join(outDir, 'tests.mjs');

await esbuild.build({
  entryPoints: [path.join(root, 'tests', 'godraysPass.sizes.test.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'info',
  plugins: [glsl({ minify: false })],
});

const child = spawn(process.execPath, ['--test', outFile], {
  stdio: 'inherit',
  cwd: root,
});

child.on('exit', async code => {
  await rm(outDir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
