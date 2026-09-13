// 後台（規格第七節）。只有真的走到 #/admin 才會載入這支。
//
// 所有修改都透過 GitHub Contents API 寫回 repo，每次儲存 = 一個 commit。
// 讀取也走 API 而不是讀本機靜態檔 —— 因為寫入需要 blob SHA 做樂觀鎖，
// 而且要確保看到的是最新版，不是 CDN 快取的舊版。

import { el, replace, clear, multiline } from '../dom.js';
import { setMeta } from '../router.js';
import * as store from '../store.js';
import * as vault from '../vault.js';
import { GitHubClient, commitMessage, ConflictError } from '../github.js';
import { formatTerm, courseStats, NONE } from '../format.js';
import { domainClass } from '../ui.js';

const FILES = {
  courses: 'data/courses.json',
  suppressed: 'data/suppressed.json',
  quarantine: 'data/quarantine.json',
  blocklist: 'scripts/blocklist.txt',
};

let gh = null;
const files = {};          // path → { content, sha, data }

export default async function admin() {
  setMeta('後台', '管理介面。');
  const main = document.getElementById('main');
  const root = el('div', { class: 'wrap admin' });
  main.replaceChildren(root);

  vault.onLock((reason) => {
    gh = null;
    for (const k of Object.keys(files)) delete files[k];
    // reason === 'failed' 代表解鎖流程自己在處理錯誤顯示，這時重繪會把
    // 正要寫入訊息的那個 status 元素換掉，錯誤就永遠顯示不出來。
    if (reason !== 'failed') renderLock(root, reason);
  });

  if (vault.isUnlocked() && gh) renderConsole(root);
  else renderLock(root, null);
}

// ==================================================================== 上鎖畫面

function renderLock(root, reason) {
  const status = el('p', { class: 'admin-msg', role: 'status', 'aria-live': 'polite' },
    reason === 'idle' ? '閒置超過 15 分鐘，已自動上鎖。' : '');

  const input = el('input', {
    type: 'password', id: 'admin-pw', autocomplete: 'current-password',
    placeholder: '通關密語', 'aria-describedby': 'admin-pw-help',
  });

  const button = el('button', { class: 'btn btn-primary', type: 'submit' }, '解鎖');

  const form = el('form', {
    class: 'admin-lock',
    onsubmit: async (e) => {
      e.preventDefault();
      const pw = input.value;
      if (!pw) return;

      button.disabled = true;
      button.textContent = '解密中⋯⋯';
      status.textContent = 'PBKDF2 600,000 次，在手機上可能要幾秒。';

      try {
        await vault.unlock(pw);
        input.value = '';

        const repo = store.getState().config?.repo ?? {};
        gh = new GitHubClient(repo);
        if (!gh.configured) {
          throw new Error('data/config.json 的 repo.owner / repo.name 還沒填，'
            + '後台無法寫回任何東西。填好後重新整理再試。');
        }
        const info = await gh.verify();
        status.textContent = `已連上 ${info.fullName}`;
        await loadAll();
        renderConsole(root);
      } catch (err) {
        // 解鎖成功但後續失敗（repo 設定錯、token 沒權限）時，token 已經
        // 在記憶體裡了，一定要清掉 —— 不然畫面停在上鎖狀態，token 卻還活著。
        if (vault.isUnlocked()) vault.lock('failed');
        gh = null;
        button.disabled = false;
        button.textContent = '解鎖';
        status.textContent = err.message;
        status.classList.add('is-error');
        input.value = '';
        input.focus();
      }
    },
  }, [
    el('label', { for: 'admin-pw' }, '密碼'),
    input,
    button,
  ]);

  replace(root, [
    el('header', { class: 'page-head' }, [
      el('p', { class: 'crumb' }, [el('a', { href: '#/' }, '首頁'), ' ／ 後台']),
      el('h1', {}, '後台'),
    ]),

    form,
    status,

    el('section', { class: 'admin-note', id: 'admin-pw-help' }, [
      el('h2', {}, '這個密碼在做什麼'),
      el('p', {},
        '它不是用來驗證你是誰的。純靜態網站沒辦法做真正的身分驗證 ——'
        + '把密碼或它的雜湊寫進 JS 比對，那段程式跑在使用者自己的機器上，'
        + '改一行就過了。'),
      el('p', {},
        '這個密碼的工作是解密一把 GitHub token。沒有正確密碼，AES-GCM '
        + '解出來的是垃圾，GitHub 直接回 401。逆向這個網站的程式碼沒有用，'
        + '因為程式碼裡沒有秘密 —— 秘密在密文裡。'),
      el('p', {},
        '代價要講清楚：'),
      el('ul', {}, [
        el('li', {}, 'admin/vault.enc 是公開檔案，任何人都能下載回去離線爆破。'),
        el('li', {}, 'PBKDF2 60 萬次只能拉高每次嘗試的成本，不能歸零。'),
        el('li', {}, '防線完全落在密碼的熵上，所以它必須是長通關密語，不能是 mmc2026 這種。'),
        el('li', {}, 'token 只存在記憶體裡，重新整理就失效，閒置 15 分鐘自動上鎖。'),
      ]),
    ]),
  ]);

  input.focus();
}

