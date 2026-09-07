/**
 * 馬偕通識分享區 v2 —— 一鍵建立投稿與回報表單
 * ===========================================================================
 *
 * 這支腳本跑一次，會建立：
 *   1. 「修課心得投稿」表單（10 個欄位，對應 data/courses.json 的資料模型）
 *   2. 「回報不當內容」表單
 *   3. 兩份表單各自的回應試算表
 *   4. 把試算表設為「知道連結的人可以檢視」，並印出 CSV 讀取網址
 *
 * 最後會在執行紀錄印出一段 JSON，直接貼進 data/config.json 的 forms 區塊。
 *
 * ---------------------------------------------------------------------------
 * 怎麼跑
 * ---------------------------------------------------------------------------
 *   1. 開 https://script.google.com/ → 新增專案
 *   2. 把這個檔案的全部內容貼進去，取代原本的 myFunction
 *   3. 上方函式選單選 setUp，按「執行」
 *   4. 第一次會要求授權（它要建立表單與試算表）→ 允許
 *   5. 執行完成後點下方「執行紀錄」，把印出來的 JSON 複製走
 *
 * 之後如果要改題目，直接去 Google 表單改就好，不用再跑這支。
 * 重跑會建立一組全新的表單（不會覆蓋舊的），舊的請自行刪除。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 隱私：這件事務必看懂再跑
 * ---------------------------------------------------------------------------
 * 回應試算表會被設成「知道連結的人可以檢視」—— 這是必要的，因為純靜態
 * 網站要靠它當免費的唯讀 API。也就是說：**所有投稿內容都是公開可讀的**。
 *
 * 所以腳本刻意做了兩件事：
 *   - setCollectEmail(false)：不蒐集填表者的 Email
 *   - 表單裡沒有姓名、學號、班級任何一個欄位
 *
 * 不要自己加上這些欄位。加了就會連同心得一起公開。
 */

// ===========================================================================
// 設定：想改標題或說明文字改這裡
// ===========================================================================

var CONFIG = {
  submitTitle: '馬偕通識分享區 — 修課心得投稿',
  submitDescription:
    '分享你修過的通識課，幫學弟妹少踩一個雷。\n\n' +
    '匿名投稿，不會蒐集你的姓名、學號或 Email。\n' +
    '送出後不需要等審核，通過自動品質檢查就會出現在站上。\n\n' +
    '請不要填寫任何可以指認到個人的資訊（包含其他同學與助教）。',

  reportTitle: '馬偕通識分享區 — 回報不當內容',
  reportDescription:
    '看到不實、惡意或涉及個資的心得，請在這裡回報。\n' +
    '管理者確認後會將該則心得下架。',

  // 八個領域，順序與 data/courses.json 的 domains 一致
  domains: [
    '天領域', '地領域', '人領域', '心領域',
    '系選修', '體育類', '語言類', '其他類',
  ],
};

// ===========================================================================
// 主流程
// ===========================================================================

function setUp() {
  var submit = buildSubmitForm_();
  var report = buildReportForm_();

  var out = {
    submitUrl: submit.publishedUrl,
    reportUrl: report.publishedUrl,
    reportPrefillUrl: report.prefillUrl,
    submissionsCsv: submit.csvUrl,
    reportsCsv: report.csvUrl,
  };

  Logger.log('');
  Logger.log('==========================================================');
  Logger.log('完成。把下面這段貼進 data/config.json 的 "forms" 欄位：');
  Logger.log('==========================================================');
  Logger.log('');
  Logger.log('  "forms": ' + JSON.stringify(out, null, 2).replace(/\n/g, '\n  '));
  Logger.log('');
  Logger.log('==========================================================');
  Logger.log('編輯表單用的網址（自己留著，不要公開）：');
  Logger.log('  投稿表單：' + submit.editUrl);
  Logger.log('  回報表單：' + report.editUrl);
  Logger.log('  投稿回應試算表：' + submit.sheetUrl);
  Logger.log('  回報回應試算表：' + report.sheetUrl);
  Logger.log('==========================================================');

  return out;
}

