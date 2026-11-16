// Minimal static file server for headless checks (no external dependencies).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  const suffix = decodeURIComponent(req.url.split('?')[0]);
  const file = join(root, suffix === '/' ? 'index.html' : normalize(suffix));
  const inside = relative(root, file) === '' || !relative(root, file).startsWith('..' + sep);
  if (!inside) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
server.listen(4199, '127.0.0.1', () => console.log('test server on http://127.0.0.1:4199'));
