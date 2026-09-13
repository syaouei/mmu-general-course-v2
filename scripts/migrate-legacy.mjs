// 一次性遷移：legacy/ 的舊 HTML → data/courses.json + migration-report.md
//
// 設計原則（對應規格第四節與第十三節）：
//   1. 絕不靜默丟棄。每則心得保留 rawHeader 原字串；任何無法歸類的片段一律進報告。
//   2. 冪等。review.id 由「來源檔名 + 頁內序號」決定，重跑結果完全一致。
//   3. 不猜。教師拼音查表，查不到就中止；評分缺項一律 null，不補值。
//
// 只用 Node 內建模組。
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LEGACY = 'legacy';
const OUT_JSON = 'data/courses.json';
const OUT_REPORT = 'migration-report.md';

const DOMAINS = [
  { id: 'tian', name: '天領域', order: 1, dir: 'n01_tian' },
  { id: 'di', name: '地領域', order: 2, dir: 'n02_di' },
  { id: 'ren', name: '人領域', order: 3, dir: 'n03_ren' },
  { id: 'xin', name: '心領域', order: 4, dir: 'n04_xin' },
  { id: 'xuanxiu', name: '系選修', order: 5, dir: 'n05_xuanxiu' },
  { id: 'tiyu', name: '體育類', order: 6, dir: 'n06_tiyu' },
  { id: 'yuyan', name: '語言類', order: 7, dir: 'n07_yuyan' },
  { id: 'other', name: '其他類', order: 8, dir: 'n08_other' },
];

// 舊站樣板沒填的佔位字串。出現這些代表 metadata 是假的，但心得可能是真的。
const PLACEHOLDERS = new Set(['課程代碼', '課程名稱', '老師名稱', '很多位老師', '領域']);

// ---------------------------------------------------------------- 報告收集器

const report = {
  pages: [],           // 每頁一筆摘要
  emptyFiles: [],      // 來源檔為空
  missingCode: [],     // 標題沒有課程代碼
  placeholders: [],    // metadata 是樣板佔位字串
  headerIssues: [],    // 評分摘要有無法歸類的片段
  noHeader: [],        // 心得沒有 <b> 評分摘要
  outOfRange: [],      // 評分超出規格範圍
  idCollisions: [],    // {code}-{teacher} 撞號
  duplicates: [],      // 疑似重複心得
  strictDelta: [],     // 規格原 regex 會丟掉、但本腳本救回來的欄位
  multiTeacher: [],    // 一格塞多位教師
};

// ---------------------------------------------------------------- HTML 小工具

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&apos;': "'", '&#39;': "'", '&middot;': '·',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** 抽純文字：<br> 變空白，其餘標籤剝掉，entity 解碼。用於標題／資訊列。 */
function inlineText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 抽心得內文：<br> 變換行，保留段落結構，三個以上連續換行壓成兩個。 */
function bodyText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[ \t　]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** 全形／半形分隔符都當成同一個。 */
const splitFields = (s) => s.split(/[｜|]/).map((t) => t.trim());

// ------------------------------------------------------- 評分摘要解析（逐欄位）
//
// 刻意不用單一巨型 regex。規格第四節那條 regex 尾端沒有錨定，欄位順序一旦不同
// 或多出「(1/19)」這種註記，剩下的字元會無聲消失 —— 實測 258 則裡有 43 則的
// 分數就是這樣掉的。改成切分後逐一歸類，任何歸不了類的片段都會留下紀錄。

const STRICT_RE = /^(?<term>\d{3,4})(?:\s*[｜|]\s*(?<stars>\d)\s*星)?(?:\s*[｜|]\s*甜度\s*(?<sweet>\d+))?(?:\s*[｜|]\s*涼度\s*(?<cool>\d+))?(?:\s*[｜|]\s*(?<grade>\d+)\s*分)?/;

