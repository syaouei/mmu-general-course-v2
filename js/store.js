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

const state = {
  config: null,
  data: null,          // { meta, domains, courses }
  suppressed: new Set(),
  byId: new Map(),
  byDomain: new Map(),
  live: false,         // 是否已併入即時投稿
  ready: null,         // 載入中的 Promise
};

const listeners = new Set();

/** 訂閱資料變動（即時投稿併入後會再觸發一次）。 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
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
    const [config, data, suppressed] = await Promise.all([
      getJSON('data/config.json', {}),
      getJSON('data/courses.json'),
      // 抑制清單缺檔不是錯誤，代表目前沒有任何要殺掉的內容。
      getJSON('data/suppressed.json', { ids: [] }),
    ]);

    state.config = config;
    state.data = data;
    state.suppressed = new Set(suppressed.ids ?? []);
    reindex();
    emit();
    return state;
  })();

  return state.ready;
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
