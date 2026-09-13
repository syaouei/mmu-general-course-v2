// 建立／輪替 admin/vault.enc（規格第七節）。
//
//   node scripts/make-vault.mjs --token github_pat_xxxxx
//   node scripts/make-vault.mjs --token github_pat_xxxxx --out admin/vault.enc
//
// 會互動式詢問密碼（輸入不回顯），用 PBKDF2-SHA256 600,000 次導出金鑰，
// 以 AES-256-GCM 加密 token，輸出成 JSON。
//
// 密碼從不被存在任何地方，連雜湊都沒有 —— 沒有可以比對的東西，就沒有
// 「比對邏輯被繞過」這個攻擊面。忘記密碼的唯一辦法是拿新 token 重做一份。
//
// ⚠️ 這支腳本會碰到明文 token，只在你自己的機器上跑，不要放進 CI。

import { writeFile, mkdir } from 'node:fs/promises';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { dirname } from 'node:path';

const ITERATIONS = 600_000;
const KEY_LEN = 32;      // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;       // GCM 標準長度

// --------------------------------------------------------------------- 參數

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

const token = argOf('--token');
const outPath = argOf('--out') ?? 'admin/vault.enc';

if (!token) {
  console.error(`用法：node scripts/make-vault.mjs --token <GitHub token> [--out admin/vault.enc]

先到 GitHub 產生一組 fine-grained personal access token：
  Settings → Developer settings → Personal access tokens → Fine-grained tokens

  Repository access : Only select repositories → 只選這一個 repo
  Permissions       : Contents → Read and write
  過期時間          : 建議 90 天，到期再用這支腳本輪替

除了 Contents 之外不要給任何權限。這把 token 洩漏時能造成的最大損害，
就是它被授予的權限範圍。`);
  process.exitCode = 1;
}

// ------------------------------------------------------------- 隱藏式輸入

// 非 TTY（被 pipe）時的輸入緩衝。一次把 stdin 讀進來再逐行發，
// 這樣連續問三次也拿得到三行，而不是第一次就把整份吃光。
let pipedLines = null;
async function readPipedLines() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

