// 品質閘與投稿管線的單元測試。
//
// 這是這個站唯一的濫用防線（沒有人工審核），而且同一份程式碼同時跑在
// 瀏覽器與 GitHub Actions 上。它壞掉的話沒有任何東西會報錯 ——
// 只會有不該出現的內容出現在站上，或該出現的內容被默默擋掉。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toRecords, parseRecords, normalizeHeader, pick } from '../js/csv.js';
import {
  LIMITS, maskPii, parseBlocklist, findBlocked, similarity,
  parseOptionalNumber, gateOne, gateBatch,
} from '../js/gate.js';
import {
  stableId, teacherSlug, recordToFields, parseTimestamp,
  mergeSubmissions, courseKey, unknownHeaders, piiHeaders,
} from '../js/submissions.js';

const DOMAINS = new Set(['天領域', '地領域', '人領域', '心領域', '系選修', '體育類', '語言類', '其他類']);

const good = (over = {}) => ({
  timestamp: '2026/9/13 上午 10:00:00',
  domain: '天領域', code: 'HE139A', name: '由電影認識亞洲諸宗教',
  teacher: '蔡維民', term: '1141',
  stars: '5', sweet: '9', cool: '7', grade: '92',
  text: '老師人很好，每週看一部電影寫心得，作業不多但要認真寫。',
  ...over,
});

// ===========================================================================
test('CSV 解析', async (t) => {
  await t.test('引號內的逗號不會被當成欄位分隔', () => {
    const rows = parseCsv('a,b\n"含,逗號",second');
    assert.deepEqual(rows[1], ['含,逗號', 'second']);
  });

  await t.test('"" 是跳脫的雙引號', () => {
    const rows = parseCsv('a\n"他說""這門課很甜"""');
    assert.deepEqual(rows[1], ['他說"這門課很甜"']);
  });

  await t.test('引號內的換行保留在同一個欄位', () => {
    const rows = parseCsv('a,b\n"第一行\n第二行",x');
    assert.equal(rows.length, 2, '引號內的換行不該切出新的一列');
    assert.equal(rows[1][0], '第一行\n第二行');
  });

  await t.test('CRLF', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
  });

  await t.test('開頭的 BOM 被吃掉', () => {
    assert.equal(parseCsv('﻿時間戳記,領域')[0][0], '時間戳記');
  });

  await t.test('全空的列被丟掉', () => {
    assert.equal(parseCsv('a,b\n1,2\n,\n\n').length, 2);
  });

  await t.test('空輸入不會爆', () => {
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseRecords('').records, []);
  });
});

test('欄位名正規化：表單標題常常帶提示字', () => {
  assert.equal(normalizeHeader('甜度(請填數字)'), '甜度');
  assert.equal(normalizeHeader('甜度（請填數字）'), '甜度');
  assert.equal(normalizeHeader('課程代碼 *'), '課程代碼');
  assert.equal(normalizeHeader(' 星級 '), '星級');

  const rec = { '甜度(請填數字)': '8', '課程代碼 *': 'HE139A' };
  assert.equal(pick(rec, '甜度'), '8', '比對不該因為多了括號就失效');
  assert.equal(pick(rec, '課程代碼'), 'HE139A');
  assert.equal(pick(rec, '不存在的欄位'), '');
});

test('recordToFields：吃得下使用者實際的欄位名', () => {
  const { records } = parseRecords(
    '時間戳記,領域,課程代碼,課程名稱,授課教師,修課學期,甜度(請填數字),涼度(請填數字),學期成績,修課心得,星級\n'
    + '2026/9/13,天領域,HE139A,課名,老師,1141,9,7,92,心得內容,5\n',
  );
  const f = recordToFields(records[0]);
  assert.equal(f.code, 'HE139A');
  assert.equal(f.sweet, '9');
  assert.equal(f.stars, '5', '星級排在最後一欄也要對得上');
});

