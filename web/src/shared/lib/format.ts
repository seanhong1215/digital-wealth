/**
 * web/src/shared/lib/format.ts — 顯示格式化
 *
 * 這個檔案是什麼：
 *   把後端回傳的「分」轉成給人看的字串。所有格式化都集中在這裡。
 *
 * 在架構的哪一層：
 *   前端的最外層（顯示層）。注意方向是單向的：
 *
 *     後端（分，整數）→ 前端計算（分，整數）→ **只在最後一刻**格式化成字串
 *
 *   絕不反過來 —— 格式化後的字串永遠不會再被解析回數字拿去算。
 *   一旦「1,086,546」變成字串，它就只能用來顯示。
 *
 * ── 為什麼後端不直接回傳格式化好的字串 ★ ─────────────────────────
 *
 *   會省事，但會壞掉：
 *
 *     · 前端沒辦法排序（"NT$ 1,000" < "NT$ 999" 字串比較是錯的）
 *     · 前端沒辦法算（要顯示「差額」就得先把逗號拔掉再 parseInt）
 *     · 多語系／多幣別時後端得知道使用者的地區設定
 *
 *   所以規則是：**後端永遠回傳數字，格式化永遠是前端的事。**
 *
 * 相關文件：docs/03-presentation.md → 格式化規範
 */

import { toMajorUnits, type Cents } from '@digital-wealth/shared';

/**
 * 「沒有這個資料」的顯示。用 em dash 而不是空字串或 "N/A"。
 *
 * ★ 這是本檔案最重要的一個區分：`—` 和 `NT$ 0` 是不同的意思。
 *
 *     null / undefined → `—`      「不知道餘額」
 *     0                → `NT$ 0`  「餘額就是零」
 *
 *   把 0 顯示成 `—` 是金融介面的經典 bug —— 使用者會以為系統壞了，
 *   而不是知道自己戶頭空了。
 */
export const EMPTY_DISPLAY = '—';

// ============================================================================
// 金額
// ============================================================================

/**
 * 一般金額：千分位、不顯示小數。
 *
 * 台股的帳務金額都是整數元，顯示小數只是雜訊
 * （單價才需要小數，見 formatPrice）。
 *
 * @param value 金額（分）。null / undefined 回傳 `—`
 * @param options.withCurrency 是否前綴 `NT$`，預設 true
 * @param options.signed 是否強制顯示正號（損益用），預設 false
 */
export function formatMoney(
  value: Cents | number | null | undefined,
  options: { withCurrency?: boolean; signed?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_DISPLAY;
  }

  const { withCurrency = true, signed = false } = options;

  // JS 的 -0 會被 toLocaleString 格式化成 "-0"，看起來像錯誤。
  // `+ 0` 把 -0 正規化成 0。
  const major = Math.round(toMajorUnits(value as Cents)) + 0;

  const sign = signed && major > 0 ? '+' : '';
  const body = major.toLocaleString('zh-TW', { maximumFractionDigits: 0 });

  // 負號要放在 NT$ 前面（-NT$ 12,345），不是 NT$ -12,345 ——
  // 後者讀起來像「新台幣負一萬二」，前者才是慣例。
  if (major < 0 && withCurrency) {
    return `-NT$ ${Math.abs(major).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`;
  }

  return withCurrency ? `${sign}NT$ ${body}` : `${sign}${body}`;
}

/**
 * 股價：固定 2 位小數。
 *
 * 為什麼股價要小數而金額不用：股價的最小跳動單位可以到 0.01 元
 * （未滿 10 元的股票），四捨五入到整數會顯示錯誤的價格。
 */
