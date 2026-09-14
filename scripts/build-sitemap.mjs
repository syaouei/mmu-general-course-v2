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
// 都會變成一筆搜尋結果。

import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;

// 優先序：--base 參數 → SITE_BASE 環境變數 → 由 config.json 的 repo 推算。
// 推算規則是 GitHub Pages 專案站的網址格式：https://<owner>.github.io/<repo>
const config = JSON.parse(await readFile('data/config.json', 'utf8').catch(() => '{}'));
const derived = config.repo?.owner && config.repo?.name
  ? `https://${config.repo.owner}.github.io/${config.repo.name}`
  : null;

const BASE = baseArg ?? process.env.SITE_BASE ?? derived;

/** XML 特殊字元。課名裡出現 & 的話，不跳脫會讓整份 sitemap 解析失敗。 */
const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

async function main() {
  if (!BASE) {
    console.error('不知道網站網址。請在 data/config.json 填好 repo.owner 與 repo.name，');
    console.error('或執行時帶 --base https://<帳號>.github.io/<repo>');
    process.exitCode = 1;
    return;
  }

  const base = BASE.replace(/\/+$/, '');
  const data = JSON.parse(await readFile('data/courses.json', 'utf8'));
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

  // robots.txt 裡的 Sitemap 行要跟著網址走，不然指到不存在的網域。
  try {
    const robots = await readFile('robots.txt', 'utf8');
    const next = robots.replace(/^Sitemap: .*$/m, `Sitemap: ${base}/sitemap.xml`);
    if (next !== robots) {
      await writeFile('robots.txt', next, 'utf8');
      console.log('robots.txt 的 Sitemap 行已更新');
    }
  } catch { /* 沒有 robots.txt 就算了 */ }

  console.log(`sitemap.xml：${urls.length} 個 URL（${data.courses.length} 門課）`);
  console.log(`網址：${base}/`);
}

await main();
