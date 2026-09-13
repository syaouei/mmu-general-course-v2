// format.js 的單元測試（規格第十一節）。
//
// 重點在「缺項」。規格第三節說缺項一律 null、統計不得回傳 0，而那是整個
// 資料模型最容易在重構時悄悄壞掉的地方 —— 壞掉之後畫面不會報錯，只會把
// 「沒人填過涼度」顯示成「涼度 0」，然後有人照著這個數字選錯課。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NONE, NO_DATA, LOW_SAMPLE,
  formatTerm, termOrder, average, courseStats, formatStat, formatValue,
  formatSample, isLowSample, formatTermRange, comparator, sortKey,
  starsLabel, meterLabel, visibleReviews,
} from '../js/format.js';

const review = (over = {}) => ({
  id: over.id ?? 'r' + Math.random().toString(36).slice(2, 8),
  term: '1101', stars: null, sweet: null, cool: null, grade: null,
  text: '內容', source: 'legacy', hidden: false,
  ...over,
});

const course = (reviews) => ({ id: 'C', code: 'HE001A', name: '課', teacher: '師', domain: 'tian', reviews });

// ===========================================================================
test('formatTerm', async (t) => {
  await t.test('4 位數學期', () => {
    assert.equal(formatTerm('1101'), '110-1');
    assert.equal(formatTerm('1112'), '111-2');
  });

  await t.test('3 位數學期（99 學年以前）', () => {
    assert.equal(formatTerm('991'), '99-1');
  });

  await t.test('數字型別也吃得下', () => {
    assert.equal(formatTerm(1101), '110-1');
  });

  await t.test('無效值一律 NONE，不硬拆', () => {
    for (const bad of [null, undefined, '', '11', '11011', 'abcd', '11a1', {}, []]) {
      assert.equal(formatTerm(bad), NONE, `formatTerm(${JSON.stringify(bad)})`);
    }
  });
});

test('termOrder：無效值排到最後', () => {
  assert.ok(termOrder('1112') > termOrder('1111'));
  assert.ok(termOrder('1111') > termOrder('991'));
  assert.equal(termOrder(null), -Infinity);
  assert.equal(termOrder('abc'), -Infinity);
});

// ===========================================================================
test('average', async (t) => {
  await t.test('空陣列回傳 avg null、n 0 —— 不是 0', () => {
    const r = average([]);
    assert.equal(r.avg, null);
    assert.equal(r.n, 0);
    assert.notEqual(r.avg, 0, 'avg 絕不可以是 0');
  });

  await t.test('全部 null 回傳 avg null', () => {
    const r = average([null, null, null]);
    assert.equal(r.avg, null);
    assert.equal(r.n, 0);
  });

  await t.test('null 不進分母', () => {
    const r = average([4, null, 6, null]);
    assert.equal(r.avg, 5);
    assert.equal(r.n, 2, '分母只能算有值的那兩筆');
  });

  await t.test('0 是有效值，不等於缺項', () => {
    const r = average([0, 0]);
    assert.equal(r.avg, 0);
    assert.equal(r.n, 2, '填了 0 的人有表達意見，要計入樣本數');
  });

  await t.test('NaN、undefined、字串都跳過', () => {
    const r = average([5, NaN, undefined, '7', null]);
    assert.equal(r.avg, 5);
    assert.equal(r.n, 1);
  });
});

