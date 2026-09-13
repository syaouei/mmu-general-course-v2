// 產生自帶的拉丁字型子集（規格第八節）。
//
//   node scripts/subset-fonts.mjs
//
// 產出 assets/fonts/*.woff2 與 css/fonts.css，兩支字型合計不得超過 60KB。
//
// ─────────────────────────────────────────────────────────────────────────
// 這支腳本「不是」真正的字型子集化工具，要講清楚
// ─────────────────────────────────────────────────────────────────────────
//
// 真的做 glyph 級子集化要解析 glyf / loca / cmap / hmtx 等表、重建索引、
// 再做 WOFF2 的 Brotli 壓縮。那是幾千行、而且寫錯會產生看起來正常但在
// 某些字上壞掉的字型檔。這個專案的規則是「優先只用內建模組」，硬寫一個
// 半吊子的子集化器風險遠大於收益。
//
// 改用的做法：Google Fonts 的 CSS2 API 本來就會把字型切成 latin、
// latin-ext、cyrillic 等子集，各自帶 unicode-range。我們只下載 latin
// 那一塊 —— 它涵蓋 U+0020-007E 而且已經是子集化過的 woff2。
//
// 代價：字集比規格寫的 U+0020-007E 略大（含少數附加符號），換來的是
// 不必自己維護一個字型二進位處理器。實測體積仍在預算內，見最後的檢查。
//
// 這是建置期腳本。執行期完全不碰網路 —— 字型檔進版控，跟著網站一起發布。

import { writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = 'assets/fonts';
const OUT_CSS = 'css/fonts.css';
const BUDGET = 60 * 1024;

// 規格第八節指定的兩支：課號與 UI 數字用 Archivo，表格與量表的數字用 IBM Plex Mono。
//
// Archivo 用 `wght@400..700` 的可變字重語法 —— 一個檔案涵蓋整個字重範圍。
// 寫成 `wght@400;600;700` 的話 Google 會回三份各自獨立的靜態實例，三個
// 都是 34KB，光 Archivo 就吃掉 102KB、超出預算一倍。
//
// IBM Plex Mono 沒有可變版本，而它只用在表格與量表的數字上，那些地方不會
// 出現粗體，所以只帶 400。
const FAMILIES = [
  { name: 'Archivo', query: 'Archivo:wght@400..700', varName: 'archivo' },
  { name: 'IBM Plex Mono', query: 'IBM+Plex+Mono:wght@400', varName: 'plex-mono' },
];

// 不帶這個 UA 的話 Google 會回 ttf；帶了才拿得到 woff2。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** latin 子集的 unicode-range 必開頭於 U+0000-00FF。用它認出要哪一塊。 */
const isLatin = (range) => /U\+0000-00FF/i.test(range);

async function fetchCss(query) {
  const url = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Google Fonts 回 HTTP ${res.status}：${url}`);
  return res.text();
}

/** 從 CSS 抽出每個 @font-face 的 { weight, style, range, url }。 */
function parseFaces(css) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const block = m[1];
    const grab = (re) => (block.match(re) ?? [])[1] ?? '';
    faces.push({
      weight: grab(/font-weight:\s*([^;]+);/).trim(),
      style: grab(/font-style:\s*([^;]+);/).trim(),
      range: grab(/unicode-range:\s*([^;]+);/).trim(),
      url: grab(/src:\s*url\(([^)]+)\)/).trim(),
    });
  }
  return faces;
}

await mkdir(OUT_DIR, { recursive: true });

const cssRules = [];
let total = 0;
const report = [];

for (const family of FAMILIES) {
  const css = await fetchCss(family.query);
  const faces = parseFaces(css).filter((f) => isLatin(f.range) && f.url);

  if (!faces.length) {
    throw new Error(`${family.name}：找不到 latin 子集。Google Fonts 的回應格式可能變了。`);
  }

  for (const face of faces) {
    const res = await fetch(face.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`下載 ${family.name} ${face.weight} 失敗：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // 可變字重的 font-weight 是 "400 700"（中間有空格），直接拿來當檔名
    // 會產生含空格的網址，在部分靜態主機上會 404。
    const slug = face.weight.replace(/\s+/g, '-');
    const file = `${family.varName}-${slug}.woff2`;
    await writeFile(join(OUT_DIR, file), buf);
    total += buf.length;
    report.push({ family: family.name, weight: face.weight, bytes: buf.length, file });

    cssRules.push(
      '@font-face {',
      `  font-family: "${family.name}";`,
      `  font-style: ${face.style};`,
      `  font-weight: ${face.weight};`,
      // swap：字型還沒到之前先用系統字顯示，不要讓文字空白。
      '  font-display: swap;',
      `  src: url("../${OUT_DIR}/${file}") format("woff2");`,
      `  unicode-range: ${face.range};`,
      '}',
      '',
    );
  }
}

const header = [
  '/* 自動產生，請勿手動編輯 —— 改 scripts/subset-fonts.mjs 後重跑。',
  ' *',
  ' * 只涵蓋拉丁字母與數字。中文一律走系統字（見 tokens.css 的 --sans / --serif）：',
  ' * 思源黑體全集數 MB，為了中文自帶 webfont 不值得。',
  ' *',
  ' * unicode-range 讓瀏覽器只在頁面真的出現拉丁字元時才下載這些檔案。',
  ' */',
  '',
];

await writeFile(OUT_CSS, header.concat(cssRules).join('\n'), 'utf8');

// --------------------------------------------------------------------- 報告

console.log('產出：');
for (const r of report) {
  console.log(`  ${r.file.padEnd(26)} ${(r.bytes / 1024).toFixed(1).padStart(6)}KB  ${r.family} ${r.weight}`);
}
console.log('');
console.log(`合計 ${(total / 1024).toFixed(1)}KB ／ 預算 ${(BUDGET / 1024).toFixed(0)}KB`);

if (total > BUDGET) {
  console.error('');
  console.error(`✗ 超出預算 ${((total - BUDGET) / 1024).toFixed(1)}KB。`);
  console.error('  減少字重數量是最快的辦法 —— 每個字重都是一個獨立的檔案。');
  process.exitCode = 1;
} else {
  console.log(`✅ 在預算內，還剩 ${((BUDGET - total) / 1024).toFixed(1)}KB`);
  console.log('');
  console.log(`記得把 ${OUT_CSS} 加進 index.html，放在 tokens.css 之前。`);
}