// ==================================================================== 讀取檔案

async function loadAll() {
  for (const [key, path] of Object.entries(FILES)) {
    try {
      const { content, sha } = await gh.read(path);
      files[key] = {
        path, content, sha,
        data: path.endsWith('.json') ? JSON.parse(content) : content,
      };
    } catch (err) {
      // quarantine.json 可能還不存在（第一次同步前）。那不是錯誤。
      if (key === 'quarantine') {
        files[key] = { path, content: '', sha: null, data: { items: [] } };
      } else {
        throw err;
      }
    }
  }
}

/** courses.json 寫回去前重算 meta，validate-data.mjs 會檢查一致性。 */
function serializeCourses(data) {
  const reviewCount = data.courses.reduce((a, c) => a + c.reviews.length, 0);
  const next = {
    ...data,
    meta: {
      ...data.meta,
      updatedAt: new Date().toISOString(),
      courseCount: data.courses.length,
      reviewCount,
    },
  };
  return JSON.stringify(next, null, 2) + '\n';
}

/**
 * 統一的儲存流程：二次確認 → 寫入 → 更新本機 SHA。
 * 每一個破壞性動作都走這裡，確認框一定會顯示將產生的 commit 訊息。
 */
async function save(key, message, mutateData, { confirmText } = {}) {
  const ok = await confirmAction(message, confirmText);
  if (!ok) return false;

  const f = files[key];
  mutateData(f.data);
  const content = f.path.endsWith('.json')
    ? (key === 'courses' ? serializeCourses(f.data) : JSON.stringify(f.data, null, 2) + '\n')
    : f.data;

  try {
    const res = await gh.write(f.path, { content, sha: f.sha, message });
    f.sha = res.sha;
    f.content = content;
    toast(`已儲存 · commit ${res.commit.slice(0, 7)}`);
    return true;
  } catch (err) {
    if (err instanceof ConflictError) {
      // 重新載入全部，讓管理者看到最新狀態再決定。盲目重試會蓋掉別人的修改。
      await loadAll();
      toast(err.message, 'error');
    } else {
      toast(err.message, 'error');
    }
    return false;
  }
}

// ==================================================================== 確認框