// ===========================================================================
test('courseStats：評分欄位缺項的全部 16 種組合', () => {
  const FIELDS = ['stars', 'sweet', 'cool', 'grade'];

  // 四個欄位各自有值／沒值 = 2^4 = 16 種組合，逐一驗證。
  for (let mask = 0; mask < 16; mask++) {
    const present = FIELDS.filter((_, i) => mask & (1 << i));
    const over = {};
    for (const f of present) over[f] = f === 'grade' ? 90 : 5;

    const st = courseStats(course([review(over)]));

    for (const f of FIELDS) {
      const has = present.includes(f);
      if (has) {
        assert.equal(st[f].n, 1, `${f} 有值時 n 應為 1（組合 ${present.join('+') || '全空'}）`);
        assert.ok(st[f].avg !== null, `${f} 有值時 avg 不該是 null`);
      } else {
        assert.equal(st[f].n, 0, `${f} 缺項時 n 應為 0`);
        assert.equal(st[f].avg, null,
          `${f} 缺項時 avg 必須是 null，實際是 ${st[f].avg}（組合 ${present.join('+') || '全空'}）`);
        assert.notEqual(st[f].avg, 0, `${f} 缺項時 avg 絕不可以是 0`);
      }
    }
    assert.equal(st.count, 1, '則數與評分缺不缺項無關');
  }
});

test('courseStats：全部為 null 時統計不得回傳 0', () => {
  const st = courseStats(course([review(), review(), review()]));
  for (const f of ['stars', 'sweet', 'cool', 'grade']) {
    assert.equal(st[f].avg, null, `${f}.avg 必須是 null`);
    assert.equal(st[f].n, 0, `${f}.n 必須是 0`);
    assert.notEqual(st[f].avg, 0, `${f}.avg 是 0 的話，UI 會把「沒人填」顯示成「0 分」`);
  }
  assert.equal(st.count, 3, '有三則心得，只是都沒填評分');
});

test('courseStats：各欄位的樣本數彼此獨立', () => {
  // 一門課可能有 5 則星級但只有 1 則甜度 —— 這在舊站資料裡是常態。
  const st = courseStats(course([
    review({ stars: 5, sweet: 8 }),
    review({ stars: 4 }),
    review({ stars: 3 }),
  ]));
  assert.equal(st.stars.n, 3);
  assert.equal(st.sweet.n, 1);
  assert.equal(st.cool.n, 0);
  assert.equal(st.sweet.avg, 8);
  assert.equal(st.cool.avg, null);
});

test('courseStats：hidden 的心得不計入統計也不計入則數', () => {
  const st = courseStats(course([
    review({ stars: 5 }),
    review({ stars: 1, hidden: true }),
  ]));
  assert.equal(st.count, 1, 'hidden 不計入則數');
  assert.equal(st.stars.n, 1, 'hidden 不計入樣本數');
  assert.equal(st.stars.avg, 5, 'hidden 的 1 星不該把平均拉低');
});

test('courseStats：學期範圍', () => {
  const st = courseStats(course([
    review({ term: '1112' }), review({ term: '1091' }), review({ term: '1101' }),
  ]));
  assert.equal(st.termFrom, '1091');
  assert.equal(st.termTo, '1112');
  assert.equal(formatTermRange(st), '109-1 – 111-2');
});

test('formatTermRange：只有一個學期時不顯示範圍', () => {
  const st = courseStats(course([review({ term: '1101' }), review({ term: '1101' })]));
  assert.equal(formatTermRange(st), '110-1');
});

test('formatTermRange：完全沒有學期時是「尚無資料」', () => {
  const st = courseStats(course([review({ term: null })]));
  assert.equal(formatTermRange(st), NO_DATA);
});

// ===========================================================================
test('formatStat / formatValue：缺項的顯示', async (t) => {
  await t.test('統計缺項顯示「尚無資料」而不是 0', () => {
    assert.equal(formatStat({ avg: null, n: 0 }), NO_DATA);
    assert.equal(formatStat(null), NO_DATA);
    assert.equal(formatStat(undefined), NO_DATA);
  });

  await t.test('統計值為 0 時要顯示 0，不能變成「尚無資料」', () => {
    assert.equal(formatStat({ avg: 0, n: 2 }), '0', '有人填 0 跟沒人填是兩回事');
  });

  await t.test('單一欄位缺項顯示「—」', () => {
    assert.equal(formatValue(null), NONE);
    assert.equal(formatValue(undefined), NONE);
    assert.equal(formatValue(NaN), NONE);
  });

  await t.test('單一欄位為 0 時顯示 0', () => {
    assert.equal(formatValue(0), '0');
  });

  await t.test('多餘的小數點被收掉', () => {
    assert.equal(formatStat({ avg: 4, n: 1 }, 1), '4');
    assert.equal(formatStat({ avg: 4.5, n: 2 }, 1), '4.5');
    assert.equal(formatValue(97, 2), '97');
    assert.equal(formatValue(94.88, 2), '94.88', '學生填的原始分數不該被四捨五入');
    assert.equal(formatValue(97.7, 2), '97.7');
  });
});

