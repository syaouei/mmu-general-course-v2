// CSV 解析。瀏覽器與 Node 共用（package.json 的 type:module 讓 Node 讀得懂）。
//
// 為什麼不用 split(',')：Google 表單的心得內文一定會出現逗號、雙引號與換行，
// 那三種字元 RFC 4180 都是用引號包住並跳脫的。用 split 會把一則心得切成好幾欄，
// 資料錯位之後不會報錯、只會默默變成垃圾 —— 這正是規格第十三節禁止的那種失敗。

/**
 * 解析 CSV 成二維陣列。
 * 支援：引號內的逗號／換行、"" 跳脫的雙引號、CRLF、開頭的 BOM。
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }  // "" → 一個 "
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }                               // CRLF 的 CR 直接吞掉
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }

    field += c;
    i++;
  }

  // 最後一列可能沒有換行結尾
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // 丟掉完全空白的列（試算表尾端常有）
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/**
 * 二維陣列 → 物件陣列，用第一列當欄位名。
 * 回傳 { headers, records }。欄位數不足的列補空字串，多出來的忽略。
 */
export function toRecords(rows) {
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, records };
}

/** 一步到位。 */
export const parseRecords = (text) => toRecords(parseCsv(text));

/**
 * 依「正規化後的欄位名」找值。
 *
 * 表單標題常常帶著提示字，例如「甜度(請填數字)」；管理者也可能隨手把
 * 「課程代碼」改成「課程代碼 *」。硬比對字串會在那一刻靜默失效 ——
 * 欄位讀不到就變成缺值，缺值就進待審區，沒有人會知道是欄名被改了。
 * 所以比對前先去掉括號內容、星號與空白。
 */
export function normalizeHeader(h) {
  return String(h ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[*＊\s　]/g, '')
    .trim();
}

/** 從一筆 record 依正規化名稱取值，取不到回空字串。 */
export function pick(record, name) {
  const target = normalizeHeader(name);
  for (const key of Object.keys(record)) {
    if (normalizeHeader(key) === target) return record[key];
  }
  return '';
}
