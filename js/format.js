// 學期／評分／統計的解析與格式化。
//
// 這個模組的唯一守則（規格第三節）：
//   缺項就是缺項。不補值、不用平均數填空、不猜。
//   統計一律回傳 { avg, n }，n 是實際參與計算的樣本數。
//   全部為 null 時 avg 必須是 null，**不得回傳 0** —— 0 是一個評價，
//   「沒有資料」不是。這條有對應的單元測試。

/** UI 上代表「這一則沒填」的符號。 */
export const NONE = '—';

/** UI 上代表「整門課這一項都沒有資料」的說法。 */
export const NO_DATA = '尚無資料';

/** 樣本數低於這個值就要提醒讀者別當真。 */
export const LOW_SAMPLE = 3;

/**
 * 學期代碼 → 可讀格式。
 *   '1101' → '110-1'（110 學年上學期）
 *   '991'  → '99-1'
 * 非 3–4 位數字一律回傳 NONE，不硬拆。
 */
export function formatTerm(term) {
  if (typeof term !== 'string' && typeof term !== 'number') return NONE;
  const s = String(term).trim();
  if (!/^\d{3,4}$/.test(s)) return NONE;
  return `${s.slice(0, -1)}-${s.slice(-1)}`;
}

/** 學期代碼排序用的數值。無效值排到最後面。 */
export function termOrder(term) {
  const s = String(term ?? '').trim();
  return /^\d{3,4}$/.test(s) ? Number(s) : -Infinity;
}

/**
 * 平均值。
 * 只計入 typeof 'number' 且非 NaN 的值 —— null、undefined、字串全部跳過。
 * 回傳 { avg, n }：
 *   n === 0 → avg 為 null。這是整個資料層最重要的一條規則。
 */
export function average(values) {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    sum += v;
    n++;
  }
  return { avg: n === 0 ? null : sum / n, n };
}

/** 只算沒有被隱藏的心得。hidden 的不渲染、不計入統計、不計入則數。 */
export const visibleReviews = (course) =>
  (course?.reviews ?? []).filter((r) => r && r.hidden !== true);

/**
 * 一門課的完整統計。
 * 每一項都是 { avg, n }，n 各自獨立 —— 一門課可能有 5 則星等但只有 1 則甜度。
 */
export function courseStats(course) {
  const rs = visibleReviews(course);
  const pick = (k) => average(rs.map((r) => r[k]));

  const terms = rs.map((r) => r.term).filter((t) => /^\d{3,4}$/.test(String(t ?? '')));
  terms.sort((a, b) => termOrder(a) - termOrder(b));

  return {
    count: rs.length,
    stars: pick('stars'),
    sweet: pick('sweet'),
    cool: pick('cool'),
    grade: pick('grade'),
    termFrom: terms.length ? terms[0] : null,
    termTo: terms.length ? terms[terms.length - 1] : null,
  };
}

/**
 * 統計數字 → 顯示字串。
 * avg 為 null（沒有任何樣本）時回傳 NO_DATA，永遠不會變成 '0'。
 */
export function formatStat(stat, digits = 1) {
  if (!stat || stat.avg === null) return NO_DATA;
  return trimZero(stat.avg.toFixed(digits));
}

/** 單一評分欄位 → 顯示字串。null 一律是 NONE，不是 0。 */
export function formatValue(v, digits = 0) {
  if (typeof v !== 'number' || Number.isNaN(v)) return NONE;
  return trimZero(v.toFixed(digits));
}

/** '4.0' → '4'，'4.50' → '4.5'。整數不要拖著沒意義的小數點。 */
function trimZero(s) {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** 樣本數註記：「／ 4 則」。統計旁邊永遠要有這個。 */
export const formatSample = (n) => `／ ${n} 則`;

/** 樣本數是否少到需要提醒。 */
export const isLowSample = (n) => n > 0 && n < LOW_SAMPLE;

/** 學期範圍：'110-1 – 111-2'，只有一個學期就顯示一個。 */
export function formatTermRange(stats) {
  if (!stats.termFrom) return NO_DATA;
  const a = formatTerm(stats.termFrom);
  const b = formatTerm(stats.termTo);
  return a === b ? a : `${a} – ${b}`;
}

/**
 * 排序用的比較值。
 * null 永遠沉底 —— 不管升冪降冪，「沒有資料」都不該排在「評價很低」前面，
 * 更不該被當成 0 混進去比大小。
 */
export function sortKey(stat) {
  return stat && stat.avg !== null ? stat.avg : null;
}

/** 產生比較函式：null 一律排在最後，與 dir 無關。 */
export function comparator(getValue, dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const va = getValue(a);
    const vb = getValue(b);
    const na = va === null || va === undefined;
    const nb = vb === null || vb === undefined;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === 'string' || typeof vb === 'string') {
      return sign * String(va).localeCompare(String(vb), 'zh-Hant');
    }
    return sign * (va - vb);
  };
}

/**
 * 星等的無障礙描述。
 * 螢幕閱讀器要聽到「尚無資料」，不能聽到 0。
 */
export function starsLabel(stat) {
  if (!stat || stat.avg === null) return `平均星級：${NO_DATA}`;
  return `平均星級 ${formatStat(stat, 1)} 顆星，共 ${stat.n} 則評分`;
}

/**
 * 量表的無障礙描述，對應 role="img" + aria-label。
 * 平均值會是 9.666666666666666 這種數字，唸出來很荒謬，跟畫面上顯示的
 * 位數保持一致（整數不補小數，非整數取一位）。
 */
export function meterLabel(name, value, max = 10) {
  if (typeof value !== 'number' || Number.isNaN(value)) return `${name}：${NO_DATA}`;
  return `${name} ${formatValue(value, Number.isInteger(value) ? 0 : 1)}，滿分 ${max}`;
}
