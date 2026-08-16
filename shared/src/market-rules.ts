/**
 * shared/src/market-rules.ts — 台股的交易規則
 *
 * 這個檔案是什麼：
 *   把台股的三條硬規則寫成函式：最小跳動單位（tick size）、
 *   交易成本（手續費與證交稅）、漲跌停價格區間。
 *
 * 為什麼存在、為什麼放在 shared/：
 *   這三條規則**前後端都要用**：
 *     - 後端 `/orders/preview` 要算費用、下單時要驗價格合法性
 *     - 前端下單表單要即時顯示預估費用、要限制價格輸入的級距
 *   如果兩邊各寫一份，總有一天會兜不攏 —— 而且是使用者按下確認之後
 *   才發現金額對不上，那是最糟的發現時機。
 *
 * 為什麼不存進資料庫：
 *   因為這是**規則**不是**資料**。tick size 隨股價浮動（同一檔股票漲過
 *   100 元之後級距就變了），存成欄位反而要處理同步問題。
 *
 * 在架構的哪一層：
 *   依賴 money.ts，被 api 的 orders 模組與 web 的 trading feature 使用。
 *
 * ⚠️ 這裡實作的是**台股規則**。若未來要支援美股，碎股（0.137 股）、
 *    不同的費用結構、沒有漲跌停等差異都要另外處理，不能沿用這個檔案。
 */

import {
  type Cents,
  type Rounding,
  add,
  applyRate,
  cents,
  multiply,
  roundToMajorUnit,
} from './money.js';

// ============================================================================
// 最小跳動單位（tick size）
// ============================================================================

/**
 * 台股的價格級距表。
 *
 * 台股不是每個價格都能掛單 —— 股價越高，最小跳動單位越大。
 * 例如 1085 元的台積電，只能掛 1085、1090、1095…，不能掛 1086。
 *
 * 級距規則（依證交所公告）：
 *
 *   | 股價區間（元）    | 跳動單位（元） | 跳動單位（分） |
 *   |------------------|--------------|--------------|
 *   | 未滿 10          | 0.01         | 1            |
 *   | 10 ~ 未滿 50     | 0.05         | 5            |
 *   | 50 ~ 未滿 100    | 0.1          | 10           |
 *   | 100 ~ 未滿 500   | 0.5          | 50           |
 *   | 500 ~ 未滿 1000  | 1            | 100          |
 *   | 1000 以上        | 5            | 500          |
 *
 * 資料結構用「上界 + 跳動單位」的陣列，由小到大排列。
 * `belowCents` 是**不含**的上界（未滿），最後一級用 Infinity 表示無上界。
 */
const TICK_SIZE_TABLE: readonly { readonly belowCents: number; readonly tickCents: number }[] = [
  { belowCents: 1_000, tickCents: 1 }, //      未滿 10 元 → 0.01 元
  { belowCents: 5_000, tickCents: 5 }, //   10 ~ 未滿 50 → 0.05 元
  { belowCents: 10_000, tickCents: 10 }, //  50 ~ 未滿 100 → 0.1 元
  { belowCents: 50_000, tickCents: 50 }, // 100 ~ 未滿 500 → 0.5 元
  { belowCents: 100_000, tickCents: 100 }, // 500 ~ 未滿 1000 → 1 元
  { belowCents: Number.POSITIVE_INFINITY, tickCents: 500 }, // 1000 以上 → 5 元
];

/**
 * 查出某個價格所屬級距的最小跳動單位。
 *
 * @param price 股價（分／股），必須為正
 * @returns 該價格的最小跳動單位（分）
 * @throws {Error} 價格不為正時
 *
 * @example
 *   tickSize(cents(950))      // 5   （9.5 元 → 未滿 10 元級距，跳 0.01 元）
 *   tickSize(cents(108500))   // 500 （1085 元 → 1000 元以上級距，跳 5 元）
 */
export function tickSize(price: Cents): Cents {
  if (price <= 0) {
    throw new Error(`tickSize()：股價必須為正，收到 ${price}`);
  }

  // 由小到大找第一個「價格未達其上界」的級距。
  // 表最後一列的上界是 Infinity，所以一定找得到，`find` 不會回傳 undefined ——
  // 但 TypeScript 的 noUncheckedIndexedAccess 不知道這件事，所以還是要處理。
  const tier = TICK_SIZE_TABLE.find((t) => price < t.belowCents);
  if (!tier) {
    throw new Error(`tickSize()：找不到 ${price} 分對應的級距（級距表可能損壞）`);
  }
  return cents(tier.tickCents);
}

