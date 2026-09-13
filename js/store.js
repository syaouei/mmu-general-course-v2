// 資料載入、合併、抑制清單、快取。
//
// 雙軌讀取（規格第六節）：
//   1. 先載 data/courses.json —— 快、穩、離線可用。畫面立刻可以渲染。
//   2. 再非同步抓投稿 CSV，合併去重後更新畫面，頁尾標示「含即時投稿」。
//      失敗就靜默降級，只顯示已烘焙資料，不出現錯誤畫面。
//   第 2 步在階段五接上，這裡先把介面與合併點留好。
//
// 抑制清單在渲染前套用到「兩邊」—— 烘焙資料與即時 CSV 都要過。因為 CSV 是
// 即時的，只改 courses.json 殺不掉惡意內容。

import { termOrder, visibleReviews } from './format.js';
import { parseRecords } from './csv.js';
import { parseBlocklist, gateBatch } from './gate.js';
import { recordToFields, mergeSubmissions, stableId, courseKey } from './submissions.js';

const state = {
  config: null,
  data: null,          // { meta, domains, courses }
  suppressed: new Set(),
  pinyinMap: {},
  byId: new Map(),
  byDomain: new Map(),
  live: false,         // 是否已併入即時投稿
  liveCount: 0,        // 即時併入的心得數
  version: 0,          // 每次資料變動 +1，供搜尋索引判斷是否要重建
  ready: null,         // 載入中的 Promise
};

const listeners = new Set();

/** 訂閱資料變動（即時投稿併入後會再觸發一次）。 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  state.version++;
  for (const fn of listeners) fn(state);
}

async function getJSON(url, fallback) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (fallback !== undefined) {
      console.warn(`[store] ${url} 載入失敗，改用預設值：`, err.message);
      return fallback;
    }
    throw err;
  }
}

/** 建立索引並套用抑制清單。每次資料變動都要重跑。 */
function reindex() {
  const { data, suppressed } = state;
  state.byId = new Map();
  state.byDomain = new Map();
  if (!data) return;

  for (const d of data.domains) state.byDomain.set(d.id, []);

  for (const course of data.courses) {
    // 抑制清單優先於一切：命中的心得在渲染前就被移除，不會進統計、不會計入則數。
    course.reviews = (course.reviews ?? []).filter((r) => !suppressed.has(r.id));
    state.byId.set(course.id, course);
    if (!state.byDomain.has(course.domain)) state.byDomain.set(course.domain, []);
    state.byDomain.get(course.domain).push(course);
  }
}

/** 載入烘焙資料。回傳的 Promise 會被快取，重複呼叫不會重抓。 */
export function load() {
  if (state.ready) return state.ready;

  state.ready = (async () => {
    const [config, data, suppressed, pinyin] = await Promise.all([
      getJSON('data/config.json', {}),
      getJSON('data/courses.json'),
      // 抑制清單缺檔不是錯誤，代表目前沒有任何要殺掉的內容。
      getJSON('data/suppressed.json', { ids: [] }),
      getJSON('data/teacher-pinyin.json', { map: {} }),
    ]);

    state.config = config;
    state.data = data;
    state.suppressed = new Set(suppressed.ids ?? []);
    state.pinyinMap = pinyin.map ?? {};
    reindex();
    emit();
    return state;
  })();

  return state.ready;
}

// ------------------------------------------------------------ 即時投稿合併
//
// 規格第六節的第二軌：烘焙資料先上，再非同步抓 CSV 併進來。
//
// 這一軌存在的理由是延遲 —— 建置期同步每 6 小時跑一次，沒有它的話，
// 剛投稿的同學要等最多 6 小時才看得到自己的心得。
//
// 失敗一律靜默降級：CSV 抓不到、格式壞掉、Google 限流，使用者看到的就是
// 已烘焙的資料，不會有錯誤畫面。即時投稿是加分，不是這個站能不能用的前提。

let liveStarted = false;

