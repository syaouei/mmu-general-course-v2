// 課程頁 —— 螢光筆皮膚。
//
// 細讀任務（規格第五、八節）：鎖定兩三門後，把每則心得讀完判斷雷點。
// 所以淺色紙、課名一道筆痕、沒有卡片只有髮絲線、留白多。
//
// 統計每一項都標樣本數，少於 3 則明講「僅供參考」。缺項顯示「尚無資料」
// 而不是 0 —— 誤把「沒人填」讀成「涼度 0」會直接害人選錯課。

import { el, replace, multiline } from '../dom.js';
import { setMeta, setJsonLd } from '../router.js';
import * as store from '../store.js';
import {
  courseHref, domainTag, domainClass, starsView, meterView, termBadge, statCell,
} from '../ui.js';
import {
  courseStats, visibleReviews, formatTermRange, formatValue,
  isLowSample, termOrder, comparator, NONE, NO_DATA, LOW_SAMPLE,
} from '../format.js';

const READING_KEY = 'mmu:reading';

const SORTS = {
  new: { label: '新到舊', cmp: (a, b) => termOrder(b.term) - termOrder(a.term) },
  old: { label: '舊到新', cmp: (a, b) => termOrder(a.term) - termOrder(b.term) },
  stars: { label: '星級高到低', cmp: comparator((r) => r.stars, 'desc') },
};

/** localStorage 在私密視窗或關閉 cookie 時會直接丟例外，一律包起來。 */
function readReading() {
  try { return localStorage.getItem(READING_KEY) === 'on'; } catch { return false; }
}
function writeReading(on) {
  try { localStorage.setItem(READING_KEY, on ? 'on' : 'off'); } catch { /* 記不住就算了 */ }
}

