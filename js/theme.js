// 深色模式切換。
//
// 三種狀態，不是兩種：
//   null（跟隨系統）／ 'light'（強制淺色）／ 'dark'（強制深色）
//
// tokens.css 的深色區塊寫成 :root:not([data-theme="light"])，所以
// 「沒有屬性」＝ 跟隨系統，而不是「一定淺色」。少了跟隨系統這一檔，
// 使用者換手機外觀時網站不會跟著換，那才是預設該有的行為。
//
// 首次套用發生在 index.html 的行內 script（見那裡的註解），這裡只
// 負責之後的切換與記憶。

const KEY = 'mmu:theme';
export const ORDER = [null, 'light', 'dark'];

export const LABELS = new Map([
  [null, '外觀：跟隨系統'],
  ['light', '外觀：淺色'],
  ['dark', '外觀：深色'],
]);

const ICONS = new Map([[null, '◐'], ['light', '☀'], ['dark', '☾']]);

/** localStorage 在私密視窗會直接丟例外，一律包起來。 */
function read() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

function write(v) {
  try {
    if (v === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch { /* 記不住就算了，當次仍然生效 */ }
}

export function getTheme() { return read(); }

export function setTheme(v) {
  if (v === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  write(v);
  // 讓瀏覽器 UI（網址列、捲軸）也跟著換，不然深色頁配淺色捲軸很突兀。
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', v ?? 'light dark');
}

/** 依序循環：跟隨系統 → 淺色 → 深色 → 跟隨系統。 */
export function cycleTheme() {
  const next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
  setTheme(next);
  return next;
}

/** 目前狀態要顯示的圖示與說明文字。 */
export function themeLabel(v = read()) {
  return { icon: ICONS.get(v), label: LABELS.get(v) };
}