test('formatSample / isLowSample', () => {
  assert.equal(formatSample(4), '／ 4 則');
  assert.equal(isLowSample(0), false, '完全沒有樣本不算「樣本數不足」，那是「尚無資料」');
  assert.equal(isLowSample(1), true);
  assert.equal(isLowSample(LOW_SAMPLE - 1), true);
  assert.equal(isLowSample(LOW_SAMPLE), false);
});

// ===========================================================================
test('comparator：null 永遠沉底，與排序方向無關', async (t) => {
  const items = [{ v: 3 }, { v: null }, { v: 5 }, { v: null }, { v: 1 }];
  const get = (x) => x.v;

  await t.test('降冪', () => {
    const sorted = [...items].sort(comparator(get, 'desc')).map(get);
    assert.deepEqual(sorted, [5, 3, 1, null, null]);
  });

  await t.test('升冪：null 仍然在最後，不會跑到最前面', () => {
    const sorted = [...items].sort(comparator(get, 'asc')).map(get);
    assert.deepEqual(sorted, [1, 3, 5, null, null],
      'null 若被當成 0 排序，升冪時會排在 1 前面');
  });

  await t.test('0 不是 null，要正常參與排序', () => {
    const withZero = [{ v: 2 }, { v: null }, { v: 0 }];
    const sorted = withZero.sort(comparator(get, 'asc')).map(get);
    assert.deepEqual(sorted, [0, 2, null]);
  });
});

test('sortKey：把 {avg,n} 轉成可比較的值', () => {
  assert.equal(sortKey({ avg: 4.2, n: 3 }), 4.2);
  assert.equal(sortKey({ avg: null, n: 0 }), null);
  assert.equal(sortKey(null), null);
});

// ===========================================================================
test('無障礙描述不得把缺項唸成 0', async (t) => {
  await t.test('星級', () => {
    assert.match(starsLabel({ avg: null, n: 0 }), /尚無資料/);
    assert.doesNotMatch(starsLabel({ avg: null, n: 0 }), /0/);
    assert.match(starsLabel({ avg: 4.3, n: 3 }), /4\.3.*3 則/);
  });

  await t.test('量表', () => {
    assert.match(meterLabel('甜度', null), /尚無資料/);
    assert.doesNotMatch(meterLabel('甜度', null), /\b0\b/);
  });

  await t.test('量表的平均值不會唸出 16 位小數', () => {
    assert.equal(meterLabel('甜度', 9.666666666666666), '甜度 9.7，滿分 10');
    assert.equal(meterLabel('甜度', 10), '甜度 10，滿分 10');
  });

  await t.test('量表值為 0 時要唸出 0', () => {
    assert.match(meterLabel('涼度', 0), /涼度 0/);
  });
});

// ===========================================================================
test('visibleReviews：過濾 hidden 且容忍壞資料', () => {
  assert.deepEqual(visibleReviews(null), []);
  assert.deepEqual(visibleReviews({}), []);
  assert.equal(visibleReviews(course([review(), review({ hidden: true })])).length, 1);
  assert.equal(
    visibleReviews(course([review({ hidden: false }), review({ hidden: undefined })])).length, 2,
    'hidden 不是 true 就當成可見',
  );
});