export default async function courseView(ctx) {
  const main = document.getElementById('main');
  const course = store.getCourse(ctx.params.id);

  if (!course) {
    setMeta('找不到課程', '這門課不存在。');
    main.replaceChildren(el('div', { class: 'wrap' }, [
      el('p', { class: 'empty' }, [
        el('strong', {}, '找不到這門課'),
        el('br'),
        el('code', {}, ctx.params.id),
        el('br'), el('br'),
        el('a', { href: '#/' }, '← 回首頁'),
      ]),
    ]));
    return;
  }

  const domain = store.getDomain(course.domain);
  const st = courseStats(course);
  const reviews = visibleReviews(course);
  const config = store.getState().config ?? {};

  const title = [course.code, course.name].filter(Boolean).join('｜');
  setMeta(title,
    `${course.name ?? ''}（${course.teacher ?? '教師不明'}）的學生評價，` +
    `共 ${st.count} 則心得。` +
    (st.stars.avg !== null ? `平均 ${st.stars.avg.toFixed(1)} 星。` : ''));

  // 結構化資料（規格第九節）。
  //
  // aggregateRating 只在真的有評分時才輸出 —— 沒有樣本卻宣告 ratingValue: 0
  // 等於告訴 Google「這門課評價是 0 分」，那是把「沒有資料」謊報成「最低分」。
  // 這是整個資料模型那條規則在結構化資料上的同一個要求。
  setJsonLd({
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: course.name ?? course.code ?? '未命名課程',
    ...(course.code ? { courseCode: course.code } : {}),
    description: `${course.name ?? ''}的學生修課心得，共 ${st.count} 則。`,
    url: location.href,
    inLanguage: 'zh-Hant',
    provider: {
      '@type': 'CollegeOrUniversity',
      name: '馬偕醫學大學',
      alternateName: 'MacKay Medical University',
    },
    ...(course.teacher ? { instructor: { '@type': 'Person', name: course.teacher } } : {}),
    ...(st.stars.avg !== null && st.stars.n > 0 ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: Number(st.stars.avg.toFixed(2)),
        ratingCount: st.stars.n,
        reviewCount: st.count,
        bestRating: 5,
        worstRating: 0,
      },
    } : {}),
  });

  let sortKey = 'new';
  let reading = readReading();

  const listBox = el('div', { class: 'reviews' });
  const page = el('div', {
    class: `wrap course-page ${domainClass(course.domain)}`,
    dataset: { reading: reading ? 'on' : 'off' },
  });

  // ------------------------------------------------------------------ 頁首

  const copyNote = el('span', { class: 'copied', role: 'status', 'aria-live': 'polite' });

  const readingBtn = el('button', {
    class: 'linkbtn', type: 'button',
    'aria-pressed': String(reading),
    onclick: () => {
      reading = !reading;
      writeReading(reading);
      page.dataset.reading = reading ? 'on' : 'off';
      readingBtn.setAttribute('aria-pressed', String(reading));
      readingBtn.textContent = reading ? '關閉閱讀模式' : '閱讀模式';
    },
  }, reading ? '關閉閱讀模式' : '閱讀模式');

  const head = el('header', { class: 'course-head' }, [
    el('p', { class: 'crumb' }, [
      el('a', { href: '#/' }, '首頁'), ' ／ ',
      domain ? el('a', { href: `#/d/${domain.id}` }, domain.name) : '未分類',
    ]),
    course.code
      ? el('span', { class: 'code' }, course.code)
      : el('span', { class: 'code is-none' }, '無課程代碼'),
    el('h1', {}, el('span', { class: 'course-name' }, course.name ?? '（無課名）')),
    el('div', { class: 'meta' }, [
      course.teacher
        ? el('span', {}, course.teacher)
        : el('span', { class: 'is-none' }, '教師不明'),
      domainTag(domain),
      el('span', { class: 'actions' }, [
        readingBtn,
        el('button', {
          class: 'linkbtn', type: 'button',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(location.href);
              copyNote.textContent = '已複製';
            } catch {
              copyNote.textContent = location.href;
            }
            setTimeout(() => { copyNote.textContent = ''; }, 2500);
          },
        }, '複製連結'),
        copyNote,
      ]),
    ]),
    course.needsReview
      ? el('p', { class: 'notice' },
          '這門課的課程資訊來自舊站未填寫的樣板（' + course.needsReview.join('、') +
          '），心得本身是真實的，但課名與代碼待確認。')
      : null,
  ]);

  // -------------------------------------------------------------- 統計摘要

  const stats = st.count === 0
    ? el('p', { class: 'empty' }, '這門課還沒有任何心得。')
    : el('section', { 'aria-label': '統計摘要' }, [
        el('div', { class: 'stats' }, [
          statCell('平均星級', st.stars),
          statCell('平均分數', st.grade, { digits: 1, suffix: ' 分' }),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-label' }, '心得則數'),
            el('div', { class: 'stat-value num' }, String(st.count)),
            el('div', { class: 'stat-sample' },
              isLowSample(st.count)
                ? el('span', { class: 'low-sample' }, `樣本數不足 ${LOW_SAMPLE} 則，僅供參考`)
                : ''),
          ]),
          el('div', { class: 'stat' }, [
            el('div', { class: 'stat-label' }, '學期範圍'),
            el('div', { class: `stat-value num${st.termFrom ? '' : ' is-none'}` },
              formatTermRange(st)),
            el('div', { class: 'stat-sample' }, ''),
          ]),
        ]),
        el('div', { class: 'stat-meters' }, [
          meterRow('甜度', st.sweet),
          meterRow('涼度', st.cool),
        ]),
      ]);

  /** 量表 + 樣本數。整項全缺時明講「尚無資料」，不畫成空的十格。 */
  function meterRow(name, stat) {
    return el('div', {}, [
      meterView(name, stat.avg),
      el('span', { class: 'stat-sample' },
        stat.avg === null ? `　${NO_DATA}` : `　／ ${stat.n} 則`),
    ]);
  }

  // -------------------------------------------------------------- 心得列表

  /**
   * 回報連結。
   *
   * 優先用 reportPrefillUrl —— 那是 scripts/create-forms.gs 產生的預填
   * 網址範本，裡面的 __REVIEW_ID__ 換成心得 id 後，表單的「心得編號」
   * 欄位會自動帶入。Google 表單的預填參數是 entry.<數字ID>，不是我們
   * 自己取的名字，所以不能用 searchParams 硬加一個 review=。
   *
   * 沒設定範本就退回純表單網址，回報者自己描述是哪一則。
   */
  function reportHref(review) {
    const tpl = config.forms?.reportPrefillUrl;
    if (tpl && tpl.includes('__REVIEW_ID__')) {
      return tpl.replace('__REVIEW_ID__', encodeURIComponent(review.id));
    }
    return config.forms?.reportUrl || null;
  }

  function renderReview(r) {
    const href = reportHref(r);
    return el('article', { class: 'review', id: r.id }, [
      el('div', { class: 'review-meta' }, [
        termBadge(r.term),
        starsView(r.stars === null ? null : { avg: r.stars, n: 1 }, { single: true }),
        meterView('甜度', r.sweet),
        meterView('涼度', r.cool),
        // 單一則是這位學生填的原始分數，不是平均，所以照原值顯示到小數第二位
        // （trimZero 會把 97.00 收成 97）。四捨五入會改掉學生寫的數字。
        el('span', { class: r.grade === null ? 'is-none' : 'num' },
          r.grade === null ? `分數 ${NONE}` : `${formatValue(r.grade, 2)} 分`),
      ]),
      // 內文一律走 textContent，換行用 <br> 而不是解析標記。
      el('div', { class: 'review-body' }, multiline(r.text)),
      el('div', { class: 'review-foot' }, [
        r.editedAt ? el('span', {}, '（經後台編輯）') : null,
        href
          ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, '回報不當內容')
          : el('a', { href: '#/about' }, '回報不當內容'),
      ]),
    ]);
  }

  function renderList() {
    const rows = [...reviews].sort(SORTS[sortKey].cmp);
    replace(listBox, rows.map(renderReview));
  }

  const listHead = st.count === 0 ? null : el('div', { class: 'section-head' }, [
    el('h2', {}, '心得'),
    el('span', { class: 'count num' }, `${st.count} 則`),
    el('label', { class: 'control', style: 'margin-left:auto' }, [
      el('span', {}, '排序'),
      el('select', {
        onchange: (e) => { sortKey = e.target.value; renderList(); },
      }, Object.entries(SORTS).map(([k, s]) =>
        el('option', { value: k, selected: sortKey === k }, s.label))),
    ]),
  ]);

  // ------------------------------------------------------------ 相關課程

  const sameDomain = store.coursesInDomain(course.domain)
    .filter((c) => c.id !== course.id)
    .slice(0, 6);

  const sameTeacher = course.teacher
    ? store.getCourses().filter((c) => c.id !== course.id && c.teacher === course.teacher)
    : [];

  const relatedList = (courses) => el('ul', { class: 'result-list' },
    courses.map((c) => el('li', {},
      el('a', { class: `result-row ${domainClass(c.domain)}`, href: courseHref(c) }, [
        el('span', { class: `code${c.code ? '' : ' is-none'}` }, c.code ?? NONE),
        el('span', { class: 'title' }, c.name ?? '（無課名）'),
        el('span', { class: 'sub' }, [
          domainTag(store.getDomain(c.domain)),
          c.teacher ? el('span', {}, c.teacher) : null,
        ]),
        el('span', { class: 'right' }, [
          starsView(courseStats(c).stars),
          el('span', { class: 'num' }, `${courseStats(c).count} 則`),
        ]),
      ]))));

  const related = el('div', { class: 'related' }, [
    sameTeacher.length
      ? el('section', {}, [
          el('h2', {}, `${course.teacher} 的其他課程`),
          relatedList(sameTeacher),
        ])
      : null,
    sameDomain.length && domain
      ? el('section', { style: 'margin-top:var(--s5)' }, [
          el('h2', {}, `${domain.name}的其他課程`),
          relatedList(sameDomain),
          el('p', { style: 'margin-top:var(--s3)' },
            el('a', { href: `#/d/${domain.id}` }, `查看${domain.name}全部課程 →`)),
        ])
      : null,
  ]);

  page.append(head, stats, ...(listHead ? [listHead] : []), listBox, related);
  main.replaceChildren(page);
  renderList();
}
