// 自動品質閘（規格第六節）。取代人工審核。
//
// 這個模組在兩個地方跑，而且是同一份程式碼：
//   執行期：store.js 合併即時 CSV 之前
//   建置期：scripts/sync-submissions.mjs 寫回 courses.json 之前
// 兩邊各寫一份的話，遲早會有一邊漏掉某條規則，而漏掉的那邊會是使用者
// 真正看到的那一邊。
//
// 三種判決：
//   accept     —— 放行（個資會先遮罩）
//   quarantine —— 擋下，進 data/quarantine.json 等後台處理。可以救回來。
//   discard    —— 丟棄。只用在「與既有心得幾乎完全相同」，也就是重複送出。
//
// 為什麼預設是 quarantine 而不是 discard：擋錯了還救得回來，丟錯了就沒了。
// 規格第十三節第一條是不得丟棄學生心得，這裡照同一個標準。

export const LIMITS = {
  textMin: 10,
  textMax: 2000,
  starsMin: 1,
  starsMax: 5,
  meterMin: 0,
  meterMax: 10,
  gradeMin: 0,
  gradeMax: 100,
  /** 同一分鐘內超過這個數量就全部擋下。一個人正常不會一分鐘投五門課。 */
  burstPerMinute: 5,
  /** 與同課程既有心得的相似度超過這個值就視為重複。 */
  duplicateSimilarity: 0.95,
};

export const CODE_RE = /^[A-Za-z]{2}\d{3}[A-Za-z]$/;
export const TERM_RE = /^\d{3,4}$/;

// --------------------------------------------------------------------- 個資
//
// 規格第六節：疑似個資自動遮罩後放行，不是擋下。
// 理由是這類內容通常不是惡意的（例如留自己的 IG 想揪人一起修課），
// 心得本身仍然有價值，遮掉就好。

const PII_RULES = [
  {
    name: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    label: '［已遮蔽 Email］',
  },
  {
    // 台灣手機：09xx-xxx-xxx / 09xxxxxxxx / +8869xxxxxxxx
    name: 'phone',
    re: /(?:\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/g,
    label: '［已遮蔽電話］',
  },
  {
    // 身分證字號：一個英文字母 + 1/2 + 八位數字
    name: 'nationalId',
    re: /\b[A-Za-z][12]\d{8}\b/g,
    label: '［已遮蔽身分證］',
  },
  {
    // 市話：(02)1234-5678 / 02-12345678
    name: 'landline',
    re: /\(?0[2-8]\)?[-\s]?\d{3,4}[-\s]?\d{4}\b/g,
    label: '［已遮蔽電話］',
  },
];

/**
 * 遮罩疑似個資。回傳 { text, masked }。
 * masked 是被遮掉的類型清單，會寫進 review 讓後台知道動過什麼。
 */
export function maskPii(input) {
  let text = String(input ?? '');
  const masked = [];
  for (const rule of PII_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) {
      rule.re.lastIndex = 0;
      text = text.replace(rule.re, rule.label);
      masked.push(rule.name);
    }
  }
  return { text, masked };
}

// ------------------------------------------------------------------- 封鎖字

/** blocklist.txt → Set。忽略空行與 # 開頭的註解。 */
export function parseBlocklist(text) {
  return new Set(
    String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  );
}

/** 回傳命中的字詞。比對前把空白與常見分隔符拿掉，避免用「幹 你 娘」繞過。 */
export function findBlocked(text, blocklist) {
  if (!blocklist || blocklist.size === 0) return [];
  const flat = String(text ?? '').replace(/[\s　,，.。*＊_\-~～]/g, '');
  const hits = [];
  for (const word of blocklist) {
    if (flat.includes(word)) hits.push(word);
  }
  return hits;
}

// --------------------------------------------------------------------- 相似度