function confirmAction(commitMsg, extra) {
  return new Promise((resolve) => {
    const dialog = el('div', { class: 'admin-confirm-backdrop' }, [
      el('div', { class: 'admin-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': '確認操作' }, [
        el('h2', {}, '確認這個動作'),
        extra ? el('p', {}, extra) : null,
        el('p', { class: 'admin-commit' }, [
          el('span', {}, '將產生的 commit：'),
          el('code', {}, commitMsg),
        ]),
        el('p', { class: 'admin-note-sm' }, '所有修改都會留在 git 紀錄裡，隨時可以還原。'),
        el('div', { class: 'admin-actions' }, [
          el('button', {
            class: 'btn', type: 'button',
            onclick: () => { dialog.remove(); resolve(false); },
          }, '取消'),
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: () => { dialog.remove(); resolve(true); },
          }, '確認執行'),
        ]),
      ]),
    ]);
    document.body.appendChild(dialog);
    dialog.querySelector('.btn-primary').focus();
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { dialog.remove(); resolve(false); }
    });
  });
}

function toast(msg, kind = 'ok') {
  const box = document.getElementById('admin-toast');
  if (!box) return;
  box.textContent = msg;
  box.className = `admin-toast is-${kind}`;
  clearTimeout(box._t);
  box._t = setTimeout(() => { box.textContent = ''; box.className = 'admin-toast'; }, 6000);
}

// ==================================================================== 主控台

const TABS = [
  { id: 'reviews', label: '心得' },
  { id: 'quarantine', label: '待審區' },
  { id: 'courses', label: '課程' },
  { id: 'blocklist', label: '封鎖字表' },
];

function renderConsole(root) {
  let active = 'reviews';
  const panel = el('div', { class: 'admin-panel' });

  const countdown = el('span', { class: 'admin-countdown num' });
  const tick = setInterval(() => {
    if (!vault.isUnlocked()) { clearInterval(tick); return; }
    const ms = vault.idleRemaining();
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    countdown.textContent = `${m}:${String(s).padStart(2, '0')} 後自動上鎖`;
  }, 1000);

  const nav = el('nav', { class: 'admin-tabs', 'aria-label': '後台功能' },
    TABS.map((t) => el('button', {
      class: 'admin-tab', type: 'button',
      'aria-current': active === t.id ? 'page' : null,
      onclick: (e) => {
        active = t.id;
        for (const b of nav.querySelectorAll('.admin-tab')) b.removeAttribute('aria-current');
        e.currentTarget.setAttribute('aria-current', 'page');
        renderPanel(panel, active);
      },
    }, t.label)));

  replace(root, [
    el('header', { class: 'page-head' }, [
      el('p', { class: 'crumb' }, [el('a', { href: '#/' }, '首頁'), ' ／ 後台']),
      el('h1', {}, [
        '後台',
        el('span', { class: 'sub' }, `${gh.repo.owner}/${gh.repo.name}`),
      ]),
    ]),
    el('div', { class: 'admin-bar' }, [
      countdown,
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => { clearInterval(tick); vault.lock('manual'); },
      }, '立即上鎖'),
    ]),
    el('div', { class: 'admin-toast', id: 'admin-toast' }),
    nav,
    panel,
  ]);

  renderPanel(panel, active);
}

function renderPanel(panel, tab) {
  if (tab === 'reviews') return renderReviews(panel);
  if (tab === 'quarantine') return renderQuarantine(panel);
  if (tab === 'courses') return renderCourses(panel);
  if (tab === 'blocklist') return renderBlocklist(panel);
}

// -------------------------------------------------------------------- 心得

