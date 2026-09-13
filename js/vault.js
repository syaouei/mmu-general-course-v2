// 後台金鑰保險箱（規格第七節）。
//
// ─────────────────────────────────────────────────────────────────────────
// 安全模型：密碼不是用來驗證身分的，是用來解密一把鑰匙的。
// ─────────────────────────────────────────────────────────────────────────
//
// 純靜態站的前端沒有可信執行環境。把密碼或它的雜湊寫進 JS 做比對，那個
// if 跑在使用者自己的機器上，改一行就過了 —— 那是 UI 鎖，不是安全邊界。
// 而且 courses.json 本來就是公開檔案，「擋住讀取」從一開始就不是目標。
//
// 要保護的是**寫入權**，寫入權在 GitHub、由 token 決定。所以密碼的工作
// 不是「證明你是誰」，而是「解開一把你本來就沒有的鑰匙」：
//
//   沒有正確密碼 → AES-GCM 解出來是垃圾 → GitHub 直接回 401
//
// 逆向這個檔案沒有用，因為這裡沒有秘密 —— 秘密在密文裡。安全問題因此
// 從「我的 JS 判斷得對不對」（不可驗證）換成「PBKDF2 600k + AES-GCM
// 擋不擋得住離線爆破」（可量化）。
//
// 代價要誠實講（README 也寫了）：vault.enc 是公開檔案，可以被下載回去
// 離線爆破。60 萬次迭代只提高每次嘗試的成本，不能歸零。防線完全落在
// 密碼本身的熵上，所以密碼必須是長通關密語。

const VAULT_URL = 'admin/vault.enc';

/** 閒置多久自動上鎖。規格第七節指定 15 分鐘。 */
export const IDLE_MS = 15 * 60 * 1000;

// token 只活在這個 module scope 的變數裡。
// 絕不寫入 localStorage / sessionStorage / IndexedDB / cookie，也不掛到
// window 上 —— 重新整理就失效是刻意的，那是共用電腦的最後一道保險。
let token = null;
let idleTimer = null;
const lockListeners = new Set();

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** 訂閱「被鎖上」事件，讓 UI 把畫面收回去。 */
export function onLock(fn) {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}

export const isUnlocked = () => token !== null;

/**
 * 上鎖：清掉 token 並通知 UI。
 * 清變數不能保證記憶體裡沒有殘留（JS 沒有 memset），但至少後續的
 * 程式碼拿不到它。
 */
export function lock(reason = 'manual') {
  token = null;
  clearTimeout(idleTimer);
  idleTimer = null;
  stopIdleWatch();
  for (const fn of lockListeners) fn(reason);
}

// ------------------------------------------------------------------ 閒置計時

const ACTIVITY = ['pointerdown', 'keydown', 'focus'];

/** 最後一次活動的時間。給 UI 顯示倒數用。 */
let lastActivity = 0;

function resetIdle() {
  lastActivity = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lock('idle'), IDLE_MS);
}

function startIdleWatch() {
  for (const ev of ACTIVITY) addEventListener(ev, resetIdle, { passive: true, capture: true });
  resetIdle();
}

function stopIdleWatch() {
  for (const ev of ACTIVITY) removeEventListener(ev, resetIdle, { capture: true });
}

// --------------------------------------------------------------------- 解密

/**
 * 用密碼解開 vault，取得 GitHub token。
 *
 * 成功時 token 存進 module scope 並啟動閒置計時。
 * 失敗時丟出可以直接顯示給使用者看的錯誤訊息。
 *
 * PBKDF2 60 萬次在手機上大約要一到三秒，呼叫端要顯示進行中狀態，
 * 不然使用者會以為當掉而重複點擊。
 */
export async function unlock(password) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('這個瀏覽器不支援 WebCrypto，或頁面不是在安全來源（https / localhost）下開啟。');
  }

  let vault;
  try {
    const res = await fetch(VAULT_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    vault = await res.json();
  } catch (err) {
    throw new Error(`讀不到 ${VAULT_URL}（${err.message}）。還沒建立的話，先跑 scripts/make-vault.mjs。`);
  }

  if (vault.v !== 1 || vault.kdf !== 'PBKDF2-SHA256') {
    throw new Error(`不認識的 vault 格式：v=${vault.v} kdf=${vault.kdf}`);
  }

  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'],
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64ToBytes(vault.salt),
      iterations: vault.iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  let plain;
  try {
    // WebCrypto 預期密文尾端接著 16 bytes 驗證標籤，make-vault.mjs
    // 已經把 Node 分開給的 tag 接上去了。
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(vault.iv) },
      key,
      b64ToBytes(vault.ct),
    );
  } catch {
    // AES-GCM 的驗證失敗只有一種可能：金鑰不對，也就是密碼錯了。
    // 這裡刻意不區分「密碼錯」與「檔案壞了」—— 對攻擊者來說兩者
    // 應該是一樣的回應。
    throw new Error('密碼錯誤。');
  }

  token = new TextDecoder().decode(plain).trim();
  if (!token) throw new Error('解出來是空的，vault 可能壞了。');

  startIdleWatch();
  return true;
}

/**
 * 取得 token 給 GitHub API 用。
 *
 * 刻意不 export token 本身，只給這個函式 —— 呼叫端拿到就馬上用掉，
 * 不要存進自己的變數，才不會在別的地方意外延長它的生命週期。
 */
export function withToken(fn) {
  if (token === null) throw new Error('後台已上鎖，請重新輸入密碼。');
  return fn(token);
}

/** 距離自動上鎖還有多久（毫秒），給 UI 顯示倒數。 */
export function idleRemaining() {
  if (token === null) return 0;
  return Math.max(0, IDLE_MS - (Date.now() - lastActivity));
}