/** 相鄰兩字的集合。中文沒有詞界，字元 bigram 比斷詞穩定也便宜。 */
function bigrams(s) {
  const t = String(s ?? '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

/**
 * Dice 係數，0 到 1。
 * 太短的字串沒有 bigram 可比，退回完全相等判斷。
 */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) {
    return String(a ?? '').replace(/\s+/g, '') === String(b ?? '').replace(/\s+/g, '') ? 1 : 0;
  }
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ------------------------------------------------------------------ 數值解析

/**
 * 選填的數值欄位。
 * 空字串 → null（沒填），不是 0。這是整個資料模型最重要的一條規則。
 * 填了但不是數字 → { value: null, invalid: true }，會被擋下而不是當成沒填。
 */
export function parseOptionalNumber(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, invalid: false };
  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

const inRange = (n, lo, hi) => n === null || (n >= lo && n <= hi);

// --------------------------------------------------------------------- 主閘門

/**
 * 檢查單筆投稿。
 *
 * fields 是已經從 CSV 對應好的原始字串：
 *   { timestamp, domain, code, name, teacher, term, stars, sweet, cool, grade, text }
 *
 * 回傳 { verdict, reasons, fields, masked }，fields 帶著轉型後的數值。
 */
export function gateOne(fields, { blocklist, domainNames } = {}) {
  const reasons = [];

  const str = (k) => String(fields[k] ?? '').trim();
  const domain = str('domain');
  const code = str('code').toUpperCase();
  const name = str('name');
  const teacher = str('teacher');
  const term = str('term');
  const rawText = str('text');

  // --- 必填 ------------------------------------------------------------
  const required = { 領域: domain, 課程代碼: code, 課程名稱: name, 授課教師: teacher, 修課學期: term, 修課心得: rawText };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) reasons.push(`必填欄位缺漏：${missing.join('、')}`);

  // --- 格式 ------------------------------------------------------------
  if (code && !CODE_RE.test(code)) reasons.push(`課程代碼格式不符：「${code}」`);
  if (term && !TERM_RE.test(term)) reasons.push(`學期格式不符：「${term}」`);
  if (domain && domainNames && !domainNames.has(domain)) {
    reasons.push(`領域不在清單中：「${domain}」`);
  }

  // --- 評分範圍 ---------------------------------------------------------
  const stars = parseOptionalNumber(fields.stars);
  const sweet = parseOptionalNumber(fields.sweet);
  const cool = parseOptionalNumber(fields.cool);
  const grade = parseOptionalNumber(fields.grade);

  if (stars.invalid) reasons.push(`星級不是數字：「${str('stars')}」`);
  else if (stars.value === null) reasons.push('星級未填（星級是唯一必填的評分欄位）');
  else if (!inRange(stars.value, LIMITS.starsMin, LIMITS.starsMax)) {
    reasons.push(`星級超出 ${LIMITS.starsMin}–${LIMITS.starsMax}：${stars.value}`);
  }

  for (const [label, parsed, lo, hi] of [
    ['甜度', sweet, LIMITS.meterMin, LIMITS.meterMax],
    ['涼度', cool, LIMITS.meterMin, LIMITS.meterMax],
    ['學期成績', grade, LIMITS.gradeMin, LIMITS.gradeMax],
  ]) {
    if (parsed.invalid) reasons.push(`${label}不是數字：「${fields[label] ?? ''}」`);
    else if (!inRange(parsed.value, lo, hi)) reasons.push(`${label}超出 ${lo}–${hi}：${parsed.value}`);
  }

  // --- 內文長度（以字元計，中文一個字算一個）-----------------------------
  const textLen = [...rawText].length;
  if (rawText && textLen < LIMITS.textMin) reasons.push(`內文太短：${textLen} 字，至少要 ${LIMITS.textMin} 字`);
  if (textLen > LIMITS.textMax) reasons.push(`內文太長：${textLen} 字，上限 ${LIMITS.textMax} 字`);

  // --- 封鎖字 -----------------------------------------------------------
  const blocked = findBlocked(rawText + name + teacher, blocklist);
  if (blocked.length) reasons.push(`命中封鎖字表：${blocked.length} 個`);

  // --- 個資遮罩（不擋下，遮掉就放行）-------------------------------------
  const { text, masked } = maskPii(rawText);

  return {
    verdict: reasons.length ? 'quarantine' : 'accept',
    reasons,
    masked,
    fields: {
      timestamp: str('timestamp'),
      domain, code, name, teacher, term, text,
      stars: stars.value,
      sweet: sweet.value,
      cool: cool.value,
      grade: grade.value,
    },
  };
}

// ------------------------------------------------------- 跨列檢查（洗版／重複）