// ===========================================================================
test('個資遮罩：遮掉但放行', async (t) => {
  await t.test('Email', () => {
    const r = maskPii('找我 abc123@mmc.edu.tw 一起修');
    assert.ok(!r.text.includes('abc123@mmc.edu.tw'));
    assert.deepEqual(r.masked, ['email']);
  });

  await t.test('手機（各種寫法）', () => {
    for (const p of ['0912-345-678', '0912345678', '0912 345 678', '+886912345678']) {
      const r = maskPii(`打給我 ${p} 謝謝`);
      assert.ok(!r.text.includes(p.replace(/[-\s]/g, '').slice(-6)),
        `${p} 沒有被遮掉：${r.text}`);
    }
  });

  await t.test('身分證字號', () => {
    const r = maskPii('我的證號 A123456789');
    assert.ok(!r.text.includes('A123456789'));
    assert.ok(r.masked.includes('nationalId'));
  });

  await t.test('三種同時出現', () => {
    const r = maskPii('a@b.com 0912345678 A123456789');
    assert.equal(r.masked.length, 3);
  });

  await t.test('心得其餘內容完整保留', () => {
    const r = maskPii('課程很不錯，想找人一起修 a@b.com，老師很願意討論。');
    assert.ok(r.text.includes('課程很不錯'));
    assert.ok(r.text.includes('老師很願意討論'));
  });

  await t.test('沒有個資時不動內容', () => {
    const text = '這門課要交三次作業，期末是報告。';
    const r = maskPii(text);
    assert.equal(r.text, text);
    assert.deepEqual(r.masked, []);
  });

  await t.test('課程代碼與分數不會被誤遮', () => {
    const r = maskPii('HE139A 這門課我拿 92 分，1141 學期修的。');
    assert.deepEqual(r.masked, [], `誤遮了：${r.text}`);
  });
});

// ===========================================================================
test('封鎖字表', async (t) => {
  const list = parseBlocklist('# 註解\n幹你娘\n智障\n\n  去死  \n');

  await t.test('忽略註解與空行，去頭尾空白', () => {
    assert.deepEqual([...list].sort(), ['去死', '幹你娘', '智障']);
  });

  await t.test('命中', () => {
    assert.deepEqual(findBlocked('這個老師就是智障', list), ['智障']);
  });

  await t.test('插入空白與符號無法繞過', () => {
    assert.equal(findBlocked('智 障', list).length, 1);
    assert.equal(findBlocked('幹.你.娘', list).length, 1);
    assert.equal(findBlocked('智*障', list).length, 1);
  });

  await t.test('負面評價不會被誤擋', () => {
    // 這是這份表最重要的性質：擋辱罵，不擋批評。
    for (const ok of [
      '這堂課很爛，老師教得很差',
      '老師很機車又愛點名',
      '是地雷課，千萬別修',
      '作業超多，給分很硬，根本在浪費時間',
      '會當人，死當率很高',
    ]) {
      assert.deepEqual(findBlocked(ok, list), [], `誤擋了：「${ok}」`);
    }
  });

  await t.test('空表不會誤判', () => {
    assert.deepEqual(findBlocked('任何內容', parseBlocklist('')), []);
    assert.deepEqual(findBlocked('任何內容', null), []);
  });
});

// ===========================================================================
test('相似度', async (t) => {
  await t.test('完全相同是 1', () => {
    assert.equal(similarity('這門課很甜', '這門課很甜'), 1);
  });

  await t.test('只差空白仍視為相同', () => {
    assert.equal(similarity('這門課很甜', '這門課 很甜'), 1);
  });

  await t.test('完全不同接近 0', () => {
    assert.ok(similarity('這門課很甜', '完全無關的另外一段文字') < 0.2);
  });

  await t.test('重複送出會超過門檻', () => {
    const a = '老師人很好，作業不多，期末是報告，分數給得很甜。';
    assert.ok(similarity(a, a) > LIMITS.duplicateSimilarity);
  });

  await t.test('兩則講同一門課但內容不同，不該被判成重複', () => {
    const a = '老師人很好，作業不多，期末是報告。';
    const b = '要交三次作業，期中考很難，建議不要修。';
    assert.ok(similarity(a, b) <= LIMITS.duplicateSimilarity,
      `相似度 ${similarity(a, b)} 太高，正常心得會被誤丟`);
  });
});

// ===========================================================================
test('parseOptionalNumber：空是 null，不是 0', () => {
  assert.deepEqual(parseOptionalNumber(''), { value: null, invalid: false });
  assert.deepEqual(parseOptionalNumber('  '), { value: null, invalid: false });
  assert.deepEqual(parseOptionalNumber(null), { value: null, invalid: false });
  assert.deepEqual(parseOptionalNumber('0'), { value: 0, invalid: false });
  assert.deepEqual(parseOptionalNumber('9'), { value: 9, invalid: false });
  assert.deepEqual(parseOptionalNumber('94.5'), { value: 94.5, invalid: false });
  assert.deepEqual(parseOptionalNumber('abc'), { value: null, invalid: true },
    '填了不是數字的東西要標記為無效，不能當成沒填');
});

