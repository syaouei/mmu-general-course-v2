// 建立／輪替 admin/vault.enc（規格第七節）。
//
//   node scripts/make-vault.mjs
//
// 依序詢問 GitHub token 與密碼（輸入都不會顯示在畫面上），用 PBKDF2-SHA256
// 600,000 次導出金鑰，以 AES-256-GCM 加密 token，寫成 admin/vault.enc。
//
// token 刻意用互動輸入：寫在命令列參數上會留在終端機歷史裡，等於把明文
// token 存在硬碟上。（--token 參數仍保留，只給自動化測試用。）
//
// 密碼從不被存在任何地方，連雜湊都沒有 —— 沒有可以比對的東西，就沒有
// 「比對邏輯被繞過」這個攻擊面。忘記密碼的唯一辦法是拿新 token 重做一份。
//
// 路徑以這支腳本的位置為準：從哪個目錄執行，都會寫到這個專案的 admin/ 底下。
//
// ⚠️ 這支腳本會碰到明文 token，只在你自己的機器上跑，不要放進 CI。

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ITERATIONS = 600_000;
const KEY_LEN = 32;      // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;       // GCM 標準長度
const MIN_BITS = 60;

/**
 * 公開在這個 repo 文件裡的範例密碼。
 *
 * 範例是用來示範「格式」的，但人很容易直接照抄 —— 而這些字串任何人都能
 * 在 README 裡讀到，拿來加密等於沒加密。這裡直接拒絕，不給 yes 覆寫。
 */
const PUBLISHED_EXAMPLES = new Set([
  '鯨魚-鉛筆-火山-拖鞋-42',
  'correct-horse-battery-staple',
]);

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

// --out 有給就照 CLI 慣例相對於目前目錄；沒給就寫到專案的 admin/。
const OUT = argOf('--out') ? resolve(argOf('--out')) : join(ROOT, 'admin', 'vault.enc');

// 略過「先向 GitHub 確認 token」那一步。只給自動化測試用（測試用的是假 token）。
const SKIP_VERIFY = args.includes('--skip-verify');

// --------------------------------------------------------------------- 輸入

/**
 * 沒有可以打字的視窗，也沒有人用 pipe 餵輸入。
 *
 * 從編輯器的 Run 按鈕、排程或其他自動執行的方式啟動時就會這樣。舊版在這種
 * 情況直接回報「沒有輸入 token」—— 使用者其實根本沒機會輸入，卻被告知是
 * 自己漏了，只好一直重試同一個不可能成功的做法。
 */
class NoTerminalError extends Error {}

let pipedLines;   // undefined：還沒讀過　null：確定沒有任何輸入

function readPipedLines(waitMs = 1500) {
  return new Promise((done) => {
    const stdin = process.stdin;
    const chunks = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', finish);
      // 不銷毀的話，某些啟動方式會讓 stdin 一直掛著，行程永遠結束不了。
      stdin.destroy();
      done(chunks.length ? Buffer.concat(chunks).toString('utf8').split(/\r?\n/) : null);
    };
    const onData = (c) => chunks.push(c);

    // 有些啟動方式會讓 stdin 保持開啟卻永遠不給資料。等一下還是空的，
    // 就當成沒有輸入，不要讓人對著一個不會動的視窗乾等。
    const timer = setTimeout(() => { if (!chunks.length) finish(); }, waitMs);

    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.resume();
  });
}

/**
 * 讀一行。hidden 為 true 時輸入不回顯。
 * 沒有 TTY（被 pipe）時逐行讀 stdin，連續問好幾次也拿得到各自那一行。
 */
