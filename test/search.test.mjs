// search.js 的單元測試（規格第十一節）。
//
// 中文沒有詞界，索引建在字與相鄰兩字上。這裡要守住三件事：
//   1. 部分比對真的有效（打「易經」找得到《易經與人生》）
//   2. n-gram 交集的偽陽性有被子字串驗證濾掉
//   3. 篩選時缺項不會被當成 0

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildIndex, query, filter, sort, SORTS } from '../js/search.js';

const course = (over) => ({
  id: over.code + '-' + over.teacher,
  code: null, name: '', teacher: '', domain: 'tian', reviews: [],
  ...over,
});

const review = (over = {}) => ({
  id: 'r' + Math.random().toString(36).slice(2, 8),
  term: '1101', stars: null, sweet: null, cool: null, grade: null,
  text: '內容', source: 'legacy', hidden: false, ...over,
});

const CORPUS = [
  course({ code: 'HE139A', name: '由電影認識亞洲諸宗教', teacher: '蔡維民' }),
  course({ code: 'HE118A', name: '易經與人生', teacher: '蕭旭府' }),
  course({ code: 'HE013A', name: '耶穌及基督教倫理觀(陳尚仁)', teacher: '陳尚仁' }),
  course({ code: 'HE013A', name: '耶穌及基督教倫理觀(張志偉)', teacher: '張志偉' }),
  course({ code: 'LN405A', name: '高階英文寫作', teacher: 'Jamie' }),
  course({ code: 'PE103A', name: '有氧舞蹈', teacher: '張育禛' }),
];

const idx = buildIndex(CORPUS);
const names = (r) => r.map((c) => c.name);

