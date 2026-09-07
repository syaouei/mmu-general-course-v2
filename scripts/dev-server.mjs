// 本機開發伺服器。只用 Node 內建模組，不安裝任何東西。
//
// 為什麼需要它：規格希望「雙擊 index.html 就能跑」，但瀏覽器對 file://
// 的 ES Module 與 fetch 都套用 CORS，兩者都會被擋。上線到 GitHub Pages
// 沒有這個問題；本機開發就用這支。
//
//   node scripts/dev-server.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PORT = Number(process.argv[2] ?? 8080);
const ROOT = process.cwd();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';

  // 目錄穿越防護：正規化後必須仍在 ROOT 底下。
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const s = await stat(file);
    if (s.isDirectory()) throw new Error('is dir');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    // 走 404.html，跟 GitHub Pages 的行為一致，順便測得到 hash 保留邏輯。
    try {
      res.writeHead(404, { 'Content-Type': TYPES['.html'] });
      res.end(await readFile(join(ROOT, '404.html')));
    } catch {
      res.writeHead(404).end('Not found');
    }
  }
}).listen(PORT, () => {
  console.log(`dev server: http://localhost:${PORT}/`);
});