function renderReviews(panel) {
  const data = files.courses.data;
  const suppressed = new Set(files.suppressed.data.ids ?? []);

  const search = el('input', {
    type: 'search', placeholder: '課程代碼、課名或教師⋯⋯', class: 'admin-search',
  });
  const list = el('div', {});

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = data.courses.filter((c) =>
      !q || [c.code, c.name, c.teacher].some((v) => String(v ?? '').toLowerCase().includes(q)));

    replace(list, hits.slice(0, 30).map((course) => el('details', { class: 'admin-course' }, [
      el('summary', {}, [
        el('code', {}, course.code ?? NONE),
        el('span', { class: 'name' }, course.name ?? '（無課名）'),
        el('span', { class: 'muted' }, course.teacher ?? '教師不明'),
        el('span', { class: 'muted num' }, `${course.reviews.length} 則`),
      ]),
      ...course.reviews.map((r) => renderReviewRow(course, r, suppressed, draw)),
    ])));

    if (hits.length > 30) {
      list.appendChild(el('p', { class: 'admin-note-sm' },
        `另有 ${hits.length - 30} 門課沒有列出，請用搜尋縮小範圍。`));
    }
  };

  search.addEventListener('input', draw);
  replace(panel, [
    el('p', { class: 'admin-note-sm' },
      '隱藏＝軟刪除，內容留在資料檔裡但不顯示、不計入統計。'
      + '抑制＝寫進 suppressed.json，這是唯一能擋掉即時 CSV 來源的機制。'),
    search,
    list,
  ]);
  draw();
}

function renderReviewRow(course, r, suppressed, redraw) {
  const isSup = suppressed.has(r.id);

  const body = el('div', { class: 'admin-review-body' }, multiline(r.text));

  const editBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '編輯內文');
  editBtn.addEventListener('click', () => {
    const ta = el('textarea', { class: 'admin-textarea', rows: 8 }, r.text);
    const cancel = el('button', { class: 'btn btn-sm', type: 'button' }, '取消');
    const confirm = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, '儲存');

    const editor = el('div', { class: 'admin-editor' }, [
      ta,
      el('p', { class: 'admin-note-sm' }, '原文會自動保存在 originalText，永久保留。'),
      el('div', { class: 'admin-actions' }, [cancel, confirm]),
    ]);
    body.replaceWith(editor);
    ta.focus();

    cancel.onclick = () => editor.replaceWith(body);
    confirm.onclick = async () => {
      const next = ta.value;
      if (next === r.text) { editor.replaceWith(body); return; }
      const ok = await save('courses', commitMessage.editReview(r.id), (d) => {
        const target = findReview(d, r.id);
        target.originalText ??= target.text;   // 只保存第一次的原文
        target.text = next;
        target.editedAt = new Date().toISOString();
      }, { confirmText: '編輯後的內容會取代站上顯示的文字，原文保存在 originalText。' });
      if (ok) redraw();
      else editor.replaceWith(body);
    };
  });

  return el('article', { class: `admin-review${r.hidden ? ' is-hidden' : ''}` }, [
    el('div', { class: 'admin-review-meta' }, [
      el('code', {}, r.id),
      el('span', {}, formatTerm(r.term)),
      el('span', {}, r.stars === null ? NONE : `${r.stars}★`),
      el('span', { class: 'muted' }, r.source === 'form' ? '表單投稿' : '舊站'),
      r.hidden ? el('span', { class: 'admin-flag' }, '已隱藏') : null,
      isSup ? el('span', { class: 'admin-flag' }, '已抑制') : null,
      r.editedAt ? el('span', { class: 'admin-flag' }, '已編輯') : null,
      r.maskedFields?.length ? el('span', { class: 'admin-flag' }, `已遮罩 ${r.maskedFields.join('/')}`) : null,
    ]),
    body,
    el('div', { class: 'admin-actions' }, [
      el('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
          const hiding = !r.hidden;
          const msg = hiding ? commitMessage.hideReview(r.id) : commitMessage.unhideReview(r.id);
          const reason = hiding ? prompt('隱藏原因（會寫進資料檔，可留空）：') : null;
          if (hiding && reason === null) return;   // 按了取消
          const ok = await save('courses', msg, (d) => {
            const t = findReview(d, r.id);
            if (hiding) {
              t.hidden = true;
              t.hiddenReason = reason || '未說明';
              t.hiddenAt = new Date().toISOString();
            } else {
              t.hidden = false;
              delete t.hiddenReason;
              delete t.hiddenAt;
            }
          }, {
            confirmText: hiding
              ? '這則心得會從站上消失，但內容留在資料檔裡，隨時可以還原。'
              : '這則心得會重新顯示在站上。',
          });
          if (ok) redraw();
        },
      }, r.hidden ? '還原' : '隱藏'),

      editBtn,

      el('button', {
        class: 'btn btn-sm btn-danger', type: 'button',
        onclick: async () => {
          const msg = isSup ? commitMessage.unsuppressReview(r.id) : commitMessage.suppressReview(r.id);
          const ok = await save('suppressed', msg, (d) => {
            d.ids ??= [];
            if (isSup) d.ids = d.ids.filter((x) => x !== r.id);
            else if (!d.ids.includes(r.id)) d.ids.push(r.id);
          }, {
            confirmText: isSup
              ? '移出抑制清單後，這則心得如果還在表單 CSV 裡，會重新出現在站上。'
              : '抑制清單是唯一能擋掉即時 CSV 來源的機制。'
                + '只隱藏而不抑制的話，來自表單的內容下一次載入還是會出現。',
          });
          if (ok) {
            if (isSup) suppressed.delete(r.id); else suppressed.add(r.id);
            redraw();
          }
        },
      }, isSup ? '解除抑制' : '加入抑制清單'),
    ]),
  ]);
}