/**
 * 檢查一個價格是否落在合法的跳動點上。
 *
 * 下單前必須驗這件事 —— 掛出不在級距上的價格，真實券商會直接退件。
 *
 * @param price 股價（分／股）
 * @returns 價格是級距的整數倍時為 true
 *
 * @example
 *   isValidTick(cents(108500))   // true  （1085 元，是 5 元的倍數）
 *   isValidTick(cents(108600))   // false （1086 元，不在 5 元級距上）
 */
export function isValidTick(price: Cents): boolean {
  return price % tickSize(price) === 0;
}

/**
 * 把價格對齊到最近的合法跳動點。
 *
 * 用途是「使用者拖動價格滑桿」或「seed 產生隨機價格」時，
 * 保證產出的價格一定合法。
 *
 * ⚠️ 對齊後可能跨越級距邊界（例如 99.98 元對齊後變 100 元，
 *    而 100 元屬於下一個級距）。這不影響正確性 —— 對齊後的值
 *    在它自己的級距裡仍然合法 —— 但要知道有這個現象。
 *
 * @param price 股價（分／股）
 * @param rounding 捨入方向，預設四捨五入
 * @returns 對齊後的股價（分／股）
 */
export function alignToTick(price: Cents, rounding: Rounding = 'round'): Cents {
  const tick = tickSize(price);
  const ticks =
    rounding === 'floor'
      ? Math.trunc(price / tick)
      : rounding === 'ceil'
        ? Math.ceil(price / tick)
        : Math.round(price / tick);
  return multiply(cents(tick), ticks);
}

// ============================================================================
// 交易成本
// ============================================================================

/** 券商手續費率：成交金額的 0.1425%。買進與賣出都收。 */
export const BROKERAGE_FEE_RATE = 0.001425;

/**
 * 手續費的最低收取金額：20 元。
 *
 * **這條下限很容易被漏掉，而它在小額交易時影響巨大。**
 * 買 1 股 20 元的股票，成交金額 20 元、按費率算手續費只有 0.0285 元，
 * 但實際仍要收 20 元 —— 手續費是本金的 100%。
 *
 * 零股交易的使用者對這件事非常有感，做對了 demo 的可信度會差很多。
 */
export const MINIMUM_BROKERAGE_FEE = 2_000 as Cents; // 20 元 = 2000 分

/** 證券交易稅率：成交金額的 0.3%。**只有賣出時收**，買進不收。 */
export const SECURITIES_TAX_RATE = 0.003;

/** 買賣方向。 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * 一筆交易的成本明細。
 *
 * 所有欄位單位皆為分。`net` 的正負號依買賣方向而不同，詳見各欄位說明。
 */
export interface TradeCost {
  /** 股款：成交價 × 股數。永遠為正 */
  readonly gross: Cents;
  /** 手續費。買賣都收，永遠為正（至少 20 元） */
  readonly fee: Cents;
  /** 證交稅。買進為 0，賣出為股款的 0.3% */
  readonly tax: Cents;
  /**
   * 對帳戶餘額的實際影響金額，**永遠為正**。
   *
   * - 買進：`gross + fee + tax` —— 要從餘額扣掉這麼多
   * - 賣出：`gross - fee - tax` —— 要匯入餘額這麼多
   *
   * 正負號由呼叫端依方向決定（寫進 `transactions.amount_cents` 時才加負號），
   * 這樣這個結構本身讀起來不會有「負的負數」這種繞口的東西。
   */
  readonly net: Cents;
}

/**
 * 計算一筆交易的完整成本。
 *
 * 這是 `POST /orders/preview` 的核心，也是下單時實際扣款的依據。
 * **前後端都呼叫這個函式**，所以確認頁顯示的數字與實際扣款保證一致。
 *
 * ── 捨入規則 ────────────────────────────────────────────────────────
 *
 * 手續費與證交稅都**以元為單位收取、無條件捨去**（`floor`）。
 * 不會出現 154.61 元的手續費，實際收 154 元。捨去而非四捨五入
 * 是對客戶有利的方向，也是多數券商的實務作法。
 *
 * 注意順序：先算出精確值（分），再捨到元，**最後才套用最低 20 元的下限**。
 * 如果先套下限再捨去，20 元的下限不會受影響（2000 分本來就是整數元），
 * 但順序寫對了才不會在未來改費率時出錯。
 *
 * @param price 成交價（分／股），必須為正
 * @param quantity 股數，必須是正整數
 * @param side 買賣方向。影響是否收證交稅、以及 `net` 的算法
 * @returns 成本明細，所有金額單位為分
 * @throws {Error} 股數不是正整數時
 * @throws {MoneyError} 金額超出安全範圍時
 *
 * @example
 *   // 買進 1000 股台積電，每股 1085 元
 *   calculateTradeCost(cents(108500), 1000, 'BUY');
 *   // → { gross: 108_500_00, fee: 154_00, tax: 0, net: 108_654_00 }
 *   //   股款 108,500 元 + 手續費 154 元 = 總計 108,654 元
 */
