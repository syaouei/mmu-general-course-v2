// 領域頁 —— 儀表皮膚。
//
// 這是掃描任務的主場（規格第五、八節）：十分鐘比完二十門課，只想知道
// 哪門甜、哪門涼。所以密度高、對齊嚴格、等寬數字，桌機是可排序表格。
//
// 所有條件都寫進網址 query，貼給同學就是同一個畫面。
//
// 底下有分系的領域（系選修）在標題下多一排系的按鈕：選「全部」時依系
// 分段列出，選了系就只列那個系。選的系一樣寫進網址（?dept=med）。

import { el, replace } from '../dom.js';
import { setMeta, buildHash, syncUrl } from '../router.js';
import * as store from '../store.js';
import { SORTS, filter, sort } from '../search.js';
import { courseList, meterView, starsView, courseHref, domainClass } from '../ui.js';
import { courseStats, formatTerm, NONE } from '../format.js';

/** 沒標系的課（表單改版前用舊選項「系選修」投稿建的）在網址裡的代號。 */
const NO_GROUP = 'none';

/** 從網址讀出條件。缺的一律用預設，不會因為少一個參數就壞掉。 */
function readParams(query) {
  const num = (k) => {
    const v = query.get(k);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    dept: query.get('dept') || null,
    sort: SORTS[query.get('sort')] ? query.get('sort') : 'code',
    dir: query.get('dir') === 'asc' || query.get('dir') === 'desc' ? query.get('dir') : null,
    minStars: num('stars'),
    minSweet: num('sweet'),
    minCool: num('cool'),
    teacher: query.get('teacher') || null,
    hasReviews: query.get('has') === '1',
  };
}

/** 條件 → 網址。空值不寫進去，網址才不會一堆 &x=。 */
function toQuery(p) {
  return {
    dept: p.dept,
    sort: p.sort === 'code' ? null : p.sort,
    dir: p.dir,
    stars: p.minStars,
    sweet: p.minSweet,
    cool: p.minCool,
    teacher: p.teacher,
    has: p.hasReviews ? '1' : null,
  };
}

