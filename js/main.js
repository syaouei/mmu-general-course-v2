// 進入點。載資料 → 註冊路由 → 起跑。
//
// view 一律用原生 import() 動態載入，不引入打包工具（規格第十節）。
// 首屏只會下載 main / router / store / format / search / dom / ui 與首頁。

import { el, replace } from './dom.js';
import * as router from './router.js';
import * as store from './store.js';
import * as theme from './theme.js';
import { visibleReviews } from './format.js';

// --------------------------------------------------------------------- 頁尾

function renderFooter() {
  const meta = store.getMeta();
  const foot = document.getElementById('footer-body');
  if (!foot) return;

  // 「最後更新」從 meta.updatedAt 讀取，不再是手動維護的字串（規格第六節）。
  const updated = meta.updatedAt
    ? new Date(meta.updatedAt).toLocaleDateString('zh-Hant', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '未知';

  const courses = store.getCourses();
  const reviewCount = courses.reduce((a, c) => a + visibleReviews(c).length, 0);

  replace(foot, [
    el('p', {}, [el('strong', {}, '馬偕通識分享區 v2')]),
    el('p', {}, [
      '設計者 syaouei ｜ 資料與前身站台 by Bean1450 ｜ ',
      // 後台入口放在頁尾：每一頁都找得到，但不搶學生的注意力。
      // 公開放連結不會降低安全性 —— 規格第七節講得很清楚，藏路徑不算防護，
      // 真正的邊界是加密的 GitHub token 與密碼的熵。
      el('a', { href: '#/admin', rel: 'nofollow' }, '管理後台'),
    ]),
    el('p', { class: 'num' },
      `最後更新 ${updated}｜${courses.length} 門課、${reviewCount} 則心得`
      + (store.isLive() ? `｜含即時投稿 ${store.getLiveCount()} 則` : '')),
    el('p', { class: 'disclaimer' },
      '所有心得為學生個人主觀經驗，課程內容與評分方式可能逐年變動。'),
  ]);
}

// --------------------------------------------------------------------- 路由

router.define(/^\/$/, 'home', () => import('./views/home.js').then((m) => m.default));

router.define(/^\/d\/([^/]+)$/, 'domain',
  () => import('./views/domain.js').then((m) => m.default),
  (m) => ({ id: decodeURIComponent(m[1]) }));

router.define(/^\/c\/(.+)$/, 'course',
  () => import('./views/course.js').then((m) => m.default),
  (m) => ({ id: decodeURIComponent(m[1]) }));

router.define(/^\/search$/, 'search',
  () => import('./views/search.js').then((m) => m.default));

router.define(/^\/guide$/, 'guide',
  () => import('./views/guide.js').then((m) => m.default));

router.define(/^\/about$/, 'about',
  () => import('./views/about.js').then((m) => m.default));

// 後台只有真的走到 #/admin 才載入，平常一個 byte 都不下載。
// 它不是秘密 —— 藏路徑不算安全，robots.txt 擋收錄就夠了。
router.define(/^\/admin$/, 'admin',
  () => import('./views/admin.js').then((m) => m.default));

router.setNotFound(() => async (ctx) => {
  router.setMeta('找不到頁面', '這個網址不存在。');
  document.getElementById('main').replaceChildren(
    el('div', { class: 'wrap' }, [
      el('p', { class: 'empty' }, [
        el('strong', {}, '找不到這一頁'),
        el('br'),
        el('code', {}, '#' + ctx.path),
        el('br'), el('br'),
        el('a', { href: '#/' }, '← 回首頁'),
      ]),
    ]),
  );
});

// ----------------------------------------------------------------- 全域快捷鍵

addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  // 已經在輸入東西的時候不要搶走斜線。
  if (t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const q = document.getElementById('q');
  if (!q) return;
  e.preventDefault();
  q.focus();
  q.select();
});

// ------------------------------------------------------- 即時投稿進來之後
//
// 併入即時投稿後要重畫畫面，但重畫會把 DOM 整個換掉 —— 如果使用者正在
// 搜尋框打字（尤其是中文輸入法組字中），節點被換掉會讓輸入直接中斷。
// 所以：正在打字就先不動，等他離開輸入框或換頁再補上。

let pendingRefresh = false;

function isTyping() {
  const t = document.activeElement;
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

function onLiveData(s) {
  if (!s.live) return;
  if (isTyping()) {
    pendingRefresh = true;
    // 離開輸入框的那一刻補畫。once 讓它只觸發一次。
    document.addEventListener('focusout', flushRefresh, { once: true });
    return;
  }
  router.refresh();
}

function flushRefresh() {
  if (!pendingRefresh || isTyping()) return;
  pendingRefresh = false;
  router.refresh();
}

// --------------------------------------------------------------- 外觀切換

function setupTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  const paint = () => {
    const { icon, label } = theme.themeLabel();
    btn.textContent = icon;
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };

  paint();
  btn.addEventListener('click', () => { theme.toggleTheme(); paint(); });
  // 跟隨系統時，手機或電腦換外觀，按鈕圖示也要跟著換。
  theme.onSystemThemeChange(paint);
}

// ------------------------------------------------------------- 投稿入口

function setupSubmitLink() {
  const a = document.getElementById('submit-link');
  if (!a) return;
  const url = store.getState().config?.forms?.submitUrl;
  if (!url) return;                    // 尚未設定，維持指向關於頁的說明
  a.href = url;
  // 在同一個分頁打開。開新分頁的話，表單那頁沒有「上一頁」，按返回鍵沒反應，
  // 會以為網站壞掉（使用者 2026-09-15 實際遇到）。
  a.rel = 'noopener noreferrer';
}

// 目前所在的導覽項目標記 aria-current。
function markNav() {
  const { path } = router.parseHash();
  for (const a of document.querySelectorAll('.site-nav a')) {
    const href = a.getAttribute('href') ?? '';
    if (href.replace(/^#/, '') === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
addEventListener('hashchange', markNav);

// --------------------------------------------------------------------- 起跑

(async () => {
  const boot = document.getElementById('boot');
  try {
    await store.load();
  } catch (err) {
    console.error('[main] 資料載入失敗', err);
    document.getElementById('main').replaceChildren(
      el('div', { class: 'wrap' }, [
        el('p', { class: 'empty' }, [
          el('strong', {}, '資料載入失敗'),
          el('br'),
          '請重新整理頁面。如果你是直接用 file:// 開啟，瀏覽器會擋下 fetch，',
          '請改用本機伺服器（例如 npx serve）。',
        ]),
      ]),
    );
    if (boot) boot.remove();
    return;
  }

  store.subscribe(renderFooter);
  renderFooter();
  setupTheme();
  setupSubmitLink();
  if (boot) boot.remove();
  await router.start();
  markNav();

  // 烘焙資料已經上畫面了，這時才去抓即時投稿（規格第六節的雙軌讀取）。
  // 放在 router.start() 之後，首屏不會被這個請求拖慢。
  store.subscribe(onLiveData);
  store.loadLive();
})();
