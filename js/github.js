// GitHub Contents API 客戶端（規格第七節）。
//
// 每次儲存 = 一個 commit，訊息格式 `admin: <動作> <對象>`。
// 免費附贈完整修改紀錄與一鍵還原 —— 後台不需要自己做稽核日誌，
// git log 就是。
//
// 寫入一律用 blob SHA 做樂觀鎖。衝突時重新抓取並提示，不盲目覆寫：
// 兩個管理者同時開著後台、或排程同步剛好寫進同一個檔案，盲目覆寫會
// 把對方的修改整段吃掉而且沒有人會發現。

import { withToken } from './vault.js';

const API = 'https://api.github.com';

/** 這個檔案唯一會碰到的三個 header。 */
const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

/** UTF-8 安全的 base64（btoa 只吃 Latin-1，中文會直接丟例外）。 */
export function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 衝突時丟這個，讓呼叫端可以區分「要重試」與「真的壞了」。 */
export class ConflictError extends Error {
  constructor(message, latest) {
    super(message);
    this.name = 'ConflictError';
    this.latest = latest;      // { content, sha } 最新版本，供合併
  }
}

export class GitHubClient {
  /** repo：{ owner, name, branch } —— 從 data/config.json 讀，不寫死。 */
  constructor(repo) {
    this.repo = repo;
    this.base = `${API}/repos/${repo.owner}/${repo.name}/contents`;
  }

  get configured() {
    return Boolean(this.repo?.owner && this.repo?.name);
  }

  async #request(path, init = {}) {
    return withToken(async (token) => {
      const res = await fetch(path, {
        ...init,
        headers: { ...headers(token), ...(init.headers ?? {}) },
      });

      if (res.status === 401) {
        throw new Error('GitHub 拒絕了這把 token（401）。可能是密碼錯、token 已過期或已被撤銷。');
      }
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`GitHub 拒絕存取（403）：${body.message ?? '權限不足'}。`
          + 'token 需要這個 repo 的 Contents: Read and write 權限。');
      }
      if (res.status === 404) {
        throw new Error(`找不到 ${this.repo.owner}/${this.repo.name} 或該檔案（404）。`
          + '確認 config.json 的 repo 設定，以及 token 有存取這個 repo 的權限。');
      }
      return res;
    });
  }

  /**
   * 讀檔。回傳 { content, sha }。
   * sha 是 blob 的 SHA，寫回去時要帶著它 —— 那就是樂觀鎖。
   */
  async read(filePath) {
    const url = `${this.base}/${filePath}?ref=${encodeURIComponent(this.repo.branch ?? 'main')}`;
    const res = await this.#request(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`讀取 ${filePath} 失敗：HTTP ${res.status}`);
    const json = await res.json();
    return { content: fromBase64(json.content), sha: json.sha };
  }

  /**
   * 寫檔。
   *
   * sha 必填 —— 這是刻意的。GitHub 允許省略 sha 來建立新檔，但對既有檔案
   * 省略 sha 會直接失敗；把它設成必填，可以讓「忘記帶 sha」在開發期就
   * 爆掉，而不是在正式環境變成覆寫。
   */
  async write(filePath, { content, sha, message }) {
    if (!message?.startsWith('admin: ')) {
      throw new Error(`commit 訊息必須以 "admin: " 開頭，收到：${message}`);
    }

    const res = await this.#request(`${this.base}/${filePath}`, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: toBase64(content),
        sha,
        branch: this.repo.branch ?? 'main',
      }),
    });

    if (res.status === 409 || res.status === 422) {
      // 有人在我們讀取之後改過這個檔案。重抓最新版交給呼叫端處理，
      // 不要自作主張覆蓋 —— 被覆蓋掉的可能是另一個管理者剛下架的
      // 惡意內容。
      const latest = await this.read(filePath).catch(() => null);
      throw new ConflictError(
        `${filePath} 在你編輯期間被改過了（可能是排程同步或另一位管理者）。`
        + '已取回最新版本，請確認後重新儲存。',
        latest,
      );
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`寫入 ${filePath} 失敗：HTTP ${res.status} ${body.message ?? ''}`);
    }

    const json = await res.json();
    return { sha: json.content.sha, commit: json.commit.sha };
  }

  /**
   * 讀 → 改 → 寫，衝突時自動重試一次。
   *
   * mutate 收到目前內容、回傳新內容。重試時 mutate 會拿到最新版重跑，
   * 所以它必須是純函式（不要在裡面依賴外部快照）。
   */
  async update(filePath, mutate, message, { retries = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const { content, sha } = await this.read(filePath);
      const next = await mutate(content);
      if (next === content) return { unchanged: true };
      try {
        return await this.write(filePath, { content: next, sha, message });
      } catch (err) {
        if (err instanceof ConflictError && attempt < retries) continue;
        throw err;
      }
    }
  }

  /** 確認 token 真的能寫這個 repo。解鎖後先跑這個，錯了要立刻講。 */
  async verify() {
    const url = `${API}/repos/${this.repo.owner}/${this.repo.name}`;
    const res = await this.#request(url);
    if (!res.ok) throw new Error(`無法存取 repo：HTTP ${res.status}`);
    const json = await res.json();
    if (!json.permissions?.push) {
      throw new Error('這把 token 沒有寫入權限。需要 Contents: Read and write。');
    }
    return { fullName: json.full_name, private: json.private };
  }
}

// ------------------------------------------------------------- commit 訊息
//
// 規格第七節指定格式 `admin: <動作> <對象>`。集中在這裡產生，
// 讓 git log 的格式一致、可以被 grep。

export const commitMessage = {
  hideReview: (id) => `admin: hide review ${id}`,
  unhideReview: (id) => `admin: unhide review ${id}`,
  editReview: (id) => `admin: edit review ${id}`,
  suppressReview: (id) => `admin: suppress review ${id}`,
  unsuppressReview: (id) => `admin: unsuppress review ${id}`,
  editCourse: (id) => `admin: edit course ${id}`,
  addCourse: (id) => `admin: add course ${id}`,
  mergeCourse: (from, to) => `admin: merge course ${from} into ${to}`,
  releaseQuarantine: (n) => `admin: release ${n} quarantined submission(s)`,
  dropQuarantine: (n) => `admin: drop ${n} quarantined submission(s)`,
  editBlocklist: () => 'admin: edit blocklist',
};