export function calculateTradeCost(price: Cents, quantity: number, side: OrderSide): TradeCost {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`calculateTradeCost()：股數必須是正整數，收到 ${quantity}`);
  }

  const gross = multiply(price, quantity);

  // 手續費：股款 × 0.1425%，捨到元，再套用 20 元下限。
  const rawFee = roundToMajorUnit(applyRate(gross, BROKERAGE_FEE_RATE, 'floor'), 'floor');
  const fee = rawFee < MINIMUM_BROKERAGE_FEE ? MINIMUM_BROKERAGE_FEE : rawFee;

  // 證交稅：只有賣出才收，股款 × 0.3%，捨到元。
  // 買進時是 0 而不是「不存在」—— 讓 TradeCost 的形狀在買賣兩種情況下一致，
  // 呼叫端就不用寫 `cost.tax ?? 0`。
  const tax =
    side === 'SELL'
      ? roundToMajorUnit(applyRate(gross, SECURITIES_TAX_RATE, 'floor'), 'floor')
      : cents(0);

  // 買進是「付出股款再付費用」，賣出是「收到股款再被扣費用」。
  const costs = add(fee, tax);
  const net = side === 'BUY' ? add(gross, costs) : cents(gross - costs);

  return { gross, fee, tax, net };
}

// ============================================================================
// 漲跌停
// ============================================================================

/** 台股單日漲跌幅上限：10%。 */
export const DAILY_PRICE_LIMIT_RATE = 0.1;

/** 某個交易日的合法價格區間（分／股）。 */
export interface PriceLimits {
  /** 跌停價。以昨收 × 0.9 計算後**無條件進位**到合法跳動點 */
  readonly lower: Cents;
  /** 漲停價。以昨收 × 1.1 計算後**無條件捨去**到合法跳動點 */
  readonly upper: Cents;
}

/**
 * 依昨日收盤價算出當日的漲跌停價。
 *
 * 用於 `PRICE_OUT_OF_RANGE` 錯誤的判斷 —— 掛超出這個區間的限價，
 * 真實券商會直接退件。
 *
 * ── 為什麼捨入方向是「向內」而不是四捨五入 ──────────────────────────
 *
 * 漲停價**捨去**、跌停價**進位**，兩邊都是往區間內側靠。
 * 這樣算出來的價格保證不會超過 ±10% 的法定上限 ——
 * 如果四捨五入，漲停價有可能被進位到 10.02%，那就違規了。
 *
 * 這是「邊界要往安全的方向捨」的典型案例，跟金額捨入是同一種思維。
 *
 * @param prevClose 昨日收盤價（分／股），必須為正
 * @returns 當日合法價格區間
 * @throws {Error} 昨收價不為正時
 */
export function priceLimits(prevClose: Cents): PriceLimits {
  if (prevClose <= 0) {
    throw new Error(`priceLimits()：昨收價必須為正，收到 ${prevClose}`);
  }

  const rawUpper = applyRate(prevClose, 1 + DAILY_PRICE_LIMIT_RATE, 'floor');
  const rawLower = applyRate(prevClose, 1 - DAILY_PRICE_LIMIT_RATE, 'ceil');

  return {
    upper: alignToTick(rawUpper, 'floor'),
    lower: alignToTick(rawLower, 'ceil'),
  };
}

/**
 * 檢查限價是否落在當日合法區間內。
 *
 * @param price 委託價（分／股）
 * @param prevClose 昨日收盤價（分／股）
 * @returns 價格在漲跌停區間內時為 true
 */
export function isWithinPriceLimits(price: Cents, prevClose: Cents): boolean {
  const limits = priceLimits(prevClose);
  return price >= limits.lower && price <= limits.upper;
}