function findReview(data, id) {
  for (const c of data.courses) {
    const r = c.reviews.find((x) => x.id === id);
    if (r) return r;
  }
  throw new Error(`找不到心得 ${id}`);
}

// ------------------------------------------------------------------ 待審區

function renderQuarantine(panel) {
  const items = files.quarantine.data.items ?? [];

  if (!items.length) {
    replace(panel, el('p', { class: 'empty' }, '待審區是空的。'));
    return;
  }

  const draw = () => replace(panel, [
    el('p', { class: 'admin-note-sm' },
      `${items.length} 筆被自動品質閘擋下。放行會把它寫進 courses.json；`
      + '丟棄只從待審區移除，下一次同步時如果那筆投稿還在表單裡，會再被擋下來一次。'),
    ...items.map((item, i) => el('article', { class: 'admin-review' }, [
      el('div', { class: 'admin-review-meta' }, [
        el('code', {}, item.fields.code || '（無代碼）'),
        el('span', {}, item.fields.name || '（無課名）'),
        el('span', { class: 'muted' }, item.fields.teacher || '（無教師）'),
        el('span', {}, formatTerm(item.fields.term)),
      ]),
      el('ul', { class: 'admin-reasons' }, item.reasons.map((x) => el('li', {}, x))),
      el('div', { class: 'admin-review-body' }, multiline(item.fields.text)),
      el('div', { class: 'admin-actions' }, [
        el('button', {
          class: 'btn btn-sm btn-primary', type: 'button',
          onclick: async () => {
            const ok = await releaseOne(item);
            if (ok) { items.splice(i, 1); draw(); }
          },
        }, '放行'),
        el('button', {
          class: 'btn btn-sm btn-danger', type: 'button',
          onclick: async () => {
            const ok = await save('quarantine', commitMessage.dropQuarantine(1), (d) => {
              d.items = (d.items ?? []).filter((x) => x !== item);
            }, { confirmText: '這筆會從待審區移除。它不會被寫進網站資料。' });
            if (ok) { items.splice(i, 1); draw(); }
          },
        }, '丟棄'),
      ]),
    ])),
  ]);

  draw();
}

/** 放行一筆：寫進 courses.json，再從待審區移除。 */
async function releaseOne(item) {
  const mod = await import('../submissions.js');
  const f = item.fields;

  const ok = await save('courses', commitMessage.releaseQuarantine(1), (d) => {
    const { courses } = mod.mergeSubmissions(d, [{ fields: f, masked: item.masked ?? [] }], {
      pinyinMap: store.getState().pinyinMap ?? {},
      suppressed: new Set(files.suppressed.data.ids ?? []),
    });
    d.courses = courses;
  }, { confirmText: `「${f.name}」這筆會寫進 courses.json 並顯示在站上。` });

  if (!ok) return false;

  // courses.json 寫成功了才動待審區，順序反過來會在中途失敗時弄丟資料。
  await save('quarantine', commitMessage.dropQuarantine(1), (d) => {
    d.items = (d.items ?? []).filter((x) => x !== item);
  }, { confirmText: '把剛才放行的那筆從待審區移除。' });

  return true;
}

