// Generic headless dump-dom runner: node tools/dump-page.cjs tools/stage-probe.html [virtualTimeMs]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const page = process.argv[2] || 'tools/stage-probe.html';
const budget = process.argv[3] || 60000;
const PORT = 8974;
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const file = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const HOME = 'C:/noxe-dump-page';
fs.rmSync(HOME, { recursive: true, force: true });
for (const d of ['/LocalAppData', '/AppData', '/tmp']) fs.mkdirSync(HOME + d, { recursive: true });
const env = { ...process.env, USERPROFILE: HOME, LOCALAPPDATA: HOME + '/LocalAppData', APPDATA: HOME + '/AppData', TEMP: HOME + '/tmp', TMP: HOME + '/tmp' };

server.listen(PORT, () => {
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${HOME}/profile`, '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    '--virtual-time-budget=' + budget,
    '--dump-dom', `http://127.0.0.1:${PORT}/${page}`,
  ], { env });
  let out = '', err = '';
  chrome.stdout.on('data', (d) => (out += d));
  chrome.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => { try { chrome.kill(); } catch {} finish('timeout'); }, 120000);
  function finish(tag) {
    clearTimeout(timer);
    const m = out.match(/<pre id="log">([\s\S]*?)<\/pre>/);
    console.log(m ? m[1] : tag + ' — no log element. DOM head: ' + out.slice(0, 300));
    if (!m && err) console.log('stderr:', err.split(/\r?\n/).filter(Boolean).slice(-5).join(' | '));
    fs.rmSync(HOME, { recursive: true, force: true });
    server.close();
  }
  chrome.on('exit', () => finish('exit'));
});
