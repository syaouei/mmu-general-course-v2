// 首頁。
//
// 舊版最大的缺陷是只能一層層點，所以搜尋框放在最上面而不是側邊（規格第五節）。
// 由上而下：搜尋 → 八個領域 → 最新心得。
// 「最新心得」是舊版完全沒有的入口，缺了它新投稿等於沒有曝光。

import { el, replace, clear } from '../dom.js';
import { setMeta, buildHash, syncUrl } from '../router.js';
import * as store from '../store.js';
import { buildIndex, query } from '../search.js';
import {
  courseList, sectionHead, domainTag, termBadge, domainHref, courseHref,
  bindSearchInput,
} from '../ui.js';

const DEBOUNCE_MS = 150;

let index = null;
let indexVersion = -1;

export default async function home(ctx) {
  const main = document.getElementById('main');
  setMeta('', '馬偕醫學大學通識課程評價。搜尋課程代碼、課名或教師，查看學生心得、甜度與涼度。');

  const domains = store.getDomains();
  const domainsById = new Map(domains.map((d) => [d.id, d]));
  // 資料版本變了就重建索引（即時投稿併入後會變）。
  if (!index || indexVersion !== store.getVersion()) {
    index = buildIndex(store.getCourses());
    indexVersion = store.getVersion();
  }

  const initialQ = ctx.query.get('q') ?? '';

  // --- 搜尋區 -------------------------------------------------------------

  const input = el('input', {
    type: 'search',
    id: 'q',
    value: initialQ,
    placeholder: '搜尋課程代碼、課名或教師⋯⋯',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'search-hint',
  });

  const results = el('div', { id: 'results' });
  const status = el('p', {
    id: 'search-status',
    class: 'count',
    role: 'status',
    'aria-live': 'polite',
  });

  const browse = el('div', { id: 'browse' });

  main.replaceChildren(
    el('section', { class: 'hero wrap' }, [
      // 分兩段、各自不斷行，手機換行時才不會把「馬偕」拆開（見 .hero h1 span）。
      el('h1', {}, [el('span', {}, '你也想成為'), el('span', {}, '馬偕的大王嗎?')]),
      el('p', {}, '那你需要好好選課，恭喜你來對地方了，輸入課程代碼、課名或教師姓名開始搜尋。'),
      el('div', { class: 'searchbox' }, [
        el('label', { class: 'sr-only', for: 'q' }, '搜尋課程'),
        input,
        el('kbd', { 'aria-hidden': 'true' }, '/'),
      ]),
      el('p', { id: 'search-hint', class: 'sr-only' },
        '輸入後即時顯示結果。按斜線鍵可聚焦此欄位，按 Esc 清空。'),
      status,
    ]),
    el('div', { class: 'wrap' }, [results, browse]),
  );

  // --- 瀏覽區（沒有查詢時顯示） -------------------------------------------

  function renderBrowse() {
    replace(browse, [
      sectionHead('八個領域'),
      el('nav', { class: 'domain-grid', 'aria-label': '依領域瀏覽' },
        domains.map((d) => {
          const s = store.domainSummary(d.id);
          return el('a', {
            class: `domain-card d-${d.id}`,
            href: domainHref(d.id),
          }, [
            el('span', { class: 'name' }, d.name),
            el('span', { class: 'meta num' }, `${s.courseCount} 門課 ・ ${s.reviewCount} 則心得`),
          ]);
        })),
      renderLatest(),
    ]);
  }

  function renderLatest() {
    const latest = store.latestReviews(10);
    if (!latest.length) return null;
    return el('section', {}, [
      sectionHead('最新心得', { count: '全站最近 10 則' }),
      el('div', {}, latest.map(({ course, review }) =>
        el('a', {
          class: `latest-item ${course.domain ? 'd-' + course.domain : ''}`,
          href: courseHref(course),
        }, [
          el('div', { class: 'head' }, [
            termBadge(review.term),
            el('span', { class: 'name' }, course.name ?? '（無課名）'),
            course.teacher ? el('span', { class: 'teacher' }, course.teacher) : null,
            domainTag(domainsById.get(course.domain)),
          ]),
          el('p', { class: 'excerpt' }, review.text),
        ]))),
    ]);
  }

  // --- 搜尋結果 -----------------------------------------------------------

  function renderResults(q) {
    const hits = query(index, q);

    if (hits === null) {           // 沒有查詢，不是查無結果
      clear(results);
      status.textContent = '';
      browse.hidden = false;
      renderBrowse();
      return;
    }

    browse.hidden = true;
    // aria-live 播報筆數（規格第九節）
    status.textContent = hits.length
      ? `找到 ${hits.length} 門課`
      : `沒有符合「${q}」的課程`;

    replace(results, [
      sectionHead('搜尋結果', {
        count: `${hits.length} 門`,
        more: hits.length ? { href: buildHash('/search', { q }), label: '在搜尋頁開啟 →' } : null,
      }),
      courseList(hits, domainsById, `沒有符合「${q}」的課程。試試課程代碼或教師姓名。`),
    ]);
  }

  // --- 事件 ---------------------------------------------------------------
  //
  // bindSearchInput 處理輸入法組字：中文組字期間不查、不改網址，
  // 等 compositionend 才動作。syncUrl 只改網址不重跑路由 —— 重跑會把
  // 這個 <input> 換成新節點，正在組字的注音會直接斷掉。

  bindSearchInput(input, (q) => {
    renderResults(q);
    syncUrl(q ? buildHash('/', { q }) : '#/');
  }, { delay: DEBOUNCE_MS });

  renderResults(initialQ);

  // 自動 focus，但別搶走使用者已經在別處的操作，也別在手機上硬跳鍵盤。
  if (!initialQ && matchMedia('(min-width: 700px)').matches) {
    input.focus({ preventScroll: true });
  }
}
