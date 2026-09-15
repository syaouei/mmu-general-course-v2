// 建置期同步：投稿 CSV → data/courses.json（規格第六節）
//
//   node scripts/sync-submissions.mjs [--dry-run] [--csv <path|url>]
//
// 由 .github/workflows/sync.yml 每 6 小時跑一次並自動 commit。
// 這條路徑存在的理由不是效能，是**版本歷史**：每次同步都是一個 commit，
// 惡意內容進來的那一刻、以及它被移除的那一刻，都留在 git log 裡可追溯。
// 維護者不需要按任何按鈕。
//
// 品質閘與執行期共用 js/gate.js —— 兩邊必須做出一模一樣的判斷，
// 否則使用者看到的內容會跟資料檔裡的不一致。

import { readFile, writeFile } from 'node:fs/promises';
import { parseRecords } from '../js/csv.js';
import { parseBlocklist, gateBatch } from '../js/gate.js';
import {
  recordToFields, mergeSubmissions, unknownHeaders, piiHeaders, courseKey, stableId,
  domainChoices, coursePlacer,
} from '../js/submissions.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const csvArg = args[args.indexOf('--csv') + 1];
const CSV_OVERRIDE = args.includes('--csv') ? csvArg : null;

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${p} 讀取失敗：${err.message}`);
  }
};

// ------------------------------------------------------------------ 讀設定

const config = await readJson('data/config.json');
const source = CSV_OVERRIDE ?? config.forms?.submissionsCsv;

// 全程用 process.exitCode 而不是 process.exit()。
//
// process.exit() 會在 undici 的 keep-alive socket 還在收尾時強制結束行程，
// Windows 上的 libuv 會直接斷言失敗（UV_HANDLE_CLOSING），離開碼變成 127。
// 排程的 Action 每 6 小時就會紅一次，而且紅的原因跟同步結果完全無關。
const stop = (code, ...msg) => {
  if (msg.length) (code ? console.error : console.log)(...msg);
  process.exitCode = code;
  return null;
};

async function run() {
  if (!source) {
    return stop(0, 'data/config.json 的 forms.submissionsCsv 是空的，略過同步。');
  }

  // ---------------------------------------------------------------- 取 CSV

  let csvText;
  if (/^https?:/.test(source)) {
    console.log(`抓取投稿 CSV：${source.slice(0, 72)}…`);
    const res = await fetch(source, { redirect: 'follow' });
    if (!res.ok) {
      return stop(1,
        `CSV 讀取失敗：HTTP ${res.status}`,
        '\n檢查試算表的共用設定是否為「知道連結的任何人 → 檢視者」。');
    }
    csvText = await res.text();
  } else {
    csvText = await readFile(source, 'utf8');
  }

  const { headers, records } = parseRecords(csvText);
  console.log(`CSV：${headers.length} 欄、${records.length} 列`);

  // --------------------------------------------------- 欄位檢查（個資防線）

  const unknown = unknownHeaders(headers);
  const pii = piiHeaders(headers);

  if (pii.length) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║  ⚠️  投稿試算表出現疑似個資欄位                            ║');
    console.error('╚══════════════════════════════════════════════════════════╝');
    console.error(`   欄位：${pii.join('、')}`);
    console.error('   這份試算表是公開唯讀的，該欄內容任何人都讀得到。');
    console.error('   請到 Google 表單關閉該題或關閉「蒐集電子郵件地址」。');
    console.error('   本次同步不會把這些欄位寫進 courses.json，但外洩已經發生。');
    console.error('');
  }
  if (unknown.length) {
    console.log(`未知欄位（不會寫入資料檔）：${unknown.join('、')}`);
  }

  // ------------------------------------------------------------------ 跑閘門

  const data = await readJson('data/courses.json');
  const blocklist = parseBlocklist(await readFile('scripts/blocklist.txt', 'utf8').catch(() => ''));
  const suppressedFile = await readJson('data/suppressed.json', { ids: [] });
  const suppressed = new Set(suppressedFile.ids ?? []);
  const domainNames = domainChoices(data.domains);   // 含「系選修／醫學系」這種帶系的選項

  // 既有心得內文，給重複偵測用。依「代碼＋教師」分組，不同老師的同名課
  // 不會互相誤判成重複。
  const existingTexts = new Map();
  for (const c of data.courses) {
    const key = courseKey(c.code, c.teacher);
    existingTexts.set(key, (existingTexts.get(key) ?? []).concat(c.reviews.map((r) => r.text)));
  }

  // 已經同步進 courses.json 的心得 id。先挑出來，重複偵測才不會把它們
  // 全部判成「與既有心得相同」。
  const syncedIds = new Set();
  for (const c of data.courses) for (const r of c.reviews) syncedIds.add(r.id);
  const isAlreadySynced = (f) => syncedIds.has(stableId(f.timestamp, f.code, f.text));

  const rows = records.map(recordToFields);
  const result = gateBatch(rows, {
    blocklist, domainNames, existingTexts, isAlreadySynced,
    placeCourse: coursePlacer(data.courses),   // 老師寫法不同也併對課；分不出來的進待審區
  });

  console.log('');
  console.log(
    `閘門結果：放行 ${result.accepted.length}`
    + `、已同步過 ${result.existing.length}`
    + `、待審 ${result.quarantined.length}`
    + `、重複丟棄 ${result.discarded.length}`
  );

  // ------------------------------------------------------------------ 合併

  const pinyinMap = (await readJson('data/teacher-pinyin.json', { map: {} })).map ?? {};
  const { courses, summary } = mergeSubmissions(data, result.accepted, { pinyinMap, suppressed });

  const reviewCount = courses.reduce((a, c) => a + c.reviews.length, 0);
  const now = new Date().toISOString();

  // 只有內容真的變了才寫檔。
  //
  // 舊版每次同步都重寫 meta.updatedAt、lastSync 與 quarantine.json 的時間戳。
  // 沒有任何新投稿時，每 6 小時照樣產生一個 commit —— git 紀錄塞滿空的同步，
  // 頁尾的「最後更新」也變成「最後一次同步的時間」，明明資料根本沒動。
  // 第一次排程同步（2026-09-14 20:05）就留下了這樣一個只改時間戳的 commit。
  const coursesChanged = JSON.stringify(courses) !== JSON.stringify(data.courses);

  const next = {
    meta: {
      ...data.meta,
      updatedAt: now,
      courseCount: courses.length,
      reviewCount,
      lastSync: {
        at: now,
        added: summary.added,
        quarantined: result.quarantined.length,
        discarded: result.discarded.length,
      },
    },
    domains: data.domains,
    courses,
  };

  // ------------------------------------------------------------- 待審區

  const quarantineItems = result.quarantined.map((r) => ({
    fields: r.fields,
    reasons: r.reasons,
    masked: r.masked,
  }));
  const previousQuarantine = await readJson('data/quarantine.json', { items: [] });
  const quarantineChanged =
    JSON.stringify(previousQuarantine.items ?? []) !== JSON.stringify(quarantineItems);

  const quarantine = {
    $comment: '被自動品質閘擋下、等待後台處理的投稿。逐筆放行或永久丟棄。',
    updatedAt: now,
    items: quarantineItems,
  };

  // --------------------------------------------------------------------- 輸出

  console.log(`新增心得 ${summary.added} 則`);
  if (summary.skippedExisting) console.log(`  （${summary.skippedExisting} 則已存在，略過）`);
  if (summary.skippedSuppressed) console.log(`  （${summary.skippedSuppressed} 則在抑制清單，略過）`);
  if (summary.skippedAmbiguous) {
    // 同一批裡先建了新課、後一筆又對到它但分不出來時會走到這裡；下次同步會進待審區。
    console.log(`  （${summary.skippedAmbiguous} 則分不出是哪一門課，這次先不併，下次同步會進待審區）`);
  }
  if (summary.newCourses.length) {
    console.log(`新增課程 ${summary.newCourses.length} 門：`);
    for (const c of summary.newCourses) console.log(`  ${c.id}  ${c.code} ${c.name}（${c.teacher}）`);
  }

  if (result.quarantined.length) {
    console.log('');
    console.log('待審項目：');
    for (const r of result.quarantined.slice(0, 20)) {
      console.log(`  ${r.fields.code || '(無代碼)'} ${r.fields.name || ''} — ${r.reasons.join('；')}`);
    }
    if (result.quarantined.length > 20) console.log(`  …另有 ${result.quarantined.length - 20} 筆`);
  }

  if (DRY) {
    console.log('');
    console.log('--dry-run：沒有寫入任何檔案。');
    return stop(0);
  }

  console.log('');
  if (!coursesChanged && !quarantineChanged) {
    console.log('沒有任何變動，不寫入檔案（不產生空的 commit，也不改動頁尾的「最後更新」）。');
  }
  if (coursesChanged) {
    await writeFile('data/courses.json', JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log(`已寫入 data/courses.json（${courses.length} 門課、${reviewCount} 則心得）`);
  }
  if (quarantineChanged) {
    await writeFile('data/quarantine.json', JSON.stringify(quarantine, null, 2) + '\n', 'utf8');
    console.log(`已寫入 data/quarantine.json（${quarantine.items.length} 筆待審）`);
  }

  // 給 GitHub Actions 判斷要不要 commit
  if (process.env.GITHUB_OUTPUT) {
    const changed = coursesChanged || quarantineChanged;
    await writeFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nadded=${summary.added}\n`, { flag: 'a' });
  }
}

await run();
