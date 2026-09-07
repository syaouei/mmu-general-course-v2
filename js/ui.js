// 跨視圖共用的呈現元件。
//
// 放這裡而不是 dom.js：dom.js 只負責「安全地建節點」這件事，不該知道
// 課程或領域長什麼樣子。這兩層分開，禁用 innerHTML 的邊界才守得住。

import { el, frag } from './dom.js';
import {
  NONE, NO_DATA, formatTerm, formatStat, formatValue,
  formatSample, isLowSample, starsLabel, meterLabel, courseStats,
} from './format.js';

/** 課程頁網址。id 已經是安全的 slug，仍然編碼一次以防萬一。 */
export const courseHref = (course) => `#/c/${encodeURIComponent(course.id)}`;
export const domainHref = (id) => `#/d/${encodeURIComponent(id)}`;

/** 領域的 class，帶出 --d 與 --m 兩個顏色變數。 */
export const domainClass = (id) => `d-${id}`;

/**
 * 領域標籤。
 * 規格第八節：領域名稱永遠以文字直接標示，顏色只是輔助 ——
 * 色覺障礙者不會因為分不出兩個色而看錯領域。不要拿掉文字。
 */
export function domainTag(domain) {
  if (!domain) return null;
  return el('span', { class: `tag-domain ${domainClass(domain.id)}` }, domain.name);
}

/**
 * 星等。
 * 圖形是輔助，數字才是內容 —— 沒有樣本時顯示「尚無資料」而不是空的五顆星，
 * 空星會被讀成「0 分」。
 */
export function starsView(stat) {
  if (!stat || stat.avg === null) {
    return el('span', { class: 'stars is-none', title: NO_DATA }, NO_DATA);
  }
  const filled = Math.round(stat.avg);
  const glyphs = [];
  for (let i = 1; i <= 5; i++) {
    glyphs.push(el('span', { class: i <= filled ? '' : 'off', 'aria-hidden': 'true' }, '★'));
  }
  return el('span', { class: 'stars', role: 'img', 'aria-label': starsLabel(stat) }, [
    ...glyphs,
    el('span', { class: 'sr-only' }, starsLabel(stat)),
  ]);
}

/**
 * 十格分段量表（規格第八節的招牌元件）。
 * 甜度與涼度本來就是 0–10 的整數，不畫成連續長條。
 * 缺項時整條全空並標「—」，讓「沒有資料」不會被誤讀成「0 分」。
 */
export function meterView(name, value, { showLabel = true } = {}) {
  const has = typeof value === 'number' && !Number.isNaN(value);
  const filled = has ? Math.round(value) : 0;

  const cells = [];
  for (let i = 1; i <= 10; i++) {
    cells.push(el('i', { class: has && i <= filled ? 'on' : '' }));
  }

  return el('span', { class: 'meter-row' }, [
    showLabel ? el('span', { class: 'meter-label' }, name) : null,
    el('span', {
      class: `meter${has ? '' : ' is-none'}`,
      role: 'img',
      'aria-label': meterLabel(name, value),
    }, cells),
    el('span', { class: `meter-value${has ? '' : ' is-none'}` },
      has ? formatValue(value, Number.isInteger(value) ? 0 : 1) : NONE),
  ]);
}

/** 學期徽章。螢光筆外皮的一部分：學期代碼是藍色標記。 */
export function termBadge(term) {
  const s = formatTerm(term);
  return el('span', {
    class: s === NONE ? 'is-none' : 'badge-term',
    'aria-label': s === NONE ? '學期不明' : `${s} 學期`,
  }, s);
}

/** 統計摘要的一格：數值 + 樣本數。樣本數不能省略。 */
export function statCell(label, stat, { digits = 1, suffix = '' } = {}) {
  const has = stat && stat.avg !== null;
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat-label' }, label),
    el('div', { class: `stat-value${has ? '' : ' is-none'}` },
      has ? formatStat(stat, digits) + suffix : NO_DATA),
    el('div', { class: 'stat-sample' }, has ? formatSample(stat.n) : ''),
  ]);
}

/**
 * 搜尋結果／課程清單的一列。
 * 掃描任務：一列就要看完代碼、課名、教師、領域、平均星級、心得則數。
 */
export function courseRow(course, domain) {
  const st = courseStats(course);

  return el('a', {
    class: `result-row ${domainClass(course.domain)}`,
    href: courseHref(course),
  }, [
    el('span', { class: `code${course.code ? '' : ' is-none'}` },
      course.code ?? '無代碼'),
    el('span', { class: 'title' }, course.name ?? '（無課名）'),
    el('span', { class: 'sub' }, [
      domainTag(domain),
      course.teacher ? el('span', {}, course.teacher) : el('span', { class: 'is-none' }, '教師不明'),
    ]),
    el('span', { class: 'right' }, [
      starsView(st.stars),
      el('span', { class: st.count ? 'num' : 'num is-none' },
        st.count ? `${st.count} 則${isLowSample(st.count) ? '' : ''}` : '尚無心得'),
    ]),
  ]);
}

/** 一群課程 → 清單。空的時候給一句人話，不要留白。 */
export function courseList(courses, domainsById, emptyText = '沒有符合的課程。') {
  if (!courses.length) return el('p', { class: 'empty' }, emptyText);
  return el('div', { class: 'result-list' },
    courses.map((c) => courseRow(c, domainsById.get(c.domain))));
}

/** 區塊標題列。 */
export function sectionHead(title, { count = null, more = null } = {}) {
  return el('div', { class: 'section-head' }, [
    el('h2', {}, title),
    count !== null ? el('span', { class: 'count' }, count) : null,
    more ? el('a', { class: 'more', href: more.href }, more.label) : null,
  ]);
}

export { frag };