function parseHeader(raw) {
  const out = {
    term: null, stars: null, sweet: null, cool: null, grade: null,
    unclassified: [], notes: [],
  };
  const fields = splitFields(raw);

  // 第一欄是學期
  const termTok = fields.shift() ?? '';
  const termM = termTok.match(/^(\d{3,4})\s*(.*)$/);
  if (termM) {
    out.term = termM[1];
    if (termM[2]) fields.unshift(termM[2]);   // 學期後面黏著別的欄位
  } else if (termTok) {
    out.unclassified.push(termTok);
  }

  for (const tok of fields) {
    if (!tok) continue;                        // 尾端多餘分隔符，無損
    let rest = tok;

    // 括號註記（班排／名次／日期）先抽出來留存，不擋住後面的欄位判定
    rest = rest.replace(/[（(]([^）)]*)[）)]/g, (_, inner) => {
      if (inner.trim()) out.notes.push(inner.trim());
      return ' ';
    }).trim();
    if (!rest) continue;

    let m;
    if ((m = rest.match(/^(\d+)\s*星$/))) { out.stars = Number(m[1]); continue; }
    if ((m = rest.match(/^甜度\s*(\d+)$/))) { out.sweet = Number(m[1]); continue; }
    if ((m = rest.match(/^涼度\s*(\d+)$/))) { out.cool = Number(m[1]); continue; }
    // 分數：可帶小數、可帶「+」、「分」字可有可無
    if ((m = rest.match(/^(\d+(?:\.\d+)?)\s*\+?\s*分?$/))) {
      const v = Number(m[1]);
      if (out.grade === null) { out.grade = v; continue; }
    }
    out.unclassified.push(tok);
  }
  return out;
}

// -------------------------------------------------------------------- 主流程

const pinyinTable = JSON.parse(await readFile('data/teacher-pinyin.json', 'utf8'));
const PINYIN = pinyinTable.map;

