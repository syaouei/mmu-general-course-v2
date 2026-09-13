// 內部連結與資源檢查（規格第十一節的 CI 項目之一）。
//
//   node scripts/check-links.mjs
//
// 純靜態站最常見的上線事故是「本機有這個檔、部署後 404」——
// 大小寫不符、路徑打錯、或某個模組被刪了卻還有人 import。
// 這支把三件事擋在 CI：
//   1. index.html 引用的每個本機資源都存在
//   2. 每個 ES module 的 import 路徑都解析得到
//   3. 每個路由指向的 view 檔案都存在

import { readFile, access } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, dirname, basename, resolve, relative } from 'node:path';

const errors = [];
const err = (...m) => errors.push(m.join(' '));

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/**
 * 大小寫敏感的存在檢查。
 * Windows 與 macOS 的檔案系統預設不分大小寫，GitHub Pages 的 Linux 分。
 * 只用 access() 的話，`css/Base.css` 在本機會過、上線就 404。
 */
async function existsExact(path) {
  if (!await exists(path)) return false;
  // 用 basename 而不是自己切字串：根目錄檔案的 dirname 是 "."，
  // 按長度去切會把檔名前兩個字元也吃掉。
  const dir = dirname(path);
  const name = basename(path);
  try {
    const entries = await readdir(dir);
    return entries.includes(name);
  } catch { return false; }
}

// ------------------------------------------------- 1. index.html 的資源

const html = await readFile('index.html', 'utf8');

for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const url = m[1];
  if (/^(https?:|#|mailto:|data:)/.test(url)) continue;
  const path = url.replace(/^\.?\//, '');
  if (!await existsExact(path)) err(`index.html 引用了不存在的檔案：${url}`);
}

// 404.html 也要在，不然 GitHub Pages 的深層連結會壞掉
if (!await existsExact('404.html')) err('缺少 404.html —— 分享出去的深層連結會失效');
if (!await existsExact('robots.txt')) err('缺少 robots.txt');

// -------------------------------------------------- 2. ES module 的 import

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const jsFiles = [...await walk('js'), ...await walk('scripts'), ...await walk('test')];

for (const file of jsFiles) {
  const src = await readFile(file, 'utf8');
  // 靜態 import 與動態 import() 都要檢查
  const specs = [
    ...[...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;        // node: 內建模組不檢查
    const target = resolve(dirname(file), spec);
    const rel = relative(process.cwd(), target).replace(/\\/g, '/');
    if (!await existsExact(rel)) {
      err(`${file.replace(/\\/g, '/')} import 了不存在的模組：${spec}`);
    }
  }
}

// --------------------------------------------------- 3. 路由對應的 view

const main = await readFile('js/main.js', 'utf8');
const routed = [...main.matchAll(/import\(['"]\.\/views\/([^'"]+)['"]\)/g)].map((m) => m[1]);
for (const v of routed) {
  if (!await existsExact(`js/views/${v}`)) err(`路由指向不存在的 view：js/views/${v}`);
}
if (!routed.length) err('js/main.js 裡找不到任何路由 —— 正則可能該更新了');

// ------------------------------------------- 4. 資料檔引用的 domain 一致

const data = JSON.parse(await readFile('data/courses.json', 'utf8'));
const cssFiles = ['css/tokens.css', 'css/base.css', 'css/components.css'];
const css = (await Promise.all(cssFiles.map((f) => readFile(f, 'utf8')))).join('\n');

for (const d of data.domains) {
  // 每個領域都要有對應的 .d-xxx 樣式類別，不然那個領域的顏色會是預設值
  if (!css.includes(`.d-${d.id}`)) {
    err(`領域 ${d.id}（${d.name}）在 CSS 裡沒有對應的 .d-${d.id} 類別`);
  }
}

// --------------------------------------------------------------------- 輸出

console.log(`檢查 ${jsFiles.length} 個 JS 檔、${routed.length} 條路由、${data.domains.length} 個領域`);
if (errors.length) {
  console.error(`\n✗ ${errors.length} 個問題：`);
  for (const e of errors) console.error('  ', e);
  process.exitCode = 1;
} else {
  console.log('✅ 全部通過');
}