// ===========================================================================
test('gateOne', async (t) => {
  const run = (over) => gateOne(good(over), { domainNames: DOMAINS });

  await t.test('正常投稿放行', () => {
    const r = run({});
    assert.equal(r.verdict, 'accept', r.reasons.join('；'));
    assert.deepEqual(r.reasons, []);
  });

  await t.test('選填欄位留空仍然放行，且值為 null', () => {
    const r = run({ sweet: '', cool: '', grade: '' });
    assert.equal(r.verdict, 'accept');
    assert.equal(r.fields.sweet, null);
    assert.equal(r.fields.cool, null);
    assert.equal(r.fields.grade, null);
    assert.notEqual(r.fields.sweet, 0, '留空絕不可以變成 0');
  });

  await t.test('星級是唯一必填的評分欄位', () => {
    assert.equal(run({ stars: '' }).verdict, 'quarantine');
  });

  await t.test('必填缺漏', () => {
    for (const field of ['domain', 'code', 'name', 'teacher', 'term', 'text']) {
      const r = run({ [field]: '' });
      assert.equal(r.verdict, 'quarantine', `${field} 空的時候應該擋下`);
    }
  });

  await t.test('課程代碼格式', () => {
    assert.equal(run({ code: 'XX' }).verdict, 'quarantine');
    assert.equal(run({ code: 'HE139' }).verdict, 'quarantine');
    assert.equal(run({ code: 'he139a' }).verdict, 'accept', '小寫要能通過並轉成大寫');
    assert.equal(run({ code: 'he139a' }).fields.code, 'HE139A');
  });

  await t.test('學期格式', () => {
    assert.equal(run({ term: '11' }).verdict, 'quarantine');
    assert.equal(run({ term: '114學年' }).verdict, 'quarantine');
    assert.equal(run({ term: '991' }).verdict, 'accept');
  });

  await t.test('領域不在清單中', () => {
    assert.equal(run({ domain: '宇宙領域' }).verdict, 'quarantine');
  });

  await t.test('評分超出範圍', () => {
    assert.equal(run({ stars: '9' }).verdict, 'quarantine');
    assert.equal(run({ stars: '0' }).verdict, 'quarantine', '新投稿的星級下限是 1');
    assert.equal(run({ sweet: '11' }).verdict, 'quarantine');
    assert.equal(run({ cool: '-1' }).verdict, 'quarantine');
    assert.equal(run({ grade: '101' }).verdict, 'quarantine');
    assert.equal(run({ grade: '0' }).verdict, 'accept', '0 分是合法的成績');
  });

  await t.test('內文長度', () => {
    assert.equal(run({ text: '不錯' }).verdict, 'quarantine');
    assert.equal(run({ text: '一'.repeat(LIMITS.textMin) }).verdict, 'accept');
    assert.equal(run({ text: '一'.repeat(LIMITS.textMax + 1) }).verdict, 'quarantine');
  });

  await t.test('長度以字元計，中文一個字算一個', () => {
    // 10 個中文字剛好達標；用 byte 計算的話會是 30，會誤放行更短的內容。
    assert.equal(run({ text: '一二三四五六七八九十' }).verdict, 'accept');
    assert.equal(run({ text: '一二三四五六七八九' }).verdict, 'quarantine');
  });

  await t.test('命中封鎖字', () => {
    const blocklist = parseBlocklist('智障\n');
    const r = gateOne(good({ text: '這個老師就是智障，教得很爛。' }),
      { domainNames: DOMAINS, blocklist });
    assert.equal(r.verdict, 'quarantine');
  });

  await t.test('個資遮罩後仍然放行', () => {
    const r = run({ text: '想一起修可以找我 abc@mmc.edu.tw，這門課很不錯。' });
    assert.equal(r.verdict, 'accept', '個資是遮罩不是擋下');
    assert.deepEqual(r.masked, ['email']);
    assert.ok(!r.fields.text.includes('abc@mmc.edu.tw'));
  });
});

