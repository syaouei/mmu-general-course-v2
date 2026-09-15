# CLAUDE.md

寫給之後要動這個專案的人（或 AI）。README 講的是「這是什麼」，
這裡講的是「動它之前要知道什麼」。

---

## 最重要的三條規則

違反這三條，畫面不會報錯，只會安靜地產生錯誤資訊給正在選課的學生看。

### 1. 缺項是 `null`，永遠不是 `0`

舊站的心得大量缺項 —— 甜度與涼度只有 41% 有值。

```js
// ✗ 這會讓「沒人填過涼度」顯示成「涼度 0」，害人選錯課
const avg = values.reduce((a, b) => a + b, 0) / values.length;

// ✓ format.js 的 average() 回傳 { avg, n }，n 為 0 時 avg 是 null
const { avg, n } = average(values);
```

排序時 `null` 一律沉底（`format.js` 的 `comparator`），不是當成 0 比大小。
篩選時缺項不通過任何數值條件 —— 那不是「分數低」，是「沒有人回答過」。

`test/format.test.mjs` 有一條測試窮舉四個評分欄位的全部 16 種缺項組合。
改動統計邏輯後那條一定要綠。

### 2. 同一個課程代碼可能是兩門不同的課

`HE013A` 有兩位老師開課，評價完全不同。合併它們是這個專案最嚴重的
資料錯誤。課程的身分是 **(code, teacher)** 這一組，不是 code。

```js
matchCourse(courses, code, teacher)   // js/submissions.js，投稿要併進哪門課都走這個
```

教師欄當成「名字集合」比：順序、空格／頓號／逗號、結尾的「老師」都不算，
只寫了其中幾位也認得。**對得上不只一門就不猜**，擋進待審區，由管理者在
待審區的選單裡指定要併進哪一門（或建立成新課程）。

實際有 5 組同代碼：HE013A、HE022A、PE103A（三位）、PE109A、
ME241A（同代碼同教師但是兩門不同課，靠 `-2` 後綴區分；這個代碼的投稿一律進待審區）。

### 3. 心得內文永遠走 `textContent`

`js/dom.js` 刻意不提供任何吃 HTML 字串的函式。沒有那個入口，
就不會有人不小心用到。CI 有一步 grep `innerHTML`，會擋下整個 build。

---

## 資料模型

單一真實來源是 `data/courses.json`，契約寫在 `data/schema.json`，
實際執行檢查的是 `scripts/validate-data.mjs`（專案零相依，不跑
JSON Schema 驗證器，兩邊要一起改）。

```
courses[].id          {code}-{teacher拼音}，撞號加 -2。**永不變動**，它已經進了網址
courses[].code        可以是 null（舊站有兩門課沒有代碼，不捏造）
reviews[].id          lg-{領域}-{頁}-{序} 或 fm-{hash}。抑制清單靠它比對，格式不可改
reviews[].rawHeader   舊站評分摘要原字串。解析再爛都不會丟資料
reviews[].hidden      軟刪除。不渲染、不計入統計、不計入則數，但留在檔案裡
courses[].dept        所屬的系（只有系選修這種分系的領域才有）。沒分系就不要有這個欄位
domains[].groups      領域底下的系 [{ id, name }]。id 進了網址（#/d/xuanxiu?dept=med），不要改
```

`reviews[].id` 的 hash 函式（`js/submissions.js` 的 `stableId`）
**換演算法一次，所有已抑制的惡意內容都會重新出現在站上**。
用純 JS 的 FNV-1a 而不是 crypto，就是為了讓瀏覽器與 Node 算出逐位元
相同的結果。

---

## 常見任務

### 新增一個系（系選修）

1. `data/courses.json` → `domains` 裡系選修的 `groups` 加一筆
   `{ "id": "英文小寫", "name": "系名" }`。id 會進網址，建立後不要改。
2. Google 表單「領域」題加選項 `系選修／系名`（全形斜線），文字要和 `name` 一字不差。
   建置期同步與即時投稿都靠這串字把投稿分到那個系（`js/submissions.js` 的 `parseDomainChoice`）。
3. `scripts/create-forms.gs` 的 `CONFIG.domains` 加上同一個選項，之後重建表單才不會漏。

表單上的舊選項「系選修」（不帶系）一樣收得下，那些課會列在「未分系」，
到後台課程分頁補上系即可。

### 新增一門課

不要手動改 `courses.json`。正常路徑是有人透過表單投稿，
`sync-submissions.mjs` 會自動建立課程。

真的要手動加（例如補一門沒人投稿但想先列出來的課）：
後台 `#/admin` → 課程分頁。那條路徑會自動重算 `meta` 並產生 commit。

### 緊急下架一則心得

**只做「隱藏」是不夠的。**