/** 讀一行密碼，不回顯。沒有 TTY（例如被 pipe）時逐行讀 stdin。 */
async function askPassword(prompt) {
  if (!process.stdin.isTTY) {
    pipedLines ??= await readPipedLines();
    return (pipedLines.shift() ?? '').replace(/\r$/, '');
  }

  return new Promise((resolve, reject) => {

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let value = '';
    const onData = (ch) => {
      switch (ch) {
        case '\n': case '\r': case '\u0004':
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          break;
        case '\u0003':                       // Ctrl-C
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          reject(new Error('已取消'));
          break;
        case '\u007f': case '\b':            // Backspace
          value = value.slice(0, -1);
          break;
        default:
          if (ch >= ' ') value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * 密碼強度檢查。
 *
 * 這不是形式主義。vault.enc 是公開檔案，任何人都能下載回去離線爆破，
 * PBKDF2 60 萬次只能把每次嘗試的成本拉高，不能歸零。防線完全落在
 * 密碼本身的熵上 —— 「mmc2026」這種密碼，60 萬次迭代也只是讓對方
 * 多花幾小時而已。
 */

/**
 * 粗估密碼的熵（bits）。
 *
 * 不用「至少幾個字元」當標準 —— 那對中文是錯的。一個中文字是從幾千個
 * 字裡選出來的，一個小寫字母只是 26 選 1，兩者不等價。用「出現了哪些
 * 字元類別」推算字集大小，再乘上長度。
 *
 * 這仍然是高估（人選的詞不是均勻隨機），但至少不會把
 * 「鯨魚-鉛筆-火山-拖鞋-42」判得比 "Passw0rd!" 還弱。
 */
function estimateBits(pw) {
  const chars = [...pw];
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(pw)) pool += 32;
  // 常用漢字約三千多個，保守抓 2000。
  if (/[\p{Script=Han}]/u.test(pw)) pool += 2000;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(pw)) pool += 90;
  return pool > 1 ? chars.length * Math.log2(pool) : 0;
}

/**
 * 密碼強度檢查。
 *
 * 這不是形式主義。vault.enc 是公開檔案，任何人都能下載回去離線爆破，
 * PBKDF2 60 萬次只能把每次嘗試的成本拉高，不能歸零。防線完全落在
 * 密碼本身的熵上。
 */
const MIN_BITS = 60;

function checkStrength(pw) {
  const problems = [];
  const bits = estimateBits(pw);

  if (bits < MIN_BITS) {
    problems.push(`估計強度約 ${Math.round(bits)} bits，建議至少 ${MIN_BITS}`);
  }
  if (/^\d+$/.test(pw)) problems.push('全部都是數字');
  if (/^[a-z]+\d{0,4}$/i.test(pw)) problems.push('看起來是「單一英文詞 + 幾個數字」，這是字典攻擊的第一順位');
  if (/(mmc|mackay|馬偕|通識|admin|password|2025|2026)/i.test(pw)) {
    problems.push('包含跟這個專案有關的可猜測字詞');
  }
  return { problems, bits };
}

// --------------------------------------------------------------------- 主流程

if (token) {
  console.log('');
  console.log('這把密碼會用來解密 GitHub token。它不會被存在任何地方 ——');
  console.log('連雜湊都不會留。忘記了只能重新產生一份 vault。');
  console.log('');
  console.log('建議用四到五個不相干的詞組成的通關密語，例如：');
  console.log('  鯨魚-鉛筆-火山-拖鞋-42');
  console.log('');

  const pw1 = await askPassword('密碼：');
  if (!pw1) {
    console.error('密碼不能是空的。');
    process.exitCode = 1;
  } else {
    const { problems, bits } = checkStrength(pw1);
    if (problems.length) {
      console.log('');
      console.log(`⚠️  這組密碼偏弱（估計約 ${Math.round(bits)} bits）：`);
      for (const p of problems) console.log(`   - ${p}`);
      console.log('');
      console.log('   vault.enc 是公開檔案，可以被下載回去離線爆破。');
      console.log('   PBKDF2 60 萬次只拉高成本，不能歸零。');
      console.log('');
      const yes = await askPassword('   確定要用這組密碼嗎？輸入 yes 繼續：');
      if (yes.trim().toLowerCase() !== 'yes') {
        console.log('已取消。');
        process.exitCode = 1;
      }
    }

    if (process.exitCode !== 1) {
      const pw2 = await askPassword('再輸入一次：');
      if (pw1 !== pw2) {
        console.error('兩次輸入不一致。');
        process.exitCode = 1;
      } else {
        const salt = randomBytes(SALT_LEN);
        const iv = randomBytes(IV_LEN);
        const key = pbkdf2Sync(pw1, salt, ITERATIONS, KEY_LEN, 'sha256');

        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();

        // WebCrypto 的 AES-GCM 預期密文尾端接著 16 bytes 的驗證標籤。
        // Node 把兩者分開給，所以這裡要自己接起來，瀏覽器那邊才解得開。
        const payload = Buffer.concat([ct, tag]);

        const vault = {
          v: 1,
          kdf: 'PBKDF2-SHA256',
          iterations: ITERATIONS,
          salt: salt.toString('base64'),
          iv: iv.toString('base64'),
          ct: payload.toString('base64'),
        };

        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, JSON.stringify(vault, null, 2) + '\n', 'utf8');

        console.log('');
        console.log(`✅ 已寫入 ${outPath}`);
        console.log('');
        console.log('接下來：');
        console.log(`  1. git add ${outPath} && git commit -m "chore(admin): 輪替 vault"`);
        console.log('  2. 把明文 token 從你的終端機歷史裡清掉');
        console.log('  3. 到 #/admin 用剛才的密碼試一次，確認解得開');
        console.log('');
        console.log('token 外洩時的處理（五分鐘）：');
        console.log('  GitHub 撤銷舊 token → 產生新 token → 用新密碼重跑這支 → commit');
        console.log('');
      }
    }
  }
}
