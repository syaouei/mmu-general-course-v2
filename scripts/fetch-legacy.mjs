// 一次性：把舊站抓成快照放進 legacy/，供 migrate-legacy.mjs 解析與日後追溯。
// 只用 Node 內建模組。重跑會覆寫，不會產生重複。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const REPO = 'haoyu050735/MMCGeneralCourse';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const OUT = 'legacy';

const tree = await (await fetch(
  `https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`
)).json();

if (!tree.tree) throw new Error('無法取得 repo 檔案清單：' + JSON.stringify(tree).slice(0, 200));

// 抓：課程頁、領域頁、首頁與說明頁、course.js、樣式。不抓圖片。
const wanted = tree.tree
  .map((n) => n.path)
  .filter((p) =>
    /^n0\d_[a-z]+\/[a-h]\d\d\.html$/.test(p) ||
    /^0[1-8]_[a-z]+\.html$/.test(p) ||
    /^(index|guide|contribution|contact_us)\.html$/.test(p) ||
    /\.(js|css)$/.test(p)
  )
  .sort();

let ok = 0;
const failed = [];
for (const p of wanted) {
  try {
    const res = await fetch(RAW + p);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = Buffer.from(await res.arrayBuffer());
    const dest = join(OUT, p);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
    ok++;
  } catch (err) {
    failed.push([p, err.message]);
  }
}

console.log(`snapshot: ${ok}/${wanted.length} 檔`);
if (failed.length) {
  console.log('失敗：');
  for (const [p, m] of failed) console.log('  ', p, m);
  process.exitCode = 1;
}
