// 介面說明頁。
//
// 規格第五節：用真實範例逐項標示各欄位意義，明確定義甜度與涼度，說明
// 樣本數少時如何解讀，並寫出免責聲明。
//
// 「真實範例」是認真的 —— 底下每一個示範都是從 courses.json 撈出來的
// 實際課程，不是編的假資料。編假資料的說明頁會跟真實畫面長得不一樣，
// 讀者對照不起來，等於白寫。

import { el } from '../dom.js';
import { setMeta } from '../router.js';
import * as store from '../store.js';
import { starsView, meterView, termBadge, courseHref, domainClass } from '../ui.js';
import { courseStats, LOW_SAMPLE } from '../format.js';

/** 找一門符合條件的真課，找不到就回 null（說明頁自己會略過那一段）。 */
function pick(test) {
  return store.getCourses().find(test) ?? null;
}

export default async function guide() {
  setMeta('介面說明',
    '甜度、涼度、星級各代表什麼？樣本數少的時候怎麼看？這一頁用站上的真實資料逐項說明。');

  // 各挑一門真實課程來示範。
  // 甜度與涼度刻意挑差距大的那門 —— 兩條量表長得一樣的話，
  // 讀者看不出那是兩個不同的欄位。
  const complete = (c) => {
    const s = courseStats(c);
    return s.count >= 4 && s.sweet.avg !== null && s.cool.avg !== null && s.grade.avg !== null;
  };
  const rich =
    pick((c) => complete(c) && Math.abs(courseStats(c).sweet.avg - courseStats(c).cool.avg) >= 2)
    ?? pick(complete);
  const sparse = pick((c) => {
    const s = courseStats(c);
    return s.count > 0 && s.count < LOW_SAMPLE && s.sweet.avg === null;
  });

  const demo = (course, children) => el('div', {
    class: `field-demo ${domainClass(course.domain)}`,
  }, [
    ...children,
    el('a', { class: 'from', href: courseHref(course) },
      `取自《${course.name}》→`),
  ]);

  const richStats = rich ? courseStats(rich) : null;
  const sparseStats = sparse ? courseStats(sparse) : null;

  document.getElementById('main').replaceChildren(
    el('div', { class: 'wrap' }, el('article', { class: 'prose' }, [
      el('h1', {}, '介面說明'),
      el('p', { class: 'lede' },
        '這個站收的是學生自己寫的修課心得。下面說明每個欄位的意思，' +
        '以及什麼情況下不該太相信它。'),

      // ------------------------------------------------------------ 欄位
      el('h2', {}, '欄位的意思'),

      el('dl', {}, [
        rich ? el('div', { class: 'field' }, [
          demo(rich, [starsView(richStats.stars)]),
          el('dt', {}, '星級（0–5）'),
          el('dd', {}, '整體推薦程度。'),
        ]) : null,

        rich ? el('div', { class: 'field' }, [
          demo(rich, [meterView('甜度', richStats.sweet.avg)]),
          el('dt', {}, '甜度（0–10）＝ 給分寬鬆程度'),
          el('dd', {}, '數字越高代表老師給分越寬鬆、越容易拿高分。'),
        ]) : null,

        rich ? el('div', { class: 'field' }, [
          demo(rich, [meterView('涼度', richStats.cool.avg)]),
          el('dt', {}, '涼度（0–10）＝ 課業負擔輕重'),
          el('dd', {}, '數字越高代表越輕鬆：作業少、不點名、不用做報告、不用考試。'),
        ]) : null,

        rich && richStats.grade.avg !== null ? el('div', { class: 'field' }, [
          demo(rich, [
            el('span', { class: 'stat-value num' }, richStats.grade.avg.toFixed(1) + ' 分'),
            el('span', { class: 'stat-sample' }, `／ ${richStats.grade.n} 則`),
          ]),
          el('dt', {}, '分數'),
          el('dd', {}, '填寫的同學該學期實際拿到的學期成績。'),
        ]) : null,

        rich ? el('div', { class: 'field' }, [
          demo(rich, [termBadge(richStats.termTo)]),
          el('dt', {}, '學期'),
          el('dd', {}, '舊內容因年代久遠，多少會有失真狀況，請自行留意。'),
        ]) : null,
      ]),

      // -------------------------------------------------- 缺項與樣本數
      el('h2', {}, '「—」不是零'),
      el('p', {},
        '舊站的心得很多只填了學期和星級，甜度、涼度、分數大量從缺。' +
        '這個站不會替沒填的欄位補上平均值或 0，因為那等於替那位同學回答' +
        '他沒有回答的問題。'),

      el('div', { class: 'compare' }, [
        el('div', {}, [
          el('h3', {}, '空的量表 + 「—」'),
          sparse
            ? el('div', { style: 'margin-bottom:var(--s2)' },
                el('span', { class: domainClass(sparse.domain) },
                  meterView('甜度', null)))
            : null,
          el('p', {}, '沒有人填過這一項。不知道，不代表低。'),
        ]),
        el('div', {}, [
          el('h3', {}, '填滿到底的量表'),
          rich
            ? el('div', { style: 'margin-bottom:var(--s2)' },
                el('span', { class: domainClass(rich.domain) },
                  meterView('甜度', 10)))
            : null,
          el('p', {}, '有人填了，而且填的是 10。'),
        ]),
      ]),

      el('p', {},
        '兩者在畫面上刻意長得不一樣：缺項的量表整條全空、旁邊標「—」，' +
        '整門課都沒資料時直接寫「尚無資料」。排序時缺項一律沉底，' +
        '不會被當成 0 排在最差的位置。'),

      el('h2', {}, '樣本數怎麼看'),
      el('p', {},
        '每一項統計旁邊都寫著它是幾則心得算出來的。這個數字比平均值本身重要。'),
      el('ul', {}, [
        el('li', {}, [
          el('strong', {}, `少於 ${LOW_SAMPLE} 則：`),
          '當成「有一個人這樣說」，不要當成這門課的性質。站上會標「樣本數不足，僅供參考」。',
          sparse ? el('span', {}, `例如《${sparse.name}》目前只有 ${sparseStats.count} 則。`) : null,
        ]),
        el('li', {}, [
          el('strong', {}, '3 到 5 則：'),
          '可以看出大致方向，但一個極端評價就能把平均拉走一大截。',
        ]),
        el('li', {}, [
          el('strong', {}, '超過 5 則：'),
          '比較穩，但仍然要看心得內容 —— 同一門課給 5 星和 2 星的人，理由往往完全不同。',
        ]),
      ]),
      el('p', {},
        '還有一件事統計看不出來：會特地回來寫心得的人，通常是特別滿意或特別不滿的人。' +
        '覺得普通的多數不會留下紀錄。'),

      el('h2', {}, '同一個課號可能有兩門課'),
      el('p', {},
        '同一個課程代碼由不同老師開課時，站上是兩筆獨立的課程，評價完全不共用。' +
        '選課前請確認你選到的是哪一位老師的班 —— 兩位老師的甜度差 5 分是常有的事。'),

      // ---------------------------------------------------------- 免責
      el('aside', { class: 'disclaimer-box' }, [
        el('h2', {}, '免責聲明'),
        el('p', {}, '所有心得都是學生個人的主觀經驗，不是學校的官方資料，' +
          '也未經任何查證。'),
        el('p', {}, '課程內容、授課教師、評分方式可能逐年變動。舊學期的心得' +
          '不保證適用於這學期。'),
        el('p', {}, '請把這裡的資料當成參考之一，而不是選課的唯一依據。' +
          '真正的課程資訊以學校教務系統與課程大綱為準。'),
      ]),
    ])),
  );
}