// ===========================================================================
// 投稿表單
// ===========================================================================

function buildSubmitForm_() {
  var form = FormApp.create(CONFIG.submitTitle)
    .setDescription(CONFIG.submitDescription)
    .setCollectEmail(false)          // 絕對不要改成 true
    .setLimitOneResponsePerUser(false)
    .setAllowResponseEdits(false)
    .setProgressBar(true)
    .setConfirmationMessage(
      '收到，謝謝你。\n\n' +
      '通過自動品質檢查的內容會很快出現在站上。\n' +
      '如果沒有出現，可能是被自動閘擋下待處理（例如字數太短、' +
      '課程代碼格式不符，或偵測到疑似個資）。'
    );

  // --- 課程基本資料 ------------------------------------------------------

  var domain = form.addListItem();
  domain.setTitle('領域')
    .setHelpText('這門課屬於哪一個領域？可以在學校課程系統查到。')
    .setChoiceValues(CONFIG.domains)
    .setRequired(true);

  var code = form.addTextItem();
  code.setTitle('課程代碼')
    .setHelpText('例如 HE139A、PE103A、ME241A。請照課程系統上的寫法。')
    .setRequired(true);
  code.setValidation(
    FormApp.createTextValidation()
      .setHelpText('請填 2 個英文字母 + 3 個數字 + 1 個英文字母，例如 HE139A。')
      .requireTextMatchesPattern('^[A-Za-z]{2}\\d{3}[A-Za-z]$')
      .build()
  );

  form.addTextItem()
    .setTitle('課程名稱')
    .setHelpText('請照課程系統上的全名，不要用簡稱。')
    .setRequired(true);

  form.addTextItem()
    .setTitle('授課教師')
    .setHelpText(
      '只填一位主要授課教師的姓名。\n' +
      '⚠️ 同一個課程代碼由不同老師開課時，站上是分開的兩門課，' +
      '所以這一欄填錯會讓你的心得掛到別的老師身上。'
    )
    .setRequired(true);

  var term = form.addTextItem();
  term.setTitle('修課學期')
    .setHelpText('用 3 到 4 位數字：110 學年上學期填 1101，下學期填 1102。')
    .setRequired(true);
  term.setValidation(
    FormApp.createTextValidation()
      .setHelpText('請填 3 到 4 位數字，例如 1101。')
      .requireTextMatchesPattern('^\\d{3,4}$')
      .build()
  );

  // --- 評分 --------------------------------------------------------------
  // 規格第六節：星級以外的評分欄位皆選填。
  // 缺項在資料層是 null，不會被補成 0 —— 所以沒把握的欄位請直接留空，
  // 不要隨便填一個數字。

  form.addSectionHeaderItem()
    .setTitle('評分')
    .setHelpText(
      '除了星級以外都可以留空。\n' +
      '沒把握的欄位請留空，不要猜 —— 留空會顯示成「—」，' +
      '隨便填的數字則會被算進平均，反而誤導別人。'
    );

  form.addScaleItem()
    .setTitle('星級')
    .setHelpText('整體推薦程度。1 = 千萬別修，5 = 大推。')
    .setBounds(1, 5)
    .setLabels('千萬別修', '大推')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('甜度')
    .setHelpText('給分寬鬆程度。0 = 分數很難看，10 = 幾乎人人高分。不確定就留空。')
    .setBounds(0, 10)
    .setLabels('給分很硬', '非常甜')
    .setRequired(false);

  form.addScaleItem()
    .setTitle('涼度')
    .setHelpText('課業負擔輕重。0 = 作業報告接連不斷，10 = 幾乎不用花時間。不確定就留空。')
    .setBounds(0, 10)
    .setLabels('非常硬', '非常涼')
    .setRequired(false);

  var grade = form.addTextItem();
  grade.setTitle('學期成績')
    .setHelpText('你這門課實際拿到的分數。可以填小數，例如 94.5。不想填就留空。')
    .setRequired(false);
  grade.setValidation(
    FormApp.createTextValidation()
      .setHelpText('請填 0 到 100 之間的數字。')
      .requireTextMatchesPattern('^(100(\\.0+)?|\\d{1,2}(\\.\\d+)?)$')
      .build()
  );

  // --- 心得 --------------------------------------------------------------

  var text = form.addParagraphTextItem();
  text.setTitle('修課心得')
    .setHelpText(
      '評分方式、作業量、上課方式、雷點，什麼都可以寫。至少 10 個字。\n' +
      '請不要寫出任何人的個資，也不要人身攻擊 —— 那些會被自動擋下。'
    )
    .setRequired(true);
  text.setValidation(
    FormApp.createParagraphTextValidation()
      .setHelpText('請寫 10 到 2000 個字。')
      .requireTextLengthGreaterThanOrEqualTo(10)
      .build()
  );

  return finalize_(form, '投稿');
}

