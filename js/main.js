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
    el('p', {}, '設計者 syaouei ｜ 資料與前身站台 by Bean1450'),
    el('p', { class: 'num' },
      `最後更新 ${updated}｜${courses.length} 門課、${reviewCount} 則心得` +
      (store.isLive() ? '｜含即時投稿' : '')),
    el('p', { class: 'disclaimer' },
      '所有心得為學生個人主觀經驗，課程內容與評分方式可能逐年變動。'),
  ]);
}

// ------------------------------------------------------------- 尚未完成的頁
// 階段三～六會逐一換成真的 view。留一個誠實的佔位頁，比讓導覽壞掉好。

const soon = (title) => async () => async () => {
  router.setMeta(title, `${title}（建置中）`);
  document.getElementById('main').replaceChildren(
    el('div', { class: 'wrap' }, [
      el('p', { class: 'empty' }, [
        el('strong', {}, `${title}`),
        el('br'),
        '這一頁還在建置中。',
        el('br'),
        el('a', { href: '#/' }, '← 回首頁'),
      ]),
    ]),
  );
};

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
router.define(/^\/admin$/, 'admin', soon('後台'));

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

// --------------------------------------------------------------- 外觀切換

function setupTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  const paint = (v) => {
    const { icon, label } = theme.themeLabel(v);
    btn.textContent = icon;
    btn.setAttribute('aria-label', label);
    btn.title = label + '（點擊切換）';
  };

  paint(theme.getTheme());
  btn.addEventListener('click', () => paint(theme.cycleTheme()));
}

// ------------------------------------------------------------- 投稿入口

function setupSubmitLink() {
  const a = document.getElementById('submit-link');
  if (!a) return;
  const url = store.getState().config?.forms?.submitUrl;
  if (!url) return;                    // 尚未設定，維持指向關於頁的說明
  a.href = url;
  a.target = '_blank';
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
})();
