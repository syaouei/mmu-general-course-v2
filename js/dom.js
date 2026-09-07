// 安全建立節點的小工具。
//
// 全專案禁止對任何投稿內容使用 innerHTML（規格第三、十三節）。這個模組刻意
// 不提供任何接受 HTML 字串的函式 —— 沒有那個入口，就不會有人不小心用到。
// 文字一律走 textContent／createTextNode，瀏覽器不會把它當標記解析。

/** 屬性名 → 要走 property 而不是 setAttribute 的例外。 */
const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden']);

/**
 * 建立元素。
 *   el('a', { href: '#/', class: 'brand' }, '首頁')
 *   el('li', {}, [el('span', {}, code), ' ', name])
 *
 * children 可以是字串、節點、null（略過）、或以上組成的陣列。
 * 字串一律當成純文字。
 */
export function el(tag, attrs = null, children = null) {
  const node = document.createElement(tag);

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v)) {
          if (dv !== null && dv !== undefined) node.dataset[dk] = String(dv);
        }
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (PROPS.has(k)) {
        node[k] = v;
      } else {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }

  append(node, children);
  return node;
}

/** 把 children 掛到 parent 底下。字串變文字節點，絕不解析為標記。 */
export function append(parent, children) {
  if (children === null || children === undefined) return parent;
  if (Array.isArray(children)) {
    for (const c of children) append(parent, c);
    return parent;
  }
  parent.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
  return parent;
}

/** 純文字節點。 */
export const text = (s) => document.createTextNode(s === null || s === undefined ? '' : String(s));

/** 文件片段，用來一次掛上多個節點。 */
export function frag(children) {
  return append(document.createDocumentFragment(), children);
}

/** 清空節點。比 innerHTML = '' 安全，也順手斷開子節點。 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 清空後放入新內容。 */
export function replace(node, children) {
  return append(clear(node), children);
}

/**
 * 把含換行的純文字渲染成保留段落的節點串。
 * 心得內文用這個 —— \n 變成 <br>，但文字本身永遠是文字節點。
 */
export function multiline(str) {
  const f = document.createDocumentFragment();
  const lines = String(str ?? '').split('\n');
  lines.forEach((line, i) => {
    if (i > 0) f.appendChild(document.createElement('br'));
    f.appendChild(document.createTextNode(line));
  });
  return f;
}
