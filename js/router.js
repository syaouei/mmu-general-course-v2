// hash router。
//
// 舊站每門課有獨立可分享網址，這個優點不能弄丟（規格第五節）。所有狀態
// ——包括搜尋條件與排序—— 都寫進網址，所以任何畫面都可以直接複製貼給別人。
//
//   #/                        首頁
//   #/d/tian                  領域頁
//   #/c/HE139A-caiweimin      課程頁
//   #/search?q=易經&sweet=8   搜尋結果
//   #/guide  #/about  #/admin

const routes = [];
let notFound = null;
let current = null;

/**
 * 註冊路由。
 *   define(/^\/c\/(.+)$/, 'course', (m) => ({ id: decodeURIComponent(m[1]) }))
 * loader 是動態 import 的函式，只有真的走到這條路由才會載入模組。
 */
export function define(pattern, name, loader, mapParams = () => ({})) {
  routes.push({ pattern, name, loader, mapParams });
}

export function setNotFound(loader) {
  notFound = loader;
}

/** 把 '#/search?q=x&sweet=8' 拆成 { path, query }。 */
export function parseHash(hash = location.hash) {
  const raw = String(hash).replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = qi === -1 ? raw : raw.slice(0, qi);
  const query = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  return { path: path.startsWith('/') ? path : '/' + path, query };
}

/** 組出網址。條件寫進 query，貼給別人就是同一個畫面。 */
export function buildHash(path, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return `#${path}${s ? '?' + s : ''}`;
}

/** 真的要換頁時用這個。會觸發 hashchange，路由重跑、view 重新渲染。 */
export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (location.hash === target) return;
  location.hash = target;
}

/**
 * 把目前 view 的狀態（搜尋字串、排序、篩選）鏡射到網址列。
 *
 * 只改網址，**不重跑路由**。view 自己已經渲染過了，再跑一次會把整個
 * #main 換掉 —— 連帶把使用者正在打字的 <input> 換成新節點、焦點掉光。
 * 中文輸入法組字中遇到這件事會直接中斷，打一個注音就跳出來。
 *
 * history.replaceState 不會觸發 hashchange，所以這裡不會有隱性的重繪；
 * 同時也不留下歷史紀錄，打字才不會塞爆上一頁。
 */
export function syncUrl(hash) {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (location.hash === target) return;
  history.replaceState(null, '', target);
}

export const getCurrent = () => current;

/** 更新 document.title 與 meta description。每次切換都要做（規格第五、九節）。 */
export function setMeta(title, description) {
  const full = title ? `${title}｜馬偕通識分享區` : '馬偕通識分享區';
  document.title = full;
  // 每次切頁都先清掉上一頁的結構化資料，需要的 view 會自己再設一次。
  setJsonLd(null);
  let tag = document.querySelector('meta[name="description"]');
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', 'description');
    document.head.appendChild(tag);
  }
  if (description) tag.setAttribute('content', description);

  // Open Graph 同步，社群分享時標題才會對。
  for (const [prop, val] of [['og:title', full], ['og:description', description]]) {
    if (!val) continue;
    let og = document.querySelector(`meta[property="${prop}"]`);
    if (!og) {
      og = document.createElement('meta');
      og.setAttribute('property', prop);
      document.head.appendChild(og);
    }
    og.setAttribute('content', val);
  }
}

/**
 * 設定或清除結構化資料（規格第九節的 JSON-LD）。
 *
 * 傳 null 就移除 —— 切換路由時一定要清掉，不然課程頁的結構化資料會
 * 殘留在首頁上，變成對爬蟲的錯誤宣告。
 *
 * 內容用 textContent 寫入。JSON.stringify 的輸出不會含 </script>，
 * 但走 textContent 就不必依賴這個假設。
 */
export function setJsonLd(obj) {
  const ID = 'ld-json';
  document.getElementById(ID)?.remove();
  if (!obj) return;
  const s = document.createElement('script');
  s.type = 'application/ld+json';
  s.id = ID;
  s.textContent = JSON.stringify(obj);
  document.head.appendChild(s);
}

let pending = 0;

async function handle() {
  const { path, query } = parseHash();
  const token = ++pending;

  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (!m) continue;

    const ctx = { name: r.name, path, query, params: r.mapParams(m) };
    current = ctx;
    const view = await r.loader();
    if (token !== pending) return;          // 期間又切了路由，放棄這次渲染
    await view(ctx);
    focusMain();
    return;
  }

  if (notFound) {
    const view = await notFound();
    if (token !== pending) return;
    await view({ name: 'notfound', path, query, params: {} });
    focusMain();
  }
}

/**
 * 切頁後把焦點移到主要內容，並捲回頂端。
 * 螢幕閱讀器使用者切頁後不會還停在上一頁的位置。
 */
function focusMain() {
  const main = document.getElementById('main');
  if (!main) return;
  main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/** 重跑目前這條路由。資料在背景更新後要重畫畫面時用。 */
export function refresh() {
  return handle();
}

export function start() {
  addEventListener('hashchange', handle);
  return handle();
}
