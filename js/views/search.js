// 搜尋結果頁 —— 儀表皮膚（規格第八節把搜尋結果歸在儀表這一側）。
//
// 首頁的即時搜尋只給快速命中；這一頁多了篩選與排序，而且條件全部寫進網址，
// 所以 #/search?q=易經&sweet=8 可以直接貼給同學。

import { el, replace } from '../dom.js';
import { setMeta, buildHash, syncUrl } from '../router.js';
import * as store from '../store.js';
import { buildIndex, query as runQuery, filter, sort, SORTS } from '../search.js';
import { courseList, bindSearchInput } from '../ui.js';

let index = null;
let indexVersion = -1;

export default async function searchView(ctx) {
  const main = document.getElementById('main');
  // 資料版本變了就重建索引（即時投稿併入後會變）。
  if (!index || indexVersion !== store.getVersion()) {
    index = buildIndex(store.getCourses());
    indexVersion = store.getVersion();
  }

  const domainsById = new Map(store.getDomains().map((d) => [d.id, d]));

  const num = (k) => {
    const v = ctx.query.get(k);
    const n = v === null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const params = {
    q: ctx.query.get('q') ?? '',
    sort: SORTS[ctx.query.get('sort')] ? ctx.query.get('sort') : 'stars',
    minStars: num('stars'),
    minSweet: num('sweet'),
    minCool: num('cool'),
    hasReviews: ctx.query.get('has') === '1',
  };

  const toQuery = () => ({
    q: params.q,
    sort: params.sort === 'stars' ? null : params.sort,
    stars: params.minStars,
    sweet: params.minSweet,
    cool: params.minCool,
    has: params.hasReviews ? '1' : null,
  });

  setMeta(params.q ? `搜尋「${params.q}」` : '搜尋',
    params.q ? `「${params.q}」的通識課程搜尋結果。` : '搜尋馬偕通識課程。');

  const input = el('input', {
    type: 'search', id: 'q', value: params.q,
    placeholder: '搜尋課程代碼、課名或教師⋯⋯',
    autocomplete: 'off', spellcheck: 'false',
  });

  const results = el('div', {});
  const status = el('p', { class: 'filter-note', role: 'status', 'aria-live': 'polite' });

  // syncUrl 只鏡射狀態到網址，不重跑路由 —— 重跑會換掉正在打字的 <input>。
  const sync = () => {
    syncUrl(buildHash('/search', toQuery()));
    render();
  };

  // 中文組字期間不查、不改網址，等組完才動作。
  bindSearchInput(input, (q) => { params.q = q; sync(); });

  const thresholds = (max) => [['', '不限'],
    ...Array.from({ length: max }, (_, i) => [max - i, `${max - i} 以上`])];

  const select = (label, key, options) =>
    el('label', { class: 'control' }, [
      el('span', {}, label),
      el('select', {
        onchange: (e) => {
          params[key] = e.target.value === '' ? null : Number(e.target.value);
          sync();
        },
      }, options.map(([v, t]) =>
        el('option', { value: v, selected: String(params[key] ?? '') === String(v) }, t))),
    ]);

  main.replaceChildren(el('div', { class: 'wrap' }, [
    el('header', { class: 'page-head' }, [
      el('p', { class: 'crumb' }, [el('a', { href: '#/' }, '首頁'), ' ／ 搜尋']),
      el('h1', {}, '搜尋課程'),
    ]),
    el('div', { class: 'searchbox', style: 'margin-top:var(--s4)' }, [
      el('label', { class: 'sr-only', for: 'q' }, '搜尋課程'),
      input,
    ]),
    el('div', { class: 'controls' }, [
      el('label', { class: 'control' }, [
        el('span', {}, '排序'),
        el('select', {
          onchange: (e) => { params.sort = e.target.value; sync(); },
        }, Object.entries(SORTS).map(([k, s]) =>
          el('option', { value: k, selected: params.sort === k }, s.label))),
      ]),
      select('最低星級', 'minStars', thresholds(5)),
      select('最低甜度', 'minSweet', thresholds(10)),
      select('最低涼度', 'minCool', thresholds(10)),
      el('div', { class: 'control is-check' }, [
        el('input', {
          type: 'checkbox', id: 'has-reviews', checked: params.hasReviews,
          onchange: (e) => { params.hasReviews = e.target.checked; sync(); },
        }),
        el('label', { for: 'has-reviews' }, '只看有心得的'),
      ]),
    ]),
    status,
    results,
  ]));

  function render() {
    const hits = runQuery(index, params.q) ?? store.getCourses();
    const rows = sort(filter(hits, params), params.sort);

    status.textContent = params.q
      ? `「${params.q}」找到 ${hits.length} 門課${rows.length !== hits.length ? `，符合篩選條件的 ${rows.length} 門` : ''}`
      : `全部 ${rows.length} 門課`;

    replace(results, courseList(rows, domainsById,
      params.q ? `沒有符合「${params.q}」的課程。` : '沒有課程符合這些條件。'));
  }

  render();
  if (!params.q) input.focus({ preventScroll: true });
}
