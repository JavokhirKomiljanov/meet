// Serves the real index.html wired to a fake Apps Script endpoint that runs the real Code.gs (see gas-harness.js).
// MODE=off → page served with an empty API (fallback/Telegram mode).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load } = require('./gas-harness');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const gas = load({ verbose: true });
const log = [];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/exec') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const out = req.method === 'POST'
        ? gas.ctx.doPost({ postData: { contents: body } })
        : gas.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
      log.push({ method: req.method, ct: req.headers['content-type'], body: body.slice(0, 300), out: out.s.slice(0, 300) });
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(out.s); }, 700);
    });
    return;
  }
  if (url.pathname === '/__log') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ log, inserted: gas.inserted.map(i => ({ q: i.query, ev: i.ev })) }, null, 1)); return; }
  const file = url.pathname === '/' || url.pathname === '/off' ? 'index.html' : url.pathname.slice(1);
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  let data = fs.readFileSync(p);
  if (file === 'index.html' && url.pathname !== '/off') data = data.toString().replace("window.MEET_API = '';", `window.MEET_API = 'http://localhost:${PORT}/exec';`);
  res.writeHead(200, { 'content-type': file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' });
  res.end(data);
}).listen(PORT, () => console.log('mock on ' + PORT));