export default async function domainView(ctx) {
  const main = document.getElementById('main');
  const domain = store.getDomain(ctx.params.id);

  if (!domain) {
    setMeta('找不到領域', '這個領域不存在。');
    main.replaceChildren(el('div', { class: 'wrap' }, [
      el('p', { class: 'empty' }, [
        el('strong', {}, '找不到這個領域'),
        el('br'), el('br'),
        el('a', { href: '#/' }, '← 回首頁'),
      ]),
    ]));
    return;
  }

  const all = store.coursesInDomain(domain.id);
  const domainsById = new Map(store.getDomains().map((d) => [d.id, d]));
  const teachers = [...new Set(all.map((c) => c.teacher).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));

  // 分系。沒有 groups 的領域這裡是空陣列，底下的分系邏輯全部不會啟動。
  const groups = domain.groups ?? [];
  const groupIds = new Set(groups.map((g) => g.id));
  const inGroup = (id) => (c) => (id === NO_GROUP ? !groupIds.has(c.dept) : c.dept === id);
  const ungrouped = groups.length ? all.filter(inGroup(NO_GROUP)) : [];

  const params = readParams(ctx.query);
  // 網址裡的系對不上（打錯字，或那個系後來改了 id）就當成「全部」，不給空白頁。
  if (!groupIds.has(params.dept) && !(params.dept === NO_GROUP && ungrouped.length)) {
    params.dept = null;
  }

  setMeta(domain.name,
    `${domain.name}共 ${all.length} 門通識課程的學生評價，可依甜度、涼度、星級排序與篩選。`);

  const body = el('div', {});
  const status = el('p', { class: 'filter-note', role: 'status', 'aria-live': 'polite' });

  main.replaceChildren(el('div', { class: `wrap ${domainClass(domain.id)}` }, [
    el('header', { class: 'page-head is-domain' }, [
      el('p', { class: 'crumb' }, [el('a', { href: '#/' }, '首頁'), ' ／ 領域']),
      el('h1', {}, [
        domain.name,
        el('span', { class: 'sub num' }, `${all.length} 門課`),
      ]),
    ]),
    renderGroups(),
    renderControls(),
    status,
    body,
  ]));

  // ---------------------------------------------------------------- 分系按鈕

  /**
   * 「全部／醫學系 8／醫檢系 0⋯⋯」。數字是那個系的課程總數，不隨篩選條件變。
   * 點了只切換按下狀態、不重建按鈕 —— 重建會讓鍵盤焦點掉回頁首。
   */
  function renderGroups() {
    if (!groups.length) return null;

    const options = [
      { id: null, label: '全部', count: all.length },
      ...groups.map((g) => ({ id: g.id, label: g.name, count: all.filter(inGroup(g.id)).length })),
      ...(ungrouped.length ? [{ id: NO_GROUP, label: '未分系', count: ungrouped.length }] : []),
    ];

    const buttons = options.map((o) => el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(params.dept === o.id),
      onclick: () => {
        params.dept = o.id;
        buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].id === o.id)));
        syncUrl(buildHash(`/d/${domain.id}`, toQuery(params)));
        render();
      },
    }, [o.label, el('span', { class: 'chip-count num' }, String(o.count))]));

    return el('div', { class: 'chips', role: 'group', 'aria-label': '依系篩選' }, buttons);
  }

  // ------------------------------------------------------------------ 控制列

  function renderControls() {
    const onChange = () => {
      // 條件改變 → 鏡射到網址（不留歷史紀錄），畫面自己重畫。
      // 用 syncUrl 而不是 navigate：後者會重跑路由把整頁換掉，正在操作的
      // <select> 會變成新節點，焦點與展開中的選單都會掉。
      syncUrl(buildHash(`/d/${domain.id}`, toQuery(params)));
      render();
    };

    const select = (label, key, options) =>
      el('label', { class: 'control' }, [
        el('span', {}, label),
        el('select', {
          onchange: (e) => {
            const v = e.target.value;
            params[key] = v === '' ? null : (key === 'teacher' ? v : Number(v));
            onChange();
          },
        }, options.map(([v, t]) =>
          el('option', { value: v, selected: String(params[key] ?? '') === String(v) }, t))),
      ]);

    const thresholds = (max) => [['', '不限'],
      ...Array.from({ length: max }, (_, i) => [max - i, `${max - i} 以上`])];

    return el('div', { class: 'controls' }, [
      el('label', { class: 'control' }, [
        el('span', {}, '排序'),
        el('select', {
          onchange: (e) => { params.sort = e.target.value; params.dir = null; onChange(); },
        }, Object.entries(SORTS).map(([k, s]) =>
          el('option', { value: k, selected: params.sort === k }, s.label))),
      ]),
      select('最低星級', 'minStars', thresholds(5)),
      select('最低甜度', 'minSweet', thresholds(10)),
      select('最低涼度', 'minCool', thresholds(10)),
      select('教師', 'teacher', [['', '全部'], ...teachers.map((t) => [t, t])]),
      el('div', { class: 'control is-check' }, [
        el('input', {
          type: 'checkbox', id: 'has-reviews', checked: params.hasReviews,
          onchange: (e) => { params.hasReviews = e.target.checked; onChange(); },
        }),
        el('label', { for: 'has-reviews' }, '只看有心得的'),
      ]),
      el('button', {
        class: 'reset', type: 'button',
        onclick: () => {
          Object.assign(params, {
            sort: 'code', dir: null, minStars: null, minSweet: null,
            minCool: null, teacher: null, hasReviews: false,
          });
          // 選的系不算篩選條件，清除時留著，不然會被丟回「全部」。
          syncUrl(buildHash(`/d/${domain.id}`, toQuery(params)));
          renderAll();
        },
      }, '清除條件'),
    ]);
  }

  // -------------------------------------------------------------------- 表格

  function renderTable(rows, label = domain.name) {
    const cols = [
      { key: 'code', label: '代碼', cls: 'c-code' },
      { key: 'name', label: '課名', cls: 'c-name' },
      { key: null, label: '教師', cls: '' },
      { key: 'stars', label: '星級', cls: 'c-num' },
      { key: 'sweet', label: '甜度', cls: 'c-meter' },
      { key: 'cool', label: '涼度', cls: 'c-meter' },
      { key: 'count', label: '則數', cls: 'c-num' },
      { key: 'updated', label: '最近', cls: 'c-num' },
    ];

    const head = el('tr', {}, cols.map((c) => {
      if (!c.key) return el('th', { scope: 'col' }, c.label);
      const active = params.sort === c.key;
      const dir = active ? (params.dir ?? SORTS[c.key].dir) : null;
      return el('th', {
        scope: 'col',
        // aria-sort 讓螢幕閱讀器知道目前依哪一欄排序、方向為何。
        'aria-sort': active ? (dir === 'asc' ? 'ascending' : 'descending') : null,
      }, [
        el('button', {
          type: 'button',
          onclick: () => {
            if (params.sort === c.key) {
              params.dir = (params.dir ?? SORTS[c.key].dir) === 'asc' ? 'desc' : 'asc';
            } else {
              params.sort = c.key;
              params.dir = null;
            }
            syncUrl(buildHash(`/d/${domain.id}`, toQuery(params)));
            render();
          },
        }, [
          c.label,
          el('span', { class: 'arrow', 'aria-hidden': 'true' }, dir === 'asc' ? '▲' : '▼'),
        ]),
      ]);
    }));

    const body = rows.map((c) => {
      const st = courseStats(c);
      return el('tr', {}, [
        el('td', { class: `c-code${c.code ? '' : ' is-none'}` }, c.code ?? NONE),
        el('td', { class: 'c-name' },
          el('a', { href: courseHref(c) }, c.name ?? '（無課名）')),
        el('td', { class: c.teacher ? '' : 'is-none' }, c.teacher ?? NONE),
        el('td', { class: 'c-num' }, starsView(st.stars)),
        el('td', { class: 'c-meter' }, meterView('甜度', st.sweet.avg, { showLabel: false })),
        el('td', { class: 'c-meter' }, meterView('涼度', st.cool.avg, { showLabel: false })),
        el('td', { class: `c-num${st.count ? '' : ' is-none'}` }, st.count || NONE),
        el('td', { class: `c-num${st.termTo ? '' : ' is-none'}` },
          st.termTo ? formatTerm(st.termTo) : NONE),
      ]);
    });

    return el('div', { class: 'panel only-wide' }, [
      el('div', { class: 'table-wrap' },
        el('table', { class: 'data' }, [
          el('caption', { class: 'sr-only' },
            `${label}課程一覽，可依欄位排序。目前 ${rows.length} 門。`),
          el('thead', {}, head),
          el('tbody', {}, body),
        ])),
    ]);
  }

  // ------------------------------------------------------------------- 渲染

  function render() {
    const group = groups.find((g) => g.id === params.dept) ?? null;
    const scopeName = params.dept === null ? '' : (group ? group.name : '未分系');
    const scope = params.dept === null ? all : all.filter(inGroup(params.dept));

    let rows = filter(scope, params);
    rows = sort(rows, params.sort, params.dir);

    const filtered = rows.length !== scope.length;
    status.textContent = (scopeName ? `${scopeName} ` : '') + (filtered
      ? `${scope.length} 門課中符合條件的有 ${rows.length} 門`
      : `${scope.length} 門課`);

    if (!scope.length && scopeName) {
      replace(body, el('p', { class: 'empty' }, `還沒有${scopeName}的心得，修過的話歡迎投稿。`));
      return;
    }

    if (!rows.length) {
      replace(body, el('p', { class: 'empty' },
        '沒有課程符合這些條件。評分欄位缺項的課程不會通過「最低甜度／涼度」篩選 ——' +
        '因為那些課沒有人填過這一項，不是分數低。'));
      return;
    }

    // 有分系又選「全部」：依系分段，一個系一張表。這次篩完沒有課的系不出現。
    if (groups.length && params.dept === null) {
      const sections = [
        ...groups.map((g) => ({ name: g.name, list: rows.filter(inGroup(g.id)) })),
        { name: '未分系', list: rows.filter(inGroup(NO_GROUP)) },
      ].filter((s) => s.list.length);

      replace(body, sections.map((s) => el('section', { class: 'dept-group' }, [
        el('h2', { class: 'dept-head' }, [s.name, el('span', { class: 'sub num' }, `${s.list.length} 門`)]),
        renderTable(s.list, `${domain.name}・${s.name}`),
        el('div', { class: 'only-narrow' }, courseList(s.list, domainsById)),
      ])));
      return;
    }

    replace(body, [
      renderTable(rows, scopeName ? `${domain.name}・${scopeName}` : domain.name),
      el('div', { class: 'only-narrow' }, courseList(rows, domainsById)),
    ]);
  }

  function renderAll() {
    const head = main.querySelector('.controls');
    if (head) head.replaceWith(renderControls());
    render();
  }

  render();
}