// ===========================================================================
test('normalize', () => {
  assert.equal(normalize('HE139A'), 'he139a', '轉小寫');
  assert.equal(normalize('HE 139 A'), 'he139a', '去空白');
  assert.equal(normalize('ＨＥ１３９Ａ'), 'he139a', '全形轉半形');
  assert.equal(normalize('耶穌及基督教倫理觀(陳尚仁)'), '耶穌及基督教倫理觀陳尚仁', '去括號');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

// ===========================================================================
test('query：基本比對', async (t) => {
  await t.test('沒有查詢時回傳 null，不是空陣列', () => {
    assert.equal(query(idx, ''), null, 'null 代表「沒有查詢」，[] 代表「查無結果」');
    assert.equal(query(idx, '   '), null);
    assert.equal(query(idx, null), null);
  });

  await t.test('課程代碼完全比對', () => {
    assert.deepEqual(names(query(idx, 'HE139A')), ['由電影認識亞洲諸宗教']);
  });

  await t.test('不分大小寫', () => {
    assert.deepEqual(names(query(idx, 'he139a')), ['由電影認識亞洲諸宗教']);
  });

  await t.test('忽略空白', () => {
    assert.deepEqual(names(query(idx, 'HE 139 A')), ['由電影認識亞洲諸宗教']);
  });

  await t.test('中文部分比對', () => {
    assert.deepEqual(names(query(idx, '易經')), ['易經與人生']);
    assert.deepEqual(names(query(idx, '人生')), ['易經與人生']);
  });

  await t.test('單一中文字也查得到', () => {
    assert.ok(names(query(idx, '經')).includes('易經與人生'));
  });

  await t.test('教師姓名', () => {
    assert.deepEqual(names(query(idx, '蔡維民')), ['由電影認識亞洲諸宗教']);
  });

  await t.test('英文教師姓名', () => {
    assert.deepEqual(names(query(idx, 'jamie')), ['高階英文寫作']);
  });

  await t.test('查無結果回傳空陣列', () => {
    assert.deepEqual(query(idx, '完全不存在的課程名稱'), []);
  });
});

test('query：同代碼不同教師，兩筆都要出現', () => {
  const hits = query(idx, 'HE013A');
  assert.equal(hits.length, 2, '這是全站最不能合併的情境');
  assert.deepEqual(hits.map((c) => c.teacher).sort(), ['張志偉', '陳尚仁']);
});

test('query：n-gram 交集的偽陽性要被濾掉', () => {
  // 「電影宗教」這四個字分別都出現在《由電影認識亞洲諸宗教》裡，
  // 但它們不是連續子字串。只靠 n-gram 交集會誤判為命中。
  assert.deepEqual(query(idx, '電影宗教'), [],
    'n-gram 交集後必須再做子字串驗證');

  // 反過來，真的是連續子字串就要命中
  assert.equal(query(idx, '認識亞洲').length, 1);
});

test('query：代碼完全命中排在部分命中前面', () => {
  const corpus = [
    course({ code: 'ZZ999A', name: '提到 PE103A 的課', teacher: '甲' }),
    course({ code: 'PE103A', name: '有氧舞蹈', teacher: '乙' }),
  ];
  const hits = query(buildIndex(corpus), 'PE103A');
  assert.equal(hits[0].code, 'PE103A', '代碼完全命中的那門要排第一');
});

test('query：同分時有心得的排前面', () => {
  const corpus = [
    course({ code: 'AA100A', name: '測試課程甲', teacher: '甲', reviews: [] }),
    course({ code: 'AA200A', name: '測試課程乙', teacher: '乙', reviews: [review(), review()] }),
  ];
  const hits = query(buildIndex(corpus), '測試課程');
  assert.equal(hits[0].name, '測試課程乙', '掃描的人不該先點到空課');
});

test('query：null 欄位不會讓索引爆掉', () => {
  const corpus = [
    course({ code: null, name: '健身太極武術', teacher: '黃玉萍' }),
    course({ code: 'AA100A', name: null, teacher: null }),
  ];
  const i = buildIndex(corpus);
  assert.equal(query(i, '太極').length, 1, '沒有代碼的課還是要查得到');
  assert.doesNotThrow(() => query(i, 'AA100A'));
});

// ===========================================================================
test('filter：缺項不會被當成 0', async (t) => {
  const withSweet = course({ code: 'AA100A', name: '有甜度', teacher: '甲', reviews: [review({ sweet: 8 })] });
  const noSweet = course({ code: 'AA200A', name: '沒甜度', teacher: '乙', reviews: [review({ stars: 5 })] });
  const zeroSweet = course({ code: 'AA300A', name: '甜度零', teacher: '丙', reviews: [review({ sweet: 0 })] });
  const all = [withSweet, noSweet, zeroSweet];

  await t.test('最低甜度 8：只有真的達標的通過', () => {
    assert.deepEqual(names(filter(all, { minSweet: 8 })), ['有甜度']);
  });

  await t.test('最低甜度 0：沒填的仍然不通過', () => {
    // 這是刻意的。「沒人填過甜度」不等於「甜度 0」，
    // 所以它不該出現在任何一個甜度條件的結果裡。
    const r = names(filter(all, { minSweet: 0 }));
    assert.ok(r.includes('甜度零'), '真的填 0 的要通過');
    assert.ok(!r.includes('沒甜度'), '沒填的不該被當成 0 而通過');
  });

  await t.test('沒有條件時全部通過', () => {
    assert.equal(filter(all, {}).length, 3);
  });

  await t.test('只看有心得的', () => {
    const empty = course({ code: 'AA400A', name: '無心得', teacher: '丁', reviews: [] });
    assert.equal(filter([...all, empty], { hasReviews: true }).length, 3);
  });

  await t.test('依教師篩選', () => {
    assert.deepEqual(names(filter(all, { teacher: '乙' })), ['沒甜度']);
  });
});

// ===========================================================================
test('sort：缺項沉底', async (t) => {
  const a = course({ code: 'AA100A', name: '五星', teacher: '甲', reviews: [review({ stars: 5 })] });
  const b = course({ code: 'AA200A', name: '一星', teacher: '乙', reviews: [review({ stars: 1 })] });
  const c = course({ code: 'AA300A', name: '沒評分', teacher: '丙', reviews: [review()] });
  const all = [a, b, c];

  await t.test('星級高到低', () => {
    assert.deepEqual(names(sort(all, 'stars', 'desc')), ['五星', '一星', '沒評分']);
  });

  await t.test('星級低到高：沒評分的仍在最後', () => {
    assert.deepEqual(names(sort(all, 'stars', 'asc')), ['一星', '五星', '沒評分'],
      '沒評分若被當成 0，升冪時會排到「一星」前面');
  });

  await t.test('依代碼', () => {
    assert.deepEqual(names(sort(all, 'code', 'asc')), ['五星', '一星', '沒評分']);
  });

  await t.test('不認識的排序鍵原樣回傳', () => {
    assert.equal(sort(all, '不存在的鍵'), all);
  });

  await t.test('sort 不改動原陣列', () => {
    const before = [...all];
    sort(all, 'stars', 'desc');
    assert.deepEqual(all, before);
  });
});

test('SORTS：規格第五節列出的七種排序都在', () => {
  assert.deepEqual(Object.keys(SORTS),
    ['code', 'name', 'stars', 'sweet', 'cool', 'count', 'updated']);
  for (const [key, spec] of Object.entries(SORTS)) {
    assert.equal(typeof spec.label, 'string', `${key} 要有 label`);
    assert.equal(typeof spec.value, 'function', `${key} 要有 value`);
    assert.ok(['asc', 'desc'].includes(spec.dir), `${key} 的預設方向要合法`);
  }
});

// ===========================================================================
test('效能：1000 門課的查詢要在 16ms 內完成（規格第十節）', () => {
  const big = [];
  while (big.length < 1000) {
    for (const c of CORPUS) {
      if (big.length >= 1000) break;
      big.push({ ...c, id: c.id + '-' + big.length });
    }
  }
  const i = buildIndex(big);

  let worst = 0;
  for (const q of ['易經', 'HE139A', '陳', '英文', '宗教', 'PE']) {
    const t0 = performance.now();
    query(i, q);
    worst = Math.max(worst, performance.now() - t0);
  }
  assert.ok(worst < 16, `最慢的查詢用了 ${worst.toFixed(2)}ms，上限 16ms`);
});
