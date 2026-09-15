// 資料驗證（規格第十一節）。
//
//   node scripts/validate-data.mjs
//
// 在 sync.yml 裡跑在 commit 之前：寧可讓 Action 紅，也不要把壞掉的
// courses.json 推上正式站 —— 前台沒有任何防禦，資料壞了就是白畫面。
//
// 只用 Node 內建模組，不引入 JSON Schema 套件。data/schema.json 是人看的
// 契約文件，這裡是機器執行的那一份，兩邊要一起改。

import { readFile } from 'node:fs/promises';
import { courseStats, visibleReviews } from '../js/format.js';
import { CODE_RE, TERM_RE, LIMITS } from '../js/gate.js';

const errors = [];
const warnings = [];
const err = (...m) => errors.push(m.join(' '));
const warn = (...m) => warnings.push(m.join(' '));

const data = JSON.parse(await readFile('data/courses.json', 'utf8'));

// --------------------------------------------------------------------- 結構

if (!data.meta) err('缺少 meta');
if (!Array.isArray(data.domains)) err('domains 不是陣列');
if (!Array.isArray(data.courses)) err('courses 不是陣列');
if (errors.length) {
  console.error('資料結構損毀，無法繼續驗證：');
  for (const e of errors) console.error('  ✗', e);
  process.exitCode = 1;
} else {

const domainIds = new Set(data.domains.map((d) => d.id));

// 分系（系選修底下的醫學系、護理系⋯⋯）。系的 id 會進網址（?dept=med），
// 所以格式要乾淨，同一個領域裡不能重複。
const groupsOf = new Map();
for (const d of data.domains) {
  if (d.groups === undefined) continue;
  if (!Array.isArray(d.groups)) { err(`領域 ${d.id}：groups 不是陣列`); continue; }
  const ids = new Set();
  for (const g of d.groups) {
    if (!/^[a-z]+$/.test(g?.id ?? '')) err(`領域 ${d.id}：系的 id「${g?.id}」只能是小寫英文字母`);
    else if (ids.has(g.id)) err(`領域 ${d.id}：系的 id「${g.id}」重複`);
    else ids.add(g.id);
    if (typeof g?.name !== 'string' || !g.name.trim()) err(`領域 ${d.id}：系「${g?.id}」沒有名稱`);
  }
  groupsOf.set(d.id, ids);
}

// ------------------------------------------------------------------ 逐課檢查

const courseIds = new Set();
const reviewIds = new Set();

for (const c of data.courses) {
  const at = `課程 ${c.id ?? '(無 id)'}`;

  if (!c.id) err(`${at}：缺少 id`);
  else if (courseIds.has(c.id)) err(`${at}：id 重複`);
  else courseIds.add(c.id);

  if (!domainIds.has(c.domain)) err(`${at}：領域「${c.domain}」不在 domains 清單中`);

  // dept 只能出現在有分系的領域，而且要是那個領域裡的系。
  // 沒有系就不要有這個欄位（不寫 null），前台才只有一種「未分系」的判斷。
  if ('dept' in c) {
    if (!groupsOf.has(c.domain)) err(`${at}：領域「${c.domain}」沒有分系，卻標了系「${c.dept}」`);
    else if (!groupsOf.get(c.domain).has(c.dept)) err(`${at}：系「${c.dept}」不在 ${c.domain} 的 groups 裡`);
  } else if (groupsOf.has(c.domain)) {
    warn(`${at}：在有分系的領域裡但還沒標系，站上會列在「未分系」`);
  }

  // 舊站有兩門課沒有代碼，那是已知且刻意保留的，不是錯誤。
  if (c.code !== null && c.code !== undefined && !CODE_RE.test(c.code)) {
    warn(`${at}：課程代碼「${c.code}」不符 ${CODE_RE}`);
  }

  // undefined 進了 JSON 會變成欄位消失，靜默改變資料語意。
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) err(`${at}：欄位 ${k} 是 undefined`);
  }

  if (!Array.isArray(c.reviews)) { err(`${at}：reviews 不是陣列`); continue; }

  for (const r of c.reviews) {
    const rat = `心得 ${r.id ?? '(無 id)'}（${c.id}）`;

    if (!r.id) err(`${rat}：缺少 id`);
    else if (reviewIds.has(r.id)) err(`${rat}：id 重複`);
    else reviewIds.add(r.id);

    if (typeof r.text !== 'string' || !r.text.trim()) err(`${rat}：內文是空的`);
    if (!['legacy', 'form'].includes(r.source)) err(`${rat}：source「${r.source}」不合法`);
    if (typeof r.hidden !== 'boolean') err(`${rat}：hidden 不是布林值`);

    if (r.term !== null && !TERM_RE.test(String(r.term))) {
      warn(`${rat}：學期「${r.term}」不是 3–4 位數字`);
    }

    // 評分：可以是 null，但不能是 undefined，也不能超出範圍。
    // 舊站有 6 則 0 星的真實資料，所以下界放到 0 而不是規格寫的 1。
    for (const [field, lo, hi] of [
      ['stars', 0, LIMITS.starsMax],
      ['sweet', LIMITS.meterMin, LIMITS.meterMax],
      ['cool', LIMITS.meterMin, LIMITS.meterMax],
      ['grade', LIMITS.gradeMin, LIMITS.gradeMax],
    ]) {
      const v = r[field];
      if (v === undefined) { err(`${rat}：${field} 是 undefined（應為 null）`); continue; }
      if (v === null) continue;
      if (typeof v !== 'number' || Number.isNaN(v)) { err(`${rat}：${field} 不是數字：${JSON.stringify(v)}`); continue; }
      if (v < lo || v > hi) err(`${rat}：${field} = ${v} 超出 ${lo}–${hi}`);
    }
  }
}