export async function loadLive() {
  if (liveStarted) return;
  liveStarted = true;

  const url = state.config?.forms?.submissionsCsv;
  if (!url) return;

  try {
    const [csvRes, blocklistText] = await Promise.all([
      fetch(url, { cache: 'no-cache' }),
      fetch('scripts/blocklist.txt').then((r) => (r.ok ? r.text() : '')).catch(() => ''),
    ]);
    if (!csvRes.ok) throw new Error(`HTTP ${csvRes.status}`);

    const { records } = parseRecords(await csvRes.text());
    if (!records.length) return;

    const data = state.data;
    const domainNames = new Set(data.domains.map((d) => d.name));

    // 已烘焙的心得 id。建置期同步過的不要再併一次。
    const syncedIds = new Set();
    for (const c of data.courses) for (const r of c.reviews) syncedIds.add(r.id);

    const existingTexts = new Map();
    for (const c of data.courses) {
      const k = courseKey(c.code, c.teacher);
      existingTexts.set(k, (existingTexts.get(k) ?? []).concat(c.reviews.map((r) => r.text)));
    }

    // 與建置期完全相同的閘門。兩邊判斷不一致的話，使用者看到的內容
    // 會跟資料檔裡的不一樣，而且沒有人會發現。
    const result = gateBatch(records.map(recordToFields), {
      blocklist: parseBlocklist(blocklistText),
      domainNames,
      existingTexts,
      isAlreadySynced: (f) => syncedIds.has(stableId(f.timestamp, f.code, f.text)),
    });

    if (!result.accepted.length) return;

    const { courses, summary } = mergeSubmissions(data, result.accepted, {
      pinyinMap: state.pinyinMap,
      suppressed: state.suppressed,   // 抑制清單同樣套用到即時這一軌
    });
    if (!summary.added) return;

    state.data = { ...data, courses };
    state.live = true;
    state.liveCount = summary.added;
    reindex();
    emit();
  } catch (err) {
    // 靜默降級。留一行 console 給維護者，使用者什麼都看不到。
    console.info('[store] 即時投稿載入失敗，改用已烘焙資料：', err.message);
  }
}

// --------------------------------------------------------------------- 查詢

export const getState = () => state;
export const getMeta = () => state.data?.meta ?? {};
export const getDomains = () => state.data?.domains ?? [];
export const getCourses = () => state.data?.courses ?? [];
export const getCourse = (id) => state.byId.get(id) ?? null;
export const getDomain = (id) => getDomains().find((d) => d.id === id) ?? null;
export const coursesInDomain = (id) => state.byDomain.get(id) ?? [];
export const isLive = () => state.live;
export const getLiveCount = () => state.liveCount;

/** 資料版本。搜尋索引用它判斷要不要重建，不必跨模組互相通知。 */
export const getVersion = () => state.version;

/** 領域卡片用的統計：課程數與心得數（不含 hidden）。 */
export function domainSummary(domainId) {
  const cs = coursesInDomain(domainId);
  return {
    courseCount: cs.length,
    reviewCount: cs.reduce((a, c) => a + visibleReviews(c).length, 0),
  };
}

/**
 * 心得的時間排序值。
 * 表單投稿有真的 submittedAt；舊站資料只有學期，就用學期。兩者不同量級，
 * 所以投稿一律排在同學期的舊資料前面，不會因為缺日期而永遠沉底。
 */
function reviewTime(r) {
  if (r.submittedAt) {
    const t = Date.parse(r.submittedAt);
    if (!Number.isNaN(t)) return t;
  }
  // 學期 → 概略時間：110-1 約 2021 年 9 月。夠用來排序，不用來顯示。
  const n = termOrder(r.term);
  if (n === -Infinity) return -Infinity;
  const year = Math.floor(n / 10) + 1911;
  const month = n % 10 === 1 ? 8 : 1;
  return Date.UTC(year, month, 1);
}

/** 全站最近 n 則心得。舊版沒有這個入口，新投稿完全沒有曝光。 */
export function latestReviews(n = 10) {
  const out = [];
  for (const course of getCourses()) {
    for (const r of visibleReviews(course)) out.push({ course, review: r });
  }
  out.sort((a, b) => reviewTime(b.review) - reviewTime(a.review));
  return out.slice(0, n);
}
