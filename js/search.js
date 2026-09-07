// 倒排索引 + 篩選 + 排序。
//
// 比對課程代碼、課名、教師姓名；不分大小寫、忽略空白、支援部分比對
// （規格第五節）。中文沒有詞界，所以索引建在「字」與「相鄰兩字」上 ——
// 這樣「易經」「經」「亞洲宗教」都查得到，不需要斷詞器。
//
// 索引只負責快速縮小候選集，最後一定用子字串比對驗證一次，避免 n-gram
// 交集帶進不該出現的結果。

import { courseStats, comparator, sortKey, visibleReviews } from './format.js';

/** 正規化：全形轉半形、小寫、去掉空白與常見標點。 */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[()（）[\]【】「」《》、,，.。:：;；!！?？_\-–—/\\]/g, '');
}

/** 一段字串的 1-gram 與 2-gram。 */
function grams(s) {
  const out = new Set();
  for (let i = 0; i < s.length; i++) {
    out.add(s[i]);
    if (i + 1 < s.length) out.add(s.slice(i, i + 2));
  }
  return out;
}

/**
 * 建立索引。courses 順序即 id，postings 存的是索引位置。
 * 89 門課約 3000 個 gram，建立耗時可忽略；1000 門課仍在毫秒等級。
 */
export function buildIndex(courses) {
  const docs = courses.map((c) => {
    const code = normalize(c.code);
    const name = normalize(c.name);
    const teacher = normalize(c.teacher);
    return { course: c, code, name, teacher, hay: code + name + teacher };
  });

  const postings = new Map();
  docs.forEach((doc, i) => {
    for (const g of grams(doc.hay)) {
      let set = postings.get(g);
      if (!set) postings.set(g, (set = new Set()));
      set.add(i);
    }
  });

  return { docs, postings };
}

/**
 * 查詢。回傳依相關度排序的課程陣列。
 * 空字串回傳 null，代表「沒有查詢」——呼叫端要自己決定顯示什麼，
 * 不要跟「查無結果」搞混。
 */
export function query(index, q) {
  const nq = normalize(q);
  if (!nq) return null;

  const qGrams = [...grams(nq)].filter((g) => g.length === Math.min(2, nq.length));

  // 交集：從最小的 posting list 開始，省掉大部分比較。
  let candidates = null;
  const lists = qGrams
    .map((g) => index.postings.get(g))
    .sort((a, b) => (a?.size ?? 0) - (b?.size ?? 0));

  for (const list of lists) {
    if (!list) return [];                       // 有一個 gram 完全沒出現 → 必無結果
    if (candidates === null) { candidates = new Set(list); continue; }
    for (const i of candidates) if (!list.has(i)) candidates.delete(i);
    if (candidates.size === 0) return [];
  }
  if (candidates === null) candidates = new Set(index.docs.keys());

  // 驗證 + 評分
  const hits = [];
  for (const i of candidates) {
    const doc = index.docs[i];
    if (!doc.hay.includes(nq)) continue;        // n-gram 交集的偽陽性在這裡濾掉
    hits.push({ doc, score: score(doc, nq) });
  }

  hits.sort((a, b) => b.score - a.score ||
    String(a.doc.course.code ?? '').localeCompare(String(b.doc.course.code ?? '')));
  return hits.map((h) => h.doc.course);
}

/** 代碼完全命中最相關，其次是開頭命中，最後才是出現在中間。 */
function score(doc, nq) {
  let s = 0;
  if (doc.code === nq) s += 100;
  else if (doc.code.startsWith(nq)) s += 60;
  else if (doc.code.includes(nq)) s += 30;

  if (doc.name === nq) s += 80;
  else if (doc.name.startsWith(nq)) s += 50;
  else if (doc.name.includes(nq)) s += 25;

  if (doc.teacher === nq) s += 70;
  else if (doc.teacher.includes(nq)) s += 20;

  // 同分時讓有心得的排前面，掃描的人才不會先點到空課。
  s += Math.min(visibleReviews(doc.course).length, 10) * 0.5;
  return s;
}

// --------------------------------------------------------------------- 篩選

/**
 * 篩選條件。缺項一律「不參與比較」而不是當成 0 ——
 * 「最低甜度 8」不應該把「沒填甜度」的課當成 0 分排除掉，那是在替學生
 * 回答他沒有回答的問題。所以缺項課程在該條件下直接不通過，並且 UI 要說明。
 */
export function filter(courses, f = {}) {
  return courses.filter((c) => {
    const st = courseStats(c);
    if (f.hasReviews && st.count === 0) return false;
    if (f.teacher && c.teacher !== f.teacher) return false;
    if (f.minStars != null && !(st.stars.avg !== null && st.stars.avg >= f.minStars)) return false;
    if (f.minSweet != null && !(st.sweet.avg !== null && st.sweet.avg >= f.minSweet)) return false;
    if (f.minCool != null && !(st.cool.avg !== null && st.cool.avg >= f.minCool)) return false;
    return true;
  });
}

// --------------------------------------------------------------------- 排序

/** 領域頁可用的排序欄位。value 是取值函式，null 一律沉底（見 comparator）。 */
export const SORTS = {
  code: { label: '代碼', dir: 'asc', value: (c) => c.code ?? null },
  name: { label: '課名', dir: 'asc', value: (c) => c.name ?? null },
  stars: { label: '平均星級', dir: 'desc', value: (c) => sortKey(courseStats(c).stars) },
  sweet: { label: '平均甜度', dir: 'desc', value: (c) => sortKey(courseStats(c).sweet) },
  cool: { label: '平均涼度', dir: 'desc', value: (c) => sortKey(courseStats(c).cool) },
  count: { label: '心得則數', dir: 'desc', value: (c) => courseStats(c).count },
  updated: { label: '最近更新', dir: 'desc', value: (c) => courseStats(c).termTo ?? null },
};

export function sort(courses, key, dir) {
  const spec = SORTS[key];
  if (!spec) return courses;
  return [...courses].sort(comparator(spec.value, dir ?? spec.dir));
}