export function formatPrice(value: Cents | number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_DISPLAY;
  }
  return toMajorUnits(value as Cents).toLocaleString('zh-TW', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 損益金額：一律顯示正負號。`formatMoney(v, { signed: true })` 的捷徑。 */
export function formatPnl(value: Cents | number | null | undefined): string {
  return formatMoney(value, { signed: true });
}

// ============================================================================
// 百分比與數量
// ============================================================================

/**
 * 百分比：2 位小數 ＋ 正負號。
 *
 * @param ratio 比例（0.014 代表 1.4%），不是已經乘過 100 的數字
 */
export function formatPercent(ratio: number | null | undefined): string {
  // 分母為 0 時呼叫端會傳進 Infinity / NaN。顯示 `—` 而不是 "Infinity%" ——
  // 成本為 0 的部位（例如全部是股票股利）算報酬率本來就沒有意義。
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return EMPTY_DISPLAY;
  }

  const percent = ratio * 100 + 0; // 正規化 -0
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(2)}%`;
}

/**
 * 股數：千分位，並在滿張時加註張數。
 *
 * 台股 1 張 = 1000 股。使用者的心智模型是「幾張」，但零股交易
 * 讓「幾股」也必須顯示，所以兩個都給。
 *
 *   1000 → `1,000 股（1 張）`
 *   1081 → `1,081 股（1 張 81 股）`
 *     81 → `81 股`
 */
export function formatQuantity(quantity: number | null | undefined, lotSize = 1000): string {
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity)) {
    return EMPTY_DISPLAY;
  }

  const shares = quantity.toLocaleString('zh-TW');
  if (quantity < lotSize) return `${shares} 股`;

  const lots = Math.floor(quantity / lotSize);
  const odd = quantity % lotSize;
  return odd === 0 ? `${shares} 股（${lots} 張）` : `${shares} 股（${lots} 張 ${odd} 股）`;
}

// ============================================================================
// 日期時間
// ============================================================================

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 相對時間。使用者關心的是「多久以前」，不是「幾月幾號」。
 *
 *   < 1 分鐘  剛剛
 *   < 1 小時  23 分鐘前
 *   今天      今天 09:23
 *   昨天      昨天 14:05
 *   7 天內    週三 10:31
 *   今年內    8/10
 *   跨年      2025/12/28
 *
 * ⚠️ 明細「列表」用相對時間，但點開「詳情」要顯示完整時間戳 ——
 *    稽核情境需要精確到秒。詳情用 formatDateTime()。
 */
export function formatRelativeTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return EMPTY_DISPLAY;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_DISPLAY;

  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return '剛剛';
  if (diffMinutes < 60) return `${diffMinutes} 分鐘前`;

  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const daysApart = calendarDaysApart(date, now);

  if (daysApart === 0) return `今天 ${hhmm}`;
  if (daysApart === 1) return `昨天 ${hhmm}`;
  if (daysApart < 7) return `週${WEEKDAYS[date.getDay()]} ${hhmm}`;

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 完整時間戳，精確到分。詳情頁與稽核情境用。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return EMPTY_DISPLAY;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY_DISPLAY;

  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `2026-08-27` → `8/27`。圖表 X 軸用。 */
export function formatShortDate(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : isoDate;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 相差幾個「日曆天」，不是幾個 24 小時。
 *
 * 這個區分很重要：23:50 和隔天 00:10 只差 20 分鐘，但應該顯示
 * 「昨天 23:50」而不是「今天 23:50」。用 diffMs / 86400000 會算錯。
 */
function calendarDaysApart(a: Date, b: Date): number {
  const dayA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const dayB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((dayB - dayA) / 86_400_000);
}

// ============================================================================
// 漲跌方向
// ============================================================================

/** 漲跌方向。決定顏色與符號，是三重編碼的基礎（見 PriceChange 元件）。 */
export type PriceDirection = 'up' | 'down' | 'flat';

/**
 * 由數值推導漲跌方向。
 *
 * 注意 0 是 `flat` 而不是 `down` —— 平盤要用灰色，不能用跌色。
 * 這在單日無成交的標的上很常見。
 */
export function priceDirection(value: number | null | undefined): PriceDirection {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return 'flat';
  }
  return value > 0 ? 'up' : 'down';
}