// ===========================================================================
test('gateBatch：跨列檢查', async (t) => {
  await t.test('同一分鐘超過上限就整批擋下', () => {
    const rows = Array.from({ length: LIMITS.burstPerMinute + 1 }, (_, i) =>
      good({ timestamp: '2026/9/13 下午 3:30:00', text: `第 ${i} 筆投稿的內容，長度足夠通過檢查。` }));
    const r = gateBatch(rows, { domainNames: DOMAINS });
    assert.equal(r.accepted.length, 0);
    assert.equal(r.quarantined.length, LIMITS.burstPerMinute + 1);
    assert.match(r.quarantined[0].reasons.join(), /洗版/);
  });

  await t.test('剛好等於上限不算洗版', () => {
    const rows = Array.from({ length: LIMITS.burstPerMinute }, (_, i) =>
      good({ timestamp: '2026/9/13 下午 3:30:00', text: `第 ${i} 筆投稿的內容，長度足夠通過檢查。` }));
    assert.equal(gateBatch(rows, { domainNames: DOMAINS }).accepted.length, LIMITS.burstPerMinute);
  });

  await t.test('不同分鐘不會互相牽連', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      good({ timestamp: `2026/9/13 下午 3:${String(10 + i).padStart(2, '0')}:00`, text: `第 ${i} 筆投稿的內容，長度足夠。` }));
    assert.equal(gateBatch(rows, { domainNames: DOMAINS }).accepted.length, 6);
  });

  await t.test('與既有心得重複就丟棄', () => {
    const text = '老師人很好，每週看一部電影寫心得，作業不多但要認真寫。';
    const existing = new Map([[courseKey('HE139A', '蔡維民'), [text]]]);
    const r = gateBatch([good({ text })], { domainNames: DOMAINS, existingTexts: existing });
    assert.equal(r.discarded.length, 1);
    assert.equal(r.accepted.length, 0);
  });

  await t.test('同批內重複也會被抓到', () => {
    const text = '老師人很好，每週看一部電影寫心得，作業不多但要認真寫。';
    const r = gateBatch([good({ text }), good({ text, timestamp: '2026/9/13 上午 11:00:00' })],
      { domainNames: DOMAINS });
    assert.equal(r.accepted.length, 1, '第一筆放行');
    assert.equal(r.discarded.length, 1, '第二筆丟棄');
  });

  await t.test('不同教師的同名課程不會互相誤判成重複', () => {
    const text = '老師人很好，每週看一部電影寫心得，作業不多但要認真寫。';
    const existing = new Map([[courseKey('HE013A', '陳尚仁'), [text]]]);
    const r = gateBatch([good({ code: 'HE013A', teacher: '張志偉', text })],
      { domainNames: DOMAINS, existingTexts: existing });
    assert.equal(r.accepted.length, 1, '不同老師的課是兩門課，內容雷同也不是重複');
  });

  await t.test('已同步過的先挑出來，不算進重複丟棄', () => {
    const rows = [good({})];
    const id = stableId(rows[0].timestamp, rows[0].code, gateOne(rows[0], { domainNames: DOMAINS }).fields.text);
    const r = gateBatch(rows, {
      domainNames: DOMAINS,
      isAlreadySynced: (f) => stableId(f.timestamp, f.code, f.text) === id,
    });
    assert.equal(r.existing.length, 1);
    assert.equal(r.discarded.length, 0, '已同步過的不該被算成重複丟棄');
    assert.equal(r.accepted.length, 0);
  });
});

// ===========================================================================
test('stableId', async (t) => {
  await t.test('同樣輸入永遠得到同樣 id', () => {
    const a = stableId('2026/9/13 上午 10:00:00', 'HE139A', '內容');
    const b = stableId('2026/9/13 上午 10:00:00', 'HE139A', '內容');
    assert.equal(a, b, '不穩定的話，抑制清單會失效');
  });

  await t.test('大小寫不同的代碼視為同一個', () => {
    assert.equal(
      stableId('t', 'he139a', 'x'),
      stableId('t', 'HE139A', 'x'),
    );
  });

  await t.test('任一欄位不同就是不同 id', () => {
    const base = stableId('t', 'HE139A', '內容');
    assert.notEqual(base, stableId('t2', 'HE139A', '內容'));
    assert.notEqual(base, stableId('t', 'HE140A', '內容'));
    assert.notEqual(base, stableId('t', 'HE139A', '內容2'));
  });

  await t.test('格式固定', () => {
    assert.match(stableId('t', 'HE139A', 'x'), /^fm-[0-9a-f]{16}$/);
  });

  await t.test('中文內容不會讓雜湊爆掉', () => {
    assert.doesNotThrow(() => stableId('t', 'HE139A', '這是一段中文內容 with English 混雜 🎓'));
  });
});

test('teacherSlug', () => {
  const map = { 蔡維民: { slug: 'caiweimin' } };
  assert.equal(teacherSlug('蔡維民', map), 'caiweimin', '查得到就用拼音');
  assert.match(teacherSlug('沒在表裡的老師', map), /^t[0-9a-f]{6}$/, '查不到用穩定雜湊，不猜拼音');
  assert.equal(
    teacherSlug('沒在表裡的老師', map),
    teacherSlug('沒在表裡的老師', map),
    '後備 slug 也必須穩定',
  );
});