心得有兩條路進到畫面上：烘焙資料（`courses.json`）與即時 CSV
（瀏覽器直接讀 Google 試算表）。**改 `courses.json` 殺不掉 CSV 那一條**
—— 下一個訪客的瀏覽器還是會把它讀回來。

正確做法（`#/admin` → 心得分頁）：

1. **隱藏** → 寫進 `courses.json`，擋掉烘焙資料那條
2. **加入抑制清單** → 寫進 `suppressed.json`，擋掉即時 CSV 那條

`store.js` 在渲染前把抑制清單套用到兩邊。兩步都做才是真的下架。

### 輪替後台密碼或 token

```bash
node scripts/make-vault.mjs
git add admin/vault.enc && git commit -m "chore(admin): 輪替 vault"
```

token 要用 **fine-grained** PAT，只給這一個 repo 的
`Contents: Read and write`。密碼必須是長通關密語 —— `vault.enc` 是
公開檔案，可以被下載回去離線爆破，PBKDF2 60 萬次只拉高成本不能歸零。
腳本會估算熵並在低於 60 bits 時警告。

**token 外洩時**：GitHub 撤銷 → 產生新 token → 用新密碼重跑上面那行
→ commit。五分鐘。舊 vault 就算被爆破開，裡面的 token 也已經失效。

### 改封鎖字表

`#/admin` → 封鎖字表分頁，或直接改 `scripts/blocklist.txt`。

收錄原則是**只收辱罵與人身攻擊，不收負面評價**。
「這堂課很爛」「老師很機車」「是地雷課」全部要放行 —— 那是心得，
而且是這個站存在的理由。擋掉它們等於把站變成公關頁。
`test/gate.test.mjs` 有一條測試專門守這個。

---

## 為什麼是這個架構

### 為什麼純靜態

沒有伺服器要維護、沒有資料庫會掛、沒有續費會忘記繳。前一個站是
2023 年做的，2026 年還活著就是因為它是靜態的。這個站要活得比
維護者的在學時間長。

代價寫在 README 的「完全免審核的取捨」與「回應試算表是公開唯讀的」。

### 為什麼品質閘是共用模組

`js/gate.js` 同時跑在瀏覽器（即時 CSV 合併前）與 Node（建置期同步前）。
兩邊各寫一份的話，遲早會有一邊漏掉某條規則 —— **而漏掉的那邊會是
使用者真正看到的那一邊**。`package.json` 只有 `type: module` 一個作用，
就是讓 Node 能直接 import `js/` 底下的模組。

### 為什麼沒有打包工具

規格要求零建置步驟。view 用原生 `import()` 動態載入，首屏只下載
必要的九個模組（48KB，gzip 23KB），課程頁、後台、即時投稿的模組
都是走到那裡才載。

首屏 JS 的「30KB 未壓縮」預算：程式碼本身 32KB，中文註解另外
16KB（UTF-8 一個中文字 3 bytes）。因為不能 minify，註解算進去就
超標。判斷是留著註解 —— 影響使用者的是傳輸量與解析量，兩者都遠
低於預算，而這些註解就是這個專案的架構文件。

### 為什麼教師拼音是人工對照表

`data/teacher-pinyin.json` 是手動維護的。不用 pinyin 套件的原因：
**課程 id 會進網址**，套件版本變動造成的 id 漂移等於所有分享出去的
連結一次全壞。查不到的教師會讓 `migrate-legacy.mjs` 直接中止，
而不是猜一個 slug。

### 為什麼後台的密碼不驗證身分

純靜態站的前端沒有可信執行環境，密碼比對那個 `if` 跑在使用者自己的
機器上。詳見 README 的「後台安全模型」。一句話版本：**程式碼裡沒有
秘密，秘密在密文裡。**

---

## 開發

```bash
node scripts/dev-server.mjs     # 不要直接雙擊 index.html，file:// 會被 CORS 擋
npm run ci                      # 測試 + 資料驗證 + 連結檢查
```

零相依套件，不需要 `npm install`。

### 動到這些地方要特別小心

| 檔案 | 為什麼 |
|---|---|
| `js/format.js` 的 `average` / `comparator` | 缺項規則的核心，16 種組合的測試守著 |
| `js/submissions.js` 的 `stableId` | 改演算法會讓抑制清單全部失效 |
| `js/gate.js` | 同時跑在兩個環境，判斷不一致沒有人會發現 |
| `courses[].id` 的產生規則 | id 進了網址，改了等於連結全壞 |
| 任何會重繪 `#main` 的程式碼 | 會換掉正在打字的 input，中文輸入法組字會中斷 |

最後一條是實際踩過的坑：`router.js` 因此分成 `navigate()`（真的換頁）
與 `syncUrl()`（只鏡射狀態到網址、不重跑路由）。搜尋框一律用
`ui.js` 的 `bindSearchInput()`，它會在組字期間完全不動作。
