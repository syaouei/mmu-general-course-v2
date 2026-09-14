// 關於頁。也是投稿與回報的入口。
//
// 表單網址從 data/config.json 讀，不寫死在這裡（規格第十三節）。
// 還沒設定時要老實說「尚未開放」，不要放一個點下去是死的按鈕。

import { el } from '../dom.js';
import { setMeta } from '../router.js';
import * as store from '../store.js';
import { visibleReviews } from '../format.js';

export default async function about() {
  setMeta('關於', '關於馬偕通識分享區：這個站是什麼、資料從哪來、怎麼投稿、怎麼回報不當內容。');

  const config = store.getState().config ?? {};
  const site = config.site ?? {};
  const forms = config.forms ?? {};
  const meta = store.getMeta();

  const courses = store.getCourses();
  const reviewCount = courses.reduce((a, c) => a + visibleReviews(c).length, 0);

  /** 有設定就是外部表單連結，沒設定就誠實說還沒開放。 */
  const formCta = (url, strong, hint, pendingHint) =>
    url
      ? el('a', { class: 'cta', href: url, target: '_blank', rel: 'noopener noreferrer' }, [
          el('strong', {}, strong + ' →'),
          el('span', {}, hint),
        ])
      : el('div', { class: 'cta', 'aria-disabled': 'true' }, [
          el('strong', {}, strong + '（尚未開放）'),
          el('span', {}, pendingHint),
        ]);

  document.getElementById('main').replaceChildren(
    el('div', { class: 'wrap' }, el('article', { class: 'prose' }, [
      el('h1', {}, '關於'),
      el('p', { class: 'lede' },
        '馬偕通識分享區收錄馬偕醫學大學通識課程的學生修課心得，' +
        `目前有 ${courses.length} 門課、${reviewCount} 則心得。`),

      el('h2', {}, '投稿'),
      el('p', {},
        '心得由學生自由投稿。填完表單後不需要等任何人審核 ——' +
        '通過自動品質檢查的內容會直接出現在站上，並在下一次同步時寫進資料檔。'),
      formCta(forms.submitUrl, '填寫修課心得',
        forms.requiresLogin
          ? '需要登入 Google 帳號。表單不會記錄你的姓名、學號或 Email。'
          : '匿名，不會蒐集姓名、學號或 Email。',
        '投稿表單還在設定中，開放後這裡會變成連結。'),
      forms.requiresLogin
        ? el('p', {},
            '這份表單設定為需要登入才能填寫，這是為了擋掉來自校外的洗版。' +
            '登入只用來驗證你有權限填寫 —— 表單沒有蒐集電子郵件地址的欄位，' +
            '你的身分不會被記錄，也不會出現在站上。')
        : null,
      el('p', {},
        '請不要填寫任何可以指認到個人的資訊。系統會自動遮蔽偵測到的手機號碼、' +
        'Email 與身分證字號，但最保險的做法是一開始就不要寫。'),

      el('h2', {}, '回報不當內容'),
      el('p', {},
        '因為完全沒有人工審核，惡意或不實的內容有可能短暫出現在站上。' +
        '看到請回報，管理者會把它下架。'),
      formCta(forms.reportUrl, '回報不當內容',
        '也可以直接點每則心得下方的「回報不當內容」。',
        '回報表單還在設定中。在那之前請直接聯絡管理者。'),

      el('h2', {}, '資料從哪來'),
      el('p', {}, [
        '2023 年由 Bean1450 手刻的',
        site.legacyUrl
          ? el('a', { href: site.legacyUrl, target: '_blank', rel: 'noopener noreferrer' }, '前身站台')
          : '前身站台',
        '累積了大量心得，那些資料完整遷移到了這裡，一則都沒有丟。',
      ]),
      el('p', {},
        '遷移過程中有幾件事值得知道：舊站有部分心得只填了學期和星級，' +
        '甜度、涼度、分數從缺；有兩頁的課程資訊是沒有填完的樣板；' +
        '也有幾位教師的姓名疑似有異體字誤植。這些都保留原樣並標記，' +
        '沒有替它們猜答案。'),

      el('h2', {}, '隱私'),
      el('ul', {}, [
        el('li', {}, '瀏覽這個網站不需要登入，這裡沒有使用者帳號。'),
        el('li', {}, '不放 Cookie、不做追蹤、沒有廣告。'),
        el('li', {}, '不載入任何外部字型、分析工具或第三方腳本。'),
        el('li', {}, '不蒐集也不顯示投稿者的姓名、學號或 Email。'),
        el('li', {}, '外觀偏好與閱讀模式存在你自己的瀏覽器裡，不會傳到任何地方。'),
        forms.requiresLogin
          ? el('li', {}, '投稿表單本身需要 Google 登入（見上方說明），' +
              '但登入資訊不會進到這個網站的資料裡。')
          : null,
      ]),

      el('h2', {}, '這個站怎麼做的'),
      el('p', {},
        '純靜態網站，放在 GitHub Pages 上。沒有伺服器、沒有資料庫。' +
        '所有內容在一份 JSON 檔裡，前端是原生 HTML、CSS 與 ES Modules，' +
        '沒有前端框架、沒有打包工具、沒有任何對外請求。'),

      el('aside', { class: 'disclaimer-box' }, [
        el('h2', {}, '致謝與聲明'),
        el('p', {}, [
          '新版設計與開發：',
          el('strong', {}, site.designer ?? 'syaouei'),
          '。資料與前身站台：',
          el('strong', {}, site.legacyAuthor ?? 'Bean1450'),
          '。',
        ]),
        el('p', {},
          '本站與馬偕醫學大學無官方關聯，內容不代表校方立場。' +
          '所有心得為學生個人主觀經驗，課程內容與評分方式可能逐年變動。'),
        meta.updatedAt
          ? el('p', {}, `資料最後更新：${new Date(meta.updatedAt).toLocaleString('zh-Hant')}`)
          : null,
      ]),
    ])),
  );
}