/** 時間戳 → 分鐘字串。解析不出來就回 null，那一列不參與洗版判斷。 */
function minuteKey(ts) {
  const s = String(ts ?? '').trim();
  if (!s) return null;
  const d = new Date(s.replace(/\//g, '-'));
  if (Number.isNaN(d.getTime())) {
    // Google 表單的中文時間戳（2026/9/13 下午 3:04:21）Date 未必吃得下，
    // 退而求其次：直接用字串本身去掉秒數當鍵。
    const m = s.match(/^(.*\d{1,2}:\d{1,2})(:\d{1,2})?/);
    return m ? m[1] : null;
  }
  return d.toISOString().slice(0, 16);
}

/**
 * 整批檢查。
 *
 * 先逐列跑 gateOne，再做需要看全局的檢查：
 *   洗版：同一分鐘內超過 burstPerMinute 筆 → 那一分鐘全部擋下
 *   歸屬：分不出要併進哪一門課 → 擋進待審區（有傳 placeCourse 才做）
 *   重複：與同課程既有心得相似度超過門檻 → 丟棄
 *
 * existingTexts 是 Map<courseKey, string[]>，courseKey 由呼叫端決定
 * （通常是 code + teacher），讓不同老師的同名課程不會互相誤判。
 *
 * placeCourse(fields) 回傳 { type: 'match', key } / { type: 'new' } /
 * { type: 'ambiguous', labels }，由 submissions.js 的 coursePlacer 產生。
 * 閘門本身不認識課程資料，只依結果決定放行或待審。
 */
export function gateBatch(rows, {
  blocklist, domainNames, existingTexts = new Map(), isAlreadySynced = null, placeCourse = null,
} = {}) {
  const results = rows.map((r) => ({ row: r, ...gateOne(r, { blocklist, domainNames }) }));

  // --- 已經同步過的 ------------------------------------------------------
  // 一定要在重複偵測之前做。同步過的心得已經躺在 courses.json 裡，下一次
  // 同步時 CSV 那一列必然跟它自己 100% 相似 —— 不先挑出來的話，每一則舊
  // 投稿都會被判成「重複丟棄」，丟棄數隨投稿總量成長，真正的重複送出就
  // 被淹在裡面看不到了。
  if (isAlreadySynced) {
    for (const r of results) {
      if (r.verdict === 'accept' && isAlreadySynced(r.fields)) r.verdict = 'existing';
    }
  }

  // --- 洗版 -------------------------------------------------------------
  const byMinute = new Map();
  for (const r of results) {
    const k = minuteKey(r.fields.timestamp);
    if (!k) continue;
    if (!byMinute.has(k)) byMinute.set(k, []);
    byMinute.get(k).push(r);
  }
  for (const [minute, group] of byMinute) {
    if (group.length <= LIMITS.burstPerMinute) continue;
    for (const r of group) {
      r.verdict = 'quarantine';
      r.reasons.push(`疑似洗版：${minute} 這一分鐘內有 ${group.length} 筆投稿`);
    }
  }

  // --- 重複 -------------------------------------------------------------
  // 同批內也要比，不然一次貼十遍相同內容會全部放行。
  //
  // 比之前先決定每筆要併進哪一門課（placeCourse）：老師寫法不同（順序、頓號、
  // 只寫其中一位）時用那門課的鍵來比，換個寫法重送同一則才抓得到；
  // 對得上不只一門就不猜，擋進待審區由管理者選。
  if (placeCourse) {
    for (const r of results) {
      if (r.verdict !== 'accept') continue;
      const placed = placeCourse(r.fields);
      if (placed.type === 'match') r.courseKey = placed.key;
      if (placed.type === 'ambiguous') {
        r.verdict = 'quarantine';
        r.reasons.push(`分不出是哪一門課，可能是：${placed.labels.join('、')}。請到後台待審區選擇要併進哪一門`);
      }
    }
  }

  const seen = new Map(existingTexts);
  for (const r of results) {
    if (r.verdict !== 'accept') continue;
    const key = r.courseKey ?? `${r.fields.code}::${r.fields.teacher}`;
    const prior = seen.get(key) ?? [];
    const dup = prior.find((t) => similarity(t, r.fields.text) > LIMITS.duplicateSimilarity);
    if (dup !== undefined) {
      r.verdict = 'discard';
      r.reasons.push('與同課程既有心得幾乎完全相同，視為重複送出');
      continue;
    }
    seen.set(key, [...prior, r.fields.text]);
  }

  return {
    accepted: results.filter((r) => r.verdict === 'accept'),
    quarantined: results.filter((r) => r.verdict === 'quarantine'),
    discarded: results.filter((r) => r.verdict === 'discard'),
    existing: results.filter((r) => r.verdict === 'existing'),
    all: results,
  };
}