// ===========================================================================
test('parseTimestamp', async (t) => {
  await t.test('中文上下午', () => {
    assert.equal(parseTimestamp('2026/9/13 上午 10:04:21'), '2026-09-13T10:04:21+08:00');
    assert.equal(parseTimestamp('2026/9/13 下午 3:04:21'), '2026-09-13T15:04:21+08:00');
  });

  await t.test('中午與午夜的邊界', () => {
    assert.equal(parseTimestamp('2026/9/13 下午 12:00:00'), '2026-09-13T12:00:00+08:00');
    assert.equal(parseTimestamp('2026/9/13 上午 12:00:00'), '2026-09-13T00:00:00+08:00');
  });

  await t.test('解析不出來回 null，不是「現在」', () => {
    // 回 new Date() 會讓所有壞掉的時間戳都變成同步當下，
    //「最新心得」的排序就變成隨機。
    assert.equal(parseTimestamp('完全不是時間'), null);
    assert.equal(parseTimestamp(''), null);
    assert.equal(parseTimestamp(null), null);
  });
});

// ===========================================================================
test('mergeSubmissions', async (t) => {
  const base = () => ({
    meta: {},
    domains: [{ id: 'tian', name: '天領域', order: 1 }],
    courses: [{
      id: 'HE139A-caiweimin', code: 'HE139A', name: '由電影認識亞洲諸宗教',
      domain: 'tian', teacher: '蔡維民', reviews: [],
    }],
  });

  const accepted = (over) => [{ fields: gateOne(good(over), { domainNames: DOMAINS }).fields, masked: [] }];

  await t.test('併進既有課程', () => {
    const { courses, summary } = mergeSubmissions(base(), accepted({}));
    assert.equal(courses.length, 1, '不該新建課程');
    assert.equal(courses[0].reviews.length, 1);
    assert.equal(summary.added, 1);
    assert.equal(courses[0].reviews[0].source, 'form');
  });

  await t.test('沒有的課程會被新建', () => {
    const { courses, summary } = mergeSubmissions(base(),
      accepted({ code: 'LN999A', name: '西班牙文入門', teacher: '王小明', domain: '天領域' }));
    assert.equal(courses.length, 2);
    assert.equal(summary.newCourses.length, 1);
    assert.match(courses[1].id, /^LN999A-/);
  });

  await t.test('同代碼不同教師建成兩門課', () => {
    const { courses } = mergeSubmissions(base(), accepted({ teacher: '另一位老師' }));
    assert.equal(courses.length, 2, '同代碼不同教師必須分開');
  });

  await t.test('抑制清單裡的不會被併進來', () => {
    const rows = accepted({});
    const id = stableId(rows[0].fields.timestamp, rows[0].fields.code, rows[0].fields.text);
    const { courses, summary } = mergeSubmissions(base(), rows, { suppressed: new Set([id]) });
    assert.equal(courses[0].reviews.length, 0);
    assert.equal(summary.skippedSuppressed, 1);
  });

  await t.test('已存在的 id 不會重複併入（冪等）', () => {
    const data = base();
    const rows = accepted({});
    const first = mergeSubmissions(data, rows);
    const second = mergeSubmissions({ ...data, courses: first.courses }, rows);
    assert.equal(second.summary.added, 0);
    assert.equal(second.summary.skippedExisting, 1);
    assert.equal(second.courses[0].reviews.length, 1);
  });

  await t.test('不修改傳入的資料', () => {
    const data = base();
    mergeSubmissions(data, accepted({}));
    assert.equal(data.courses[0].reviews.length, 0, 'mergeSubmissions 必須是純函式');
  });

  await t.test('遮罩過的欄位記錄在 review 上', () => {
    const rows = [{ fields: gateOne(good({}), { domainNames: DOMAINS }).fields, masked: ['email'] }];
    const { courses } = mergeSubmissions(base(), rows);
    assert.deepEqual(courses[0].reviews[0].maskedFields, ['email']);
  });
});

// ===========================================================================
test('欄位安全檢查：公開試算表的個資防線', () => {
  const headers = ['時間戳記', '領域', '課程代碼', '電子郵件地址', '姓名', '自訂欄位'];
  assert.deepEqual(piiHeaders(headers), ['電子郵件地址', '姓名']);
  assert.ok(unknownHeaders(headers).includes('自訂欄位'));
  assert.ok(!unknownHeaders(headers).includes('課程代碼'), '已知欄位不該被列為未知');
  assert.deepEqual(piiHeaders(['時間戳記', '領域', '課程代碼']), [], '正常欄位不該誤報');
});