function slugifyName(name) {
  // 沒有課程代碼時的後備：課名做成 slug。中文保留，只把空白與符號收掉。
  return name.replace(/[\s　]+/g, '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 24);
}

const courses = [];
const unknownTeachers = new Set();

for (const dom of DOMAINS) {
  let files;
  try {
    files = (await readdir(join(LEGACY, dom.dir)))
      .filter((f) => /^[a-h]\d\d\.html$/.test(f))
      .sort();
  } catch {
    report.pages.push({ dir: dom.dir, error: '目錄不存在' });
    continue;
  }

  for (const file of files) {
    const path = join(LEGACY, dom.dir, file);
    const page = `${dom.dir}/${file}`;
    const html = await readFile(path, 'utf8');
    const base = file.replace(/\.html$/, '');

    if (html.trim().length === 0) {
      report.emptyFiles.push({ page, bytes: html.length });
      continue;
    }

    // --- 標題：代碼｜課名
    const titleRaw = inlineText((html.match(/<title>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '');
    const titleParts = splitFields(titleRaw).filter(Boolean);
    let code = null, name = null;
    if (titleParts.length >= 2) {
      [code, name] = titleParts;
    } else if (titleParts.length === 1) {
      // 沒有分隔符 → 沒有課程代碼，整串是課名。不捏造代碼。
      name = titleParts[0];
      report.missingCode.push({ page, title: titleRaw });
    }

    // --- 資訊列：領域｜教師
    const infoRaw = inlineText(
      (html.match(/class=["']label_info["'][^>]*>([\s\S]*?)<\/label>/i) ?? [])[1] ?? ''
    );
    const infoParts = splitFields(infoRaw).filter(Boolean);
    const domainLabel = infoParts[0] ?? null;
    const teacherRaw = infoParts[1] ?? null;

    // --- 佔位字串偵測
    const ph = [];
    if (code && PLACEHOLDERS.has(code)) ph.push(`代碼="${code}"`);
    if (name && PLACEHOLDERS.has(name)) ph.push(`課名="${name}"`);
    if (teacherRaw && PLACEHOLDERS.has(teacherRaw)) ph.push(`教師="${teacherRaw}"`);

    // --- 教師拼音（查表，查不到不猜）
    let teacherSlug = 'unknown';
    let teachers = null;
    if (teacherRaw) {
      const entry = PINYIN[teacherRaw];
      if (!entry) { unknownTeachers.add(teacherRaw); }
      else {
        teacherSlug = entry.slug;
        if (entry.teachers) {
          teachers = entry.teachers;
          report.multiTeacher.push({ page, raw: teacherRaw, split: entry.teachers });
        }
      }
    }

    // --- 心得
    const reviews = [];
    let seq = 0;
    for (const m of html.matchAll(/class=["']label_comment["'][^>]*>([\s\S]*?)<\/label>/gi)) {
      seq++;
      const inner = m[1];
      const rid = `lg-${dom.id}-${base}-${String(seq).padStart(2, '0')}`;

      const bMatch = inner.match(/<b>([\s\S]*?)<\/b>/i);
      const rawHeader = bMatch ? inlineText(bMatch[1]) : null;
      const bodyHtml = bMatch ? inner.slice(inner.indexOf('</b>') + 4) : inner;
      const text = bodyText(bodyHtml);

      const review = {
        id: rid,
        term: null, stars: null, sweet: null, cool: null, grade: null,
        text,
        rawHeader,                       // 原始摘要字串，永久保留，解析再爛都不會丟資料
        submittedAt: null,               // 舊站沒有投稿日期
        source: 'legacy',
        sourceFile: page,
        hidden: false,
      };

      if (!rawHeader) {
        report.noHeader.push({ page, id: rid, preview: text.slice(0, 40) });
      } else {
        const p = parseHeader(rawHeader);
        review.term = p.term;
        review.stars = p.stars;
        review.sweet = p.sweet;
        review.cool = p.cool;
        review.grade = p.grade;

        if (p.unclassified.length) {
          report.headerIssues.push({ page, id: rid, rawHeader, unclassified: p.unclassified });
        }

        // 範圍檢查：超出規格範圍不擅自修正，標記後照原值保留
        const bad = [];
        if (p.stars !== null && (p.stars < 1 || p.stars > 5)) bad.push(`stars=${p.stars}`);
        if (p.sweet !== null && (p.sweet < 0 || p.sweet > 10)) bad.push(`sweet=${p.sweet}`);
        if (p.cool !== null && (p.cool < 0 || p.cool > 10)) bad.push(`cool=${p.cool}`);
        if (p.grade !== null && (p.grade < 0 || p.grade > 100)) bad.push(`grade=${p.grade}`);
        if (bad.length) report.outOfRange.push({ page, id: rid, rawHeader, fields: bad });

        // 與規格原 regex 對照，量化「照規格做會丟多少」
        const strict = STRICT_RE.exec(rawHeader);
        const sg = strict?.groups ?? {};
        const rescued = [];
        if (review.grade !== null && sg.grade === undefined) rescued.push(`grade=${review.grade}`);
        if (review.stars !== null && sg.stars === undefined) rescued.push(`stars=${review.stars}`);
        if (review.sweet !== null && sg.sweet === undefined) rescued.push(`sweet=${review.sweet}`);
        if (review.cool !== null && sg.cool === undefined) rescued.push(`cool=${review.cool}`);
        if (p.notes.length) rescued.push(`註記「${p.notes.join('／')}」保存於 rawHeader`);
        if (rescued.length) report.strictDelta.push({ page, id: rid, rawHeader, rescued });
      }

      reviews.push(review);
    }

    const idBase = code && !PLACEHOLDERS.has(code) ? code : slugifyName(name ?? base);
    courses.push({
      _idBase: idBase,
      _slug: teacherSlug,
      code: code && !PLACEHOLDERS.has(code) ? code : null,
      name: name ?? null,
      domain: dom.id,
      teacher: teacherRaw,
      teachers,
      reviews,
      sourceFile: page,
      _placeholders: ph,
      _domainLabel: domainLabel,
    });

    if (ph.length) report.placeholders.push({ page, issues: ph, reviewCount: reviews.length });
    report.pages.push({ page, code, name, teacher: teacherRaw, reviews: reviews.length });
  }
}

// 教師表缺項 → 中止，不猜 slug（id 會進網址，猜錯等於連結永久錯誤）
if (unknownTeachers.size) {
  console.error('拼音表缺少下列教師，請補進 data/teacher-pinyin.json 後重跑：');
  for (const t of unknownTeachers) console.error('  -', JSON.stringify(t));
  process.exit(1);
}

// ------------------------------------------------------------ id 指派與碰撞處理

const seen = new Map();
for (const c of courses) {
  const wanted = `${c._idBase}-${c._slug}`;
  if (!seen.has(wanted)) {
    seen.set(wanted, [c]);
    c.id = wanted;
  } else {
    const group = seen.get(wanted);
    group.push(c);
    c.id = `${wanted}-${group.length}`;   // 依來源檔順序，穩定且冪等
    report.idCollisions.push({
      wanted,
      assigned: c.id,
      pages: group.map((g) => `${g.sourceFile}（${g.name}）`),
    });
  }
}

// ------------------------------------------------------------------ 重複偵測

const norm = (s) => s.replace(/\s+/g, '');
for (const c of courses) {
  const byText = new Map();
  for (const r of c.reviews) {
    const k = norm(r.text);
    if (!k) continue;
    if (byText.has(k)) {
      report.duplicates.push({ course: c.id, ids: [byText.get(k), r.id], preview: r.text.slice(0, 40) });
    } else byText.set(k, r.id);
  }
}

// -------------------------------------------------------------------- 產出 JSON

const clean = courses.map((c) => {
  const o = {
    id: c.id,
    code: c.code,
    name: c.name,
    domain: c.domain,
    teacher: c.teacher,
    reviews: c.reviews,
  };
  if (c.teachers) o.teachers = c.teachers;
  if (c._placeholders.length) o.needsReview = c._placeholders;
  return o;
});

const reviewCount = clean.reduce((a, c) => a + c.reviews.length, 0);
const data = {
  meta: {
    updatedAt: new Date().toISOString(),
    schemaVersion: 2,
    courseCount: clean.length,
    reviewCount,
    generatedBy: 'scripts/migrate-legacy.mjs',
  },
  domains: DOMAINS.map(({ id, name, order }) => ({ id, name, order })),
  courses: clean,
};

await mkdir('data', { recursive: true });
await writeFile(OUT_JSON, JSON.stringify(data, null, 2) + '\n', 'utf8');

// ------------------------------------------------------------------ 產出報告

const L = [];
const p = (s = '') => L.push(s);
const section = (title, rows, render) => {
  p(`## ${title}（${rows.length}）`);
  p();
  if (!rows.length) { p('_無_'); p(); return; }
  rows.forEach(render);
  p();
};

p('# 遷移報告');
p();
p(`產生時間：${data.meta.updatedAt}`);
p('來源：`legacy/`（haoyu050735/MMCGeneralCourse 快照）');
p();
p('## 總計');
p();
p('| 項目 | 數量 |');
p('|---|---|');
p(`| 解析的課程頁 | ${report.pages.filter((x) => x.page).length} |`);
p(`| 產出課程 | ${clean.length} |`);
p(`| 產出心得 | ${reviewCount} |`);
p(`| 空白來源檔（無資料） | ${report.emptyFiles.length} |`);
p(`| 需要人工確認的項目 | ${report.missingCode.length + report.placeholders.length + report.headerIssues.length + report.noHeader.length + report.outOfRange.length + report.idCollisions.length + report.duplicates.length} |`);
p();

p('### 各領域');
p();
p('| 領域 | 課程 | 心得 |');
p('|---|---|---|');
for (const d of DOMAINS) {
  const cs = clean.filter((c) => c.domain === d.id);
  p(`| ${d.name} | ${cs.length} | ${cs.reduce((a, c) => a + c.reviews.length, 0)} |`);
}
p();

p('---');
p();
p('> 以下每一節都是**需要你決定或知情**的項目。沒有任何一則心得因為解析失敗而被丟棄 ——');
p('> 每則心得都保留了 `rawHeader` 原始摘要字串，解析不出來的欄位是 `null`，不是被刪除。');
p();

section('規格原 regex 會丟掉、本腳本救回的欄位', report.strictDelta, (x) => {
  p(`- \`${x.id}\` ${x.page}`);
  p(`  - 原字串：\`${x.rawHeader}\``);
  p(`  - 救回：${x.rescued.join('、')}`);
});

section('空白來源檔', report.emptyFiles, (x) =>
  p(`- \`${x.page}\` — 檔案大小 ${x.bytes} bytes，完全沒有內容。舊站導覽指向這裡是死連結。`));

section('標題沒有課程代碼', report.missingCode, (x) =>
  p(`- \`${x.page}\` — \`<title>\` 為「${x.title}」，無分隔符。已設 \`code: null\`，id 改用課名 slug，未捏造代碼。`));

section('metadata 是樣板佔位字串（心得本身可能是真的）', report.placeholders, (x) =>
  p(`- \`${x.page}\` — ${x.issues.join('、')}，但頁內有 **${x.reviewCount} 則心得**。已標記 \`needsReview\`，心得保留。`));

section('評分摘要有無法歸類的片段', report.headerIssues, (x) => {
  p(`- \`${x.id}\` ${x.page}`);
  p(`  - 原字串：\`${x.rawHeader}\``);
  p(`  - 無法歸類：${x.unclassified.map((s) => `\`${s}\``).join('、')}`);
});

section('心得沒有評分摘要', report.noHeader, (x) =>
  p(`- \`${x.id}\` ${x.page} — 無 \`<b>\` 摘要，評分全為 null。內文開頭：「${x.preview}…」`));

section('評分超出規格範圍（未修正，照原值保留）', report.outOfRange, (x) =>
  p(`- \`${x.id}\` ${x.page} — ${x.fields.join('、')}，原字串 \`${x.rawHeader}\``));

section('課程 id 撞號', report.idCollisions, (x) => {
  p(`- 期望 id \`${x.wanted}\` 重複，已指派 \`${x.assigned}\``);
  x.pages.forEach((s) => p(`  - ${s}`));
});

section('一格塞多位教師', report.multiTeacher, (x) =>
  p(`- \`${x.page}\` — 原字串「${x.raw}」，拆為 ${x.split.map((s) => `「${s}」`).join('、')}（已寫入 \`teachers\`，\`teacher\` 保留原字串）`));

section('疑似重複心得', report.duplicates, (x) =>
  p(`- 課程 \`${x.course}\` — ${x.ids.join(' 與 ')} 內文相同：「${x.preview}…」**未自動刪除**，請確認。`));

p('## 疑似同一位教師的姓名變體');
p();
p('遷移**未自動合併**，資料照原字串保留。合併會改變課程頁「同教師其他課程」的結果，需要你確認。');
p();
for (const s of pinyinTable.suspectedSamePerson) {
  p(`- ${s.note}`);
  for (const n of s.names) {
    const cs = clean.filter((c) => c.teacher === n);
    p(`  - 「${n}」${cs.length} 門：${cs.map((c) => c.name).join('、')}`);
  }
}
p();

p('## 同代碼多筆課程（依規格刻意不合併）');
p();
const byCode = new Map();
for (const c of clean) {
  if (!c.code) continue;
  if (!byCode.has(c.code)) byCode.set(c.code, []);
  byCode.get(c.code).push(c);
}
const multi = [...byCode.entries()].filter(([, v]) => v.length > 1);
p('| 代碼 | 課程 |');
p('|---|---|');
for (const [code, cs] of multi) {
  p(`| \`${code}\` | ${cs.map((c) => `${c.teacher}《${c.name}》→ \`${c.id}\``).join('<br>')} |`);
}
p();

await writeFile(OUT_REPORT, L.join('\n'), 'utf8');

console.log(`courses.json: ${clean.length} 門課、${reviewCount} 則心得`);
console.log(`migration-report.md: ${L.length} 行`);
console.log(`待確認：救回欄位 ${report.strictDelta.length}、空檔 ${report.emptyFiles.length}、無代碼 ${report.missingCode.length}、佔位 ${report.placeholders.length}、摘要異常 ${report.headerIssues.length}、無摘要 ${report.noHeader.length}、超範圍 ${report.outOfRange.length}、撞號 ${report.idCollisions.length}、重複 ${report.duplicates.length}`);