// -------------------------------------------------------------------- 課程

function renderCourses(panel) {
  const data = files.courses.data;
  const domains = data.domains;

  const search = el('input', { type: 'search', placeholder: '搜尋課程⋯⋯', class: 'admin-search' });
  const list = el('div', {});

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = data.courses.filter((c) =>
      !q || [c.code, c.name, c.teacher].some((v) => String(v ?? '').toLowerCase().includes(q)));

    replace(list, hits.slice(0, 40).map((c) => {
      const fields = {};
      const field = (key, label, value) => {
        const input = el('input', { type: 'text', value: value ?? '', class: 'admin-input' });
        fields[key] = input;
        return el('label', { class: 'admin-field' }, [el('span', {}, label), input]);
      };
      const select = el('select', { class: 'admin-input' },
        domains.map((d) => el('option', { value: d.id, selected: c.domain === d.id }, d.name)));
      fields.domain = select;

      return el('div', { class: `admin-course-edit ${domainClass(c.domain)}` }, [
        el('div', { class: 'admin-review-meta' }, [
          el('code', {}, c.id),
          el('span', { class: 'muted num' }, `${c.reviews.length} 則`),
          c.needsReview ? el('span', { class: 'admin-flag' }, '待確認：' + c.needsReview.join('、')) : null,
        ]),
        el('div', { class: 'admin-fields' }, [
          field('code', '代碼', c.code),
          field('name', '課名', c.name),
          field('teacher', '教師', c.teacher),
          el('label', { class: 'admin-field' }, [el('span', {}, '領域'), select]),
        ]),
        el('div', { class: 'admin-actions' }, [
          el('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: async () => {
              const next = {
                code: fields.code.value.trim() || null,
                name: fields.name.value.trim(),
                teacher: fields.teacher.value.trim(),
                domain: fields.domain.value,
              };
              const ok = await save('courses', commitMessage.editCourse(c.id), (d) => {
                const t = d.courses.find((x) => x.id === c.id);
                Object.assign(t, next);
                if (t.needsReview) delete t.needsReview;
              }, {
                confirmText: '課程 id 不會跟著改 —— id 已經進了網址，改了會讓所有分享出去的連結失效。',
              });
              if (ok) draw();
            },
          }, '儲存'),
        ]),
      ]);
    }));
  };

  search.addEventListener('input', draw);
  replace(panel, [
    el('p', { class: 'admin-note-sm' },
      '課程 id 一旦建立就不會變動，因為它已經進了網址。'
      + '改代碼或教師只改顯示內容，不會產生新的網址。'),
    search,
    list,
  ]);
  draw();
}

// ---------------------------------------------------------------- 封鎖字表

function renderBlocklist(panel) {
  const ta = el('textarea', { class: 'admin-textarea', rows: 24 }, files.blocklist.data);

  replace(panel, [
    el('p', { class: 'admin-note-sm' },
      '一行一個詞，# 開頭是註解。命中的投稿會進待審區，不會被直接丟棄 ——'
      + '這份表一定會有誤判（例如引用他人辱罵來說明課堂狀況），所以要留得住。'),
    ta,
    el('div', { class: 'admin-actions' }, [
      el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: async () => {
          const next = ta.value;
          if (next === files.blocklist.data) { toast('沒有變動。'); return; }
          await save('blocklist', commitMessage.editBlocklist(), () => {
            files.blocklist.data = next;
          }, { confirmText: '封鎖字表會立刻對執行期與建置期的品質閘生效。' });
        },
      }, '儲存封鎖字表'),
    ]),
  ]);
}