// ===========================================================================
// 回報表單
// ===========================================================================

function buildReportForm_() {
  var form = FormApp.create(CONFIG.reportTitle)
    .setDescription(CONFIG.reportDescription)
    .setCollectEmail(false)
    .setConfirmationMessage('收到，謝謝你。管理者會盡快處理。');

  var idItem = form.addTextItem()
    .setTitle('心得編號')
    .setHelpText(
      '從網站上點「回報不當內容」進來的話，這一欄會自動帶入，不用改。\n' +
      '手動填的話，請一併在下面說明是哪一門課的哪一則。'
    )
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('回報原因')
    .setChoiceValues([
      '含有個人資料（姓名、電話、Email、學號等）',
      '人身攻擊或辱罵',
      '內容不實',
      '廣告或洗版',
      '其他',
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('補充說明')
    .setHelpText('請說明是哪一門課的哪一則心得，以及問題出在哪裡。')
    .setRequired(true);

  var out = finalize_(form, '回報');

  // 預填網址。Google 表單的預填參數是 entry.<數字ID>，那個數字只能從
  // toPrefilledUrl() 反推，沒有別的取得方式。這裡先填一個哨兵字串，
  // 前端再把哨兵換成真正的心得 id。
  //
  // 沒有這個的話，回報的人得自己描述是哪一門課的哪一則，管理者要人工比對。
  var probe = form.createResponse()
    .withItemResponse(idItem.createResponse(REVIEW_ID_TOKEN))
    .toPrefilledUrl();
  out.prefillUrl = probe;

  return out;
}

/** 預填網址裡代表「心得 id 填這裡」的哨兵。前端會把它換成真正的 id。 */
var REVIEW_ID_TOKEN = '__REVIEW_ID__';

// ===========================================================================
// 共用：建立回應試算表、開放唯讀、組出 CSV 網址
// ===========================================================================

function finalize_(form, label) {
  var sheet = SpreadsheetApp.create(form.getTitle() + '（回應）');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  // 純靜態網站沒有後端，要靠這份試算表當免費的唯讀 API。
  // 設成「知道連結的人可以檢視」——所以表單裡絕對不能有個資欄位。
  DriveApp.getFileById(sheet.getId())
    .setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // 讀取端點用 gviz：只要設好共用就能讀，不需要「檔案 → 共用 → 發布到
  // 網路」那三個手動步驟。代價是它比 /pub?output=csv 稍微不穩定一點
  // （偶爾會被限流，欄位型別也可能被它自作主張轉換）。
  //
  // 如果之後遇到問題，改用規格第六節那個更穩的做法：
  //   開試算表 → 檔案 → 共用 → 發布到網路 → 選「逗號分隔值 (.csv)」
  //   → 把拿到的 .../pub?gid=0&single=true&output=csv 填回 config.json
  // 兩種網址 sync-submissions.mjs 都吃得下。
  var csvUrl = 'https://docs.google.com/spreadsheets/d/' + sheet.getId() +
               '/gviz/tq?tqx=out:csv';

  Logger.log('[' + label + '] 表單與試算表建立完成');

  return {
    publishedUrl: form.getPublishedUrl(),
    editUrl: form.getEditUrl(),
    sheetUrl: sheet.getUrl(),
    csvUrl: csvUrl,
  };
}
