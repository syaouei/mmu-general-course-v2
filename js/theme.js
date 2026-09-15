// 深色模式切換。
//
// 內部仍是三種狀態：
//   null（跟隨系統）／ 'light'（強制淺色）／ 'dark'（強制深色）
//
// tokens.css 的深色區塊寫成 :root:not([data-theme="light"])，所以
// 「沒有屬性」＝ 跟隨系統，而不是「一定淺色」。少了跟隨系統這一檔，
// 使用者換手機外觀時網站不會跟著換，那才是預設該有的行為。
//
// 按鈕則是「每按一下，畫面一定翻面」。原本是跟隨系統 → 淺色 → 深色三段循環：
// 系統本來就是淺色時，第一下切到「淺色」畫面完全沒變，看起來像按鈕壞了，
// 再按一下才突然變黑（2026-09-15 使用者實際遇到）。現在翻回和系統相同的
// 外觀時就回到「跟隨系統」，不需要第三段也回得去。
//
// 首次套用發生在 index.html 的行內 script（見那裡的註解），這裡只
// 負責之後的切換與記憶。

const KEY = 'mmu:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

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

/** 系統（手機或電腦）目前的外觀。 */
export function systemTheme() {
  return matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** 系統外觀改變時通知。跟隨系統的狀態下，按鈕圖示要跟著換。 */
export function onSystemThemeChange(fn) {
  // 舊版 Safari 的 MediaQueryList 沒有 addEventListener，沒有就不監聽。
  matchMedia(DARK_QUERY).addEventListener?.('change', fn);
}

export function getTheme() { return read(); }

/** 畫面實際呈現的外觀：有強制設定就用它，否則跟系統。 */
export function effectiveTheme(v = read()) { return v ?? systemTheme(); }

export function setTheme(v) {
  if (v === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
  write(v);
  // 讓瀏覽器 UI（網址列、捲軸）也跟著換，不然深色頁配淺色捲軸很突兀。
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', v ?? 'light dark');
}

/** 切換：畫面在淺色與深色之間翻面；翻到和系統一樣時改回跟隨系統。 */
export function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next === systemTheme() ? null : next);
  return read();
}

/** 按鈕的圖示與說明，寫的是「按下去會變成什麼」。 */
export function themeLabel(v = read()) {
  return effectiveTheme(v) === 'dark'
    ? { icon: '☀', label: '切換成淺色' }
    : { icon: '☾', label: '切換成深色' };
}