// ------------------------------------------------- 統計不得把缺項當成 0

// 規格第三節最重要的一條，也是最容易在重構時悄悄壞掉的一條。
for (const c of data.courses) {
  const st = courseStats(c);
  for (const field of ['stars', 'sweet', 'cool', 'grade']) {
    const s = st[field];
    const anyValue = visibleReviews(c).some((r) => typeof r[field] === 'number');
    if (!anyValue && s.avg !== null) {
      err(`課程 ${c.id}：${field} 全部為 null，統計卻回傳 ${s.avg}（必須是 null）`);
    }
    if (s.n === 0 && s.avg !== null) {
      err(`課程 ${c.id}：${field} 樣本數 0，統計卻回傳 ${s.avg}`);
    }
  }
}

// -------------------------------------------- hidden 的心得不得計入統計

for (const c of data.courses) {
  const hidden = (c.reviews ?? []).filter((r) => r.hidden === true);
  if (!hidden.length) continue;
  const st = courseStats(c);
  if (st.count !== c.reviews.length - hidden.length) {
    err(`課程 ${c.id}：hidden 的心得被計入了則數`);
  }
  for (const h of hidden) {
    if (typeof h.stars === 'number') {
      const withHidden = c.reviews.filter((r) => typeof r.stars === 'number');
      const visible = visibleReviews(c).filter((r) => typeof r.stars === 'number');
      if (withHidden.length === visible.length) {
        err(`課程 ${c.id}：hidden 的心得看起來被計入了星級統計`);
      }
      break;
    }
  }
}

// --------------------------------------------------------------- meta 一致

const reviewCount = data.courses.reduce((a, c) => a + c.reviews.length, 0);
if (data.meta.courseCount !== data.courses.length) {
  err(`meta.courseCount = ${data.meta.courseCount}，實際 ${data.courses.length}`);
}
if (data.meta.reviewCount !== reviewCount) {
  err(`meta.reviewCount = ${data.meta.reviewCount}，實際 ${reviewCount}`);
}
if (!data.meta.updatedAt || Number.isNaN(Date.parse(data.meta.updatedAt))) {
  err(`meta.updatedAt 不是合法時間：${data.meta.updatedAt}`);
}

// ------------------------------------------------------------ 抑制清單一致

const suppressed = JSON.parse(
  await readFile('data/suppressed.json', 'utf8').catch(() => '{"ids":[]}')
);
for (const id of suppressed.ids ?? []) {
  if (reviewIds.has(id)) {
    err(`抑制清單裡的 ${id} 仍然出現在 courses.json —— 抑制沒有生效`);
  }
}

// --------------------------------------------------------------------- 輸出

console.log(`驗證 ${data.courses.length} 門課、${reviewCount} 則心得`);
if (warnings.length) {
  console.log(`\n提醒（${warnings.length}）：`);
  for (const w of warnings.slice(0, 20)) console.log('  !', w);
  if (warnings.length > 20) console.log(`  …另有 ${warnings.length - 20} 筆`);
}
if (errors.length) {
  console.error(`\n錯誤（${errors.length}）：`);
  for (const e of errors) console.error('  ✗', e);
  process.exitCode = 1;
} else {
  console.log('\n✅ 全部通過');
}

}