async function ask(prompt, { hidden = false } = {}) {
  if (!process.stdin.isTTY) {
    if (pipedLines === undefined) pipedLines = await readPipedLines();
    if (pipedLines === null) throw new NoTerminalError();
    process.stdout.write(`${prompt}\n`);
    return (pipedLines.shift() ?? '').trim();
  }

  process.stdout.write(prompt);
  const stdin = process.stdin;

  return new Promise((resolveAnswer, reject) => {
    let value = '';
    let esc = 0;   // 0：一般　1：剛收到 ESC　2：在方向鍵之類的控制序列裡

    const finish = (settle) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      settle();
    };

    const onData = (chunk) => {
      // 貼上時整段文字（可能連同 Enter）會在同一個 chunk 裡進來，
      // 所以逐字處理，而不是把整個 chunk 當成一個按鍵。
      for (const ch of chunk) {
        if (esc === 1) { esc = ch === '[' ? 2 : 0; continue; }
        if (esc === 2) { if (/[@-~]/.test(ch)) esc = 0; continue; }

        if (ch === '\r' || ch === '\n' || ch === '') {      // Enter / Ctrl-D
          finish(() => resolveAnswer(value.trim()));
          return;
        }
        if (ch === '') {                                     // Ctrl-C
          finish(() => reject(new Error('已取消。')));
          return;
        }
        if (ch === '' || ch === '\b') {                      // Backspace
          value = [...value].slice(0, -1).join('');
          if (!hidden) process.stdout.write('\b \b');
          continue;
        }
        if (ch === '') { esc = 1; continue; }               // 方向鍵等
        if (ch >= ' ') {
          value += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

// --------------------------------------------------------------------- 檢查

function checkToken(token) {
  if (!token) return { error: '沒有輸入 token。' };
  if (/\s/.test(token)) return { error: 'token 裡不應該有空白，可能複製到多餘的字了。' };
  if (token.startsWith('github_pat_')) return {};
  if (token.startsWith('ghp_')) {
    return {
      warn: [
        '這是「classic」token（ghp_ 開頭）。',
        'classic token 沒辦法限定只能動一個 repo —— 給了寫入權限，就能改你帳號底下',
        '「所有」repo。這把 token 外洩時，損害範圍是整個 GitHub 帳號，不只這個網站。',
        '強烈建議改用 Fine-grained token（github_pat_ 開頭），只授權這一個 repo。',
      ],
    };
  }
  return { warn: ['這看起來不像 GitHub token（通常是 github_pat_ 開頭）。'] };
}

/**
 * 寫出金鑰檔之前，先問 GitHub 這串 token 能不能用。
 *
 * 沒有這一步的話，貼錯的 token（複製到舊的、已作廢的，或跑完之後又按了
 * Regenerate）要等到提交、部署、打開後台解鎖之後才會發現 —— 每繞一圈就是
 * 好幾分鐘，畫面上又只看得到一個 401。在這裡擋下來，當場就知道。
 *
 * token 只會送到 api.github.com，也就是它本來就要被使用的地方。
 */
async function verifyToken(token) {
  let repo = {};
  try {
    repo = JSON.parse(await readFile(join(ROOT, 'data', 'config.json'), 'utf8')).repo ?? {};
  } catch { /* 讀不到設定就略過確認 */ }

  if (!repo.owner || !repo.name) {
    return { warn: 'data/config.json 沒有 repo 設定，略過向 GitHub 確認這組 token。' };
  }
  const full = `${repo.owner}/${repo.name}`;

  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${full}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mmu-make-vault',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { warn: `連不上 GitHub（${err.message}），沒辦法先確認 token。可以繼續，但上線後請到後台解鎖一次確認。` };
  }

  if (res.status === 401) {
    return {
      error: [
        'GitHub 不認得這串 token（401），所以沒有產生金鑰檔。它可能：',
        '  - 已經被作廢，或是複製之後又按了一次 Regenerate',
        '  - 是從別的地方複製來的舊 token，不是 GitHub 頁面上剛產生的那串',
        '  - 複製時漏掉了頭尾幾個字',
        '',
        '請回到 GitHub 的 token 頁面再產生一次，直接從那個頁面複製，馬上重跑這支。',
      ].join('\n'),
    };
  }
  if (res.status === 404) {
    return { error: `這串 token 看不到 ${full}（404）。建立 token 時，Repository access 要選到這個 repo。` };
  }
  if (!res.ok) {
    return { warn: `GitHub 回應 HTTP ${res.status}，沒辦法確認 token。可以繼續，但上線後請到後台解鎖一次確認。` };
  }

  const body = await res.json().catch(() => ({}));
  if (body.permissions && body.permissions.push === false) {
    return {
      error: `這串 token 沒有 ${full} 的寫入權限。請到 token 設定把 Contents 改成 Read and write 並存檔`
        + '（改權限不會換掉 token，不用重新複製），然後重跑這支。',
    };
  }
  return { ok: `GitHub 確認這組 token 有效，可以存取 ${full}` };
}

/**
 * 粗估密碼的熵（bits）。
 *
 * 不用「至少幾個字元」當標準 —— 那對中文是錯的。一個中文字是從幾千個字
 * 裡選出來的，一個小寫字母只是 26 選 1。依出現的字元類別推算字集大小，
 * 再乘上長度。這仍然是高估（人選的詞不是均勻隨機），但不會把中文通關
 * 密語判得比 "Passw0rd!" 還弱。
 */
function estimateBits(pw) {
  const chars = [...pw];
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(pw)) pool += 32;
  if (/\p{Script=Han}/u.test(pw)) pool += 2000;   // 常用漢字三千多，保守抓 2000
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(pw)) pool += 90;
  return pool > 1 ? chars.length * Math.log2(pool) : 0;
}

/**
 * vault.enc 是公開檔案，任何人都能下載回去離線爆破。PBKDF2 60 萬次只拉高
 * 每次嘗試的成本，不能歸零 —— 防線完全落在密碼本身的熵上。
 */
function checkStrength(pw) {
  const problems = [];
  const bits = estimateBits(pw);
  if (bits < MIN_BITS) problems.push(`估計強度約 ${Math.round(bits)} bits，建議至少 ${MIN_BITS}`);
  if (/^\d+$/.test(pw)) problems.push('全部都是數字');
  if (/^[a-z]+\d{0,4}$/i.test(pw)) problems.push('看起來是「單一英文詞＋幾個數字」，這是字典攻擊的第一順位');
  if (/(mmu|mmc|mackay|馬偕|通識|admin|password|2025|2026)/i.test(pw)) {
    problems.push('包含跟這個網站有關、容易被猜到的字詞');
  }
  return { problems, bits };
}

// --------------------------------------------------------------------- 主流程

function fail(message) {
  console.error('');
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

/** 說清楚是「視窗不能打字」，並直接給出能用的做法與實際路徑。 */
function explainNoTerminal() {
  const script = join(ROOT, 'scripts', 'make-vault.mjs');
  const launcher = join(ROOT, 'scripts', 'make-vault.cmd');

  console.error('');
  console.error('✗ 這個視窗沒辦法讓你打字，所以拿不到 token —— 不是你沒有輸入。');
  console.error('  （從編輯器的 Run 按鈕或其他自動執行的方式啟動時，會變成這樣。）');
  console.error('');
  console.error('請改用下面任一種方式：');
  console.error('');
  if (process.platform === 'win32') {
    console.error('  1. 在檔案總管找到這個檔案，雙擊它：');
    console.error(`       ${launcher}`);
    console.error('');
    console.error('  2. 從開始選單打開 PowerShell，貼上這行後按 Enter：');
  } else {
    console.error('  打開終端機，貼上這行後按 Enter：');
  }
  console.error(`       node "${script}"`);
  process.exitCode = 1;
}

async function main() {
  console.log('');
  console.log('建立後台金鑰（admin/vault.enc）');
  console.log('──────────────────────────────');
  console.log('需要一組 GitHub Fine-grained token：');
  console.log('  GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens');
  console.log('  Repository access：Only select repositories → 只選這個網站的 repo');
  console.log('  Permissions      ：Contents → Read and write（其他都不要給）');
  console.log('');

  const token = argOf('--token') ?? await ask('貼上 token 後按 Enter（畫面上不會顯示）：', { hidden: true });
  const tk = checkToken(token);
  if (tk.error) return fail(tk.error);
  if (tk.warn) {
    console.log('');
    for (const line of tk.warn) console.log(`⚠️  ${line}`);
    console.log('');
    const yes = await ask('確定要繼續用這組 token 嗎？輸入 yes 繼續：');
    if (yes.toLowerCase() !== 'yes') return fail('已取消。');
  }

  console.log('');
  if (SKIP_VERIFY) {
    console.log('（--skip-verify：略過向 GitHub 確認 token，只給自動化測試用）');
  } else {
    console.log('正在向 GitHub 確認這組 token⋯⋯');
    const vr = await verifyToken(token);
    if (vr.error) return fail(vr.error);
    if (vr.warn) console.log(`⚠️  ${vr.warn}`);
    if (vr.ok) console.log(`✅ ${vr.ok}`);
  }

  console.log('');
  console.log('接著設定密碼。它用來解密 token，不會被存在任何地方 —— 連雜湊都不留，');
  console.log('忘記了只能重新產生一份。');
  console.log('');
  console.log('請用四到五個不相干的詞組成的通關密語，像「鯨魚-鉛筆-火山-拖鞋-42」這種格式。');
  console.log('（但不要直接用這組 —— 它公開在這個專案的文件裡，會被拒絕。）');
  console.log('');

  const pw1 = await ask('密碼（畫面上不會顯示）：', { hidden: true });
  if (!pw1) return fail('密碼不能是空的。');
  if (PUBLISHED_EXAMPLES.has(pw1)) {
    return fail('這是公開在文件裡的範例密碼，任何人都讀得到，不能拿來用。請自己想一組。');
  }

  const { problems, bits } = checkStrength(pw1);
  if (problems.length) {
    console.log('');
    console.log(`⚠️  這組密碼偏弱（估計約 ${Math.round(bits)} bits）：`);
    for (const p of problems) console.log(`   - ${p}`);
    console.log('');
    console.log('   vault.enc 是公開檔案，可以被下載回去離線爆破。');
    console.log('   PBKDF2 60 萬次只拉高成本，不能歸零。');
    console.log('');
    const yes = await ask('   確定要用這組密碼嗎？輸入 yes 繼續：');
    if (yes.toLowerCase() !== 'yes') return fail('已取消。');
  }

  const pw2 = await ask('再輸入一次密碼：', { hidden: true });
  if (pw1 !== pw2) return fail('兩次輸入的密碼不一致。');

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = pbkdf2Sync(pw1, salt, ITERATIONS, KEY_LEN, 'sha256');

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // WebCrypto 的 AES-GCM 預期密文尾端接著 16 bytes 的驗證標籤。
  // Node 把兩者分開給，所以要自己接起來，瀏覽器那邊才解得開。
  const vault = {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: Buffer.concat([ct, tag]).toString('base64'),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(vault, null, 2) + '\n', 'utf8');

  const rel = relative(ROOT, OUT);
  const shown = rel.startsWith('..') ? OUT : rel.replace(/\\/g, '/');

  console.log('');
  console.log(`✅ 已寫入 ${shown}`);
  console.log('');
  console.log('接下來：');
  console.log(`  1. 把 ${shown} commit 並推上 GitHub`);
  console.log('  2. 到網站的 #/admin 用剛才的密碼試一次，確認解得開');
  console.log('');
  console.log('token 外洩時（五分鐘）：');
  console.log('  GitHub 撤銷舊 token → 產生新 token → 重跑這支並設新密碼 → commit');
}

main().catch((err) => {
  if (err instanceof NoTerminalError) explainNoTerminal();
  else fail(err.message);
});
