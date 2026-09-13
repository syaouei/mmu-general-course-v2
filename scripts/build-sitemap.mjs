// 產生 sitemap.xml（規格第九節）。
//
//   node scripts/build-sitemap.mjs [--base https://user.github.io/repo]
//
// 舊站的 sitemap 只有 2 個 URL —— 九十幾門課全部沒有被收錄。
// 這支把每一門課都列進去。
//
// hash 網址（#/c/xxx）能不能被搜尋引擎收錄，取決於爬蟲有沒有執行 JS。
// Googlebot 會執行，但 fragment 通常不會被當成獨立頁面。所以這份 sitemap
// 的實際價值在於「讓爬蟲知道這些網址存在並去抓」，而不是保證每一門課
// 都會變成一筆搜尋結果。這一點不誇大，寫在下面的註解裡。

import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const baseArg = args[args.indexOf('--base') + 1];
const BASE = (args.includes('--base') ? baseArg : null)
  ?? process.env.SITE_BASE
  ?? 'https://example.github.io/mmc-general-course-v2';

const base = BASE.replace(/\/+$/, '');

const data = JSON.parse(await readFile('data/courses.json', 'utf8'));

/** XML 特殊字元。課名裡出現 & 的話，不跳脫會讓整份 sitemap 解析失敗。 */
const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const lastmod = (data.meta?.updatedAt ?? new Date().toISOString()).slice(0, 10);

const urls = [
  { loc: `${base}/`, priority: '1.0', changefreq: 'daily' },
  { loc: `${base}/#/guide`, priority: '0.5', changefreq: 'monthly' },
  { loc: `${base}/#/about`, priority: '0.5', changefreq: 'monthly' },
];

for (const d of data.domains) {
  urls.push({ loc: `${base}/#/d/${encodeURIComponent(d.id)}`, priority: '0.8', changefreq: 'weekly' });
}

// 每一門課一筆。這是與舊站最大的差別。
for (const c of data.courses) {
  urls.push({
    loc: `${base}/#/c/${encodeURIComponent(c.id)}`,
    priority: c.reviews.some((r) => !r.hidden) ? '0.7' : '0.3',
    changefreq: 'weekly',
  });
}

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map((u) => [
    '  <url>',
    `    <loc>${esc(u.loc)}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    `    <changefreq>${u.changefreq}</changefreq>`,
    `    <priority>${u.priority}</priority>`,
    '  </url>',
  ].join('\n')),
  '</urlset>',
  '',
].join('\n');

await writeFile('sitemap.xml', xml, 'utf8');

// robots.txt 裡的 Sitemap 行要跟著 base 走，不然指到不存在的網域。
try {
  const robots = await readFile('robots.txt', 'utf8');
  const next = robots.replace(/^Sitemap: .*$/m, `Sitemap: ${base}/sitemap.xml`);
  if (next !== robots) {
    await writeFile('robots.txt', next, 'utf8');
    console.log('robots.txt 的 Sitemap 行已更新');
  }
} catch { /* 沒有 robots.txt 就算了 */ }

console.log(`sitemap.xml：${urls.length} 個 URL（${data.courses.length} 門課）`);
console.log(`base：${base}`);
if (base.includes('example.github.io')) {
  console.log('');
  console.log('⚠️  base 還是預設值。正式產生時要帶 --base，或設定 SITE_BASE 環境變數：');
  console.log('    node scripts/build-sitemap.mjs --base https://syaouei.github.io/mmc-general-course-v2');
}
