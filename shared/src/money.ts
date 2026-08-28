/**
 * shared/src/money.ts — 金額運算的唯一入口
 *
 * 這個檔案是什麼：
 *   本專案所有金額的型別定義與四則運算。凡是跟「錢」有關的計算，
 *   一律呼叫這裡的函式，不准在元件或 Service 裡直接寫 `a + b`。
 *
 * 為什麼存在：
 *   金融系統最致命的錯誤是浮點誤差。JavaScript 裡：
 *
 *     0.1 + 0.2 === 0.30000000000000004   // 不等於 0.3
 *
 *   一筆兩筆看不出來，累積幾千筆之後帳就對不起來了。
 *   解法是**一律用整數的「分」來運算**，只有最後要顯示給人看時才轉成元。
 *
 *   但光是「用整數」還不夠 —— `number` 型別無法區分「這個 5 是 5 元還是 5 分」。
 *   所以這裡再加一層 branded type，讓 TypeScript 在編譯期就擋下單位混用。
 *
 * 在架構的哪一層：
 *   最底層的最底層。它不依賴任何東西（連 zod 都不用），
 *   反過來 schema、api、web 全都依賴它。
 *
 * 相關決策：docs/adr/0005-money-as-bigint-cents.md
 */

// ============================================================================
// 型別
// ============================================================================

/**
 * 一元等於幾分。
 *
 * 本專案所有金額一律以「分」為最小單位的整數儲存，絕不使用浮點數
 * （見 docs/adr/0005）。這個常數是元與分之間換算的唯一依據。
 *
 * 它定義在 money.ts 而不是 index.ts，是為了避免循環相依 ——
 * index.ts 會 `export *` 這個檔案，如果這個檔案反過來 import index.ts，
 * 就形成了一個環。把常數放在它真正歸屬的模組裡，環自然就不存在。
 */
export const CENTS_PER_UNIT = 100;

/**
 * 金額，單位是「分」。1 元 = 100 分。
 *
 * ── 什麼是 branded type（品牌型別）？ ───────────────────────────────
 *
 * 這個型別在執行期就是一個普通的 `number` —— `& { __brand }` 的部分
 * 編譯完就消失了，不會產生任何執行期成本。它存在的唯一目的是讓
 * TypeScript 把「分」和「一般數字」視為兩種不同的型別：
 *
 *     const price: Cents = 1085;      // ❌ 編譯錯誤，不能直接指派
 *     const price = cents(1085);      // ✅ 必須經過建構函式
 *
 *     function pay(amount: Cents) {}
 *     pay(500);                       // ❌ 編譯錯誤：500 是什麼？元還是分？
 *     pay(cents(500));                // ✅ 意圖明確
 *
 * 為什麼需要這一層：
 *   單位混用是金融程式最常見也最難抓的 bug —— 它不會 crash，
 *   只會讓金額差 100 倍，而且要等到有人對帳才發現。
 *   靠命名約定（`xxxCents`）只能防君子，branded type 才有編譯器強制力。
 *
 * `readonly __brand` 這個屬性實際上永遠不存在，
 * 純粹是給型別系統看的標記，所以名字用雙底線開頭表示「不要碰」。
 */
export type Cents = number & { readonly __brand: 'Cents' };

// ============================================================================
// 邊界
// ============================================================================

/**
 * 金額的絕對上限（分）。
 *
 * 資料庫的 `BIGINT` 上限是約 9.2 × 10¹⁸，但**真正的瓶頸在 JavaScript**：
 * `Number.MAX_SAFE_INTEGER` = 9,007,199,254,740,991（約 9 × 10¹⁵ 分，
 * 換算約 90 兆元）。超過這個值之後，整數運算會開始靜默失去精度：
 *
 *     Number.MAX_SAFE_INTEGER + 1 === Number.MAX_SAFE_INTEGER + 2   // true！
 *
 * 注意「靜默」兩個字 —— 不會拋錯，只會算錯。所以我們寧可自己主動拋錯。
 *
 * 本專案的資料量級（帳戶餘額百萬元級）離這個上限非常遠，
 * 這個檢查是**防呆**，不是防溢位：真正會觸發它的情境是程式有 bug
 * （例如把元當成分又乘了一次 100），而不是使用者真的有 90 兆。
 */
export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * 金額為零。
 *
 * 提供這個常數而不是讓大家寫 `cents(0)`，是因為「零」出現的頻率很高
 * （初始餘額、累加器的起始值），有個具名常數讀起來比較清楚。
 */
export const ZERO_CENTS = 0 as Cents;

/**
 * 金額運算失敗時拋出的錯誤。
 *
 * 用自訂的 Error 子類別而不是普通 Error，是為了讓上層能用
 * `instanceof MoneyError` 精準攔截，而不是去比對錯誤訊息字串。
 * （比對字串會在改文案時整個壞掉 —— 跟錯誤碼契約是同一個道理。）
 */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * 檢查一個數字是否為合法的金額（分）。
 *
 * 合法的條件有三個，任何一個不滿足都拋 `MoneyError`：
 *   1. 是有限數字（不是 NaN、不是 Infinity）
 *   2. 是整數（分是最小單位，不存在 0.5 分）
 *   3. 絕對值不超過 `MAX_SAFE_CENTS`
 *
 * @param value 待檢查的數字，單位為分
 * @param context 出錯時要顯示在訊息裡的情境描述，方便定位是哪個運算爆的
 * @throws {MoneyError} 任一條件不滿足時
 */
function assertValidCents(value: number, context: string): void {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${context}：金額必須是有限數字，收到 ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    // 這條最常見的觸發原因是「有人把元直接傳進來了」或「除法沒有取整」。
    throw new MoneyError(`${context}：金額必須是整數分，收到 ${value}（是不是漏了取整？）`);
  }
  if (Math.abs(value) > MAX_SAFE_CENTS) {
    throw new MoneyError(
      `${context}：金額 ${value} 超出 JavaScript 安全整數範圍（±${MAX_SAFE_CENTS}），` +
        `超過之後運算會靜默失去精度`,
    );
  }
}

// ============================================================================
// 建構
// ============================================================================

/**
 * 把一個「已經是分」的整數標記成 `Cents`。
 *
 * 這是從外部資料進入型別系統的**唯一入口**：資料庫讀出來的 `BIGINT`、
 * API 收到的 JSON number，都要經過這裡才會變成 `Cents`。
 *
 * @param value 金額，單位為分。必須是整數
 * @returns 同一個數值，但型別標記為 `Cents`
 * @throws {MoneyError} 不是整數、不是有限數字、或超出安全範圍時
 *
 * @example
 *   cents(108500)   // 1085.00 元
 *   cents(1085.5)   // ❌ 拋錯：分沒有小數
 */
export function cents(value: number): Cents {
  assertValidCents(value, 'cents()');
  return value as Cents;
}

/**
 * 把「元」換算成「分」。
 *
 * 這個函式是**邊界轉換**用的 —— 只在使用者輸入、或處理以元為單位的
 * 外部資料時使用。系統內部一律直接用分，不該反覆在元和分之間來回轉。
 *
 * 為什麼要 `Math.round` 而不是直接乘：
 *   `1085.55 * 100` 在 JavaScript 裡會得到 108554.99999999999，
 *   直接 `as Cents` 會被 `assertValidCents` 的整數檢查擋下來。
 *   這正是浮點誤差的實例 —— 也是我們一開始就決定不用浮點存金額的原因。
 *
 * @param amount 金額，單位為元。可以有小數（最多兩位有意義）
 * @returns 換算後的分
 * @throws {MoneyError} 換算結果超出安全範圍時
 *
 * @example
 *   fromMajorUnits(1085)     // 108500
 *   fromMajorUnits(1085.55)  // 108555
 *   fromMajorUnits(0.005)    // 1（四捨五入到分；比分更小的精度會被捨棄）
 */
export function fromMajorUnits(amount: number): Cents {
  if (!Number.isFinite(amount)) {
    throw new MoneyError(`fromMajorUnits()：金額必須是有限數字，收到 ${String(amount)}`);
  }
  return cents(Math.round(amount * CENTS_PER_UNIT));
}

/**
 * 把「分」換算回「元」。
 *
 * ⚠️ **回傳的是浮點數，只能用於顯示或測試，絕不可用來繼續運算。**
 *
 * 之所以會有浮點誤差，是因為除以 100 之後可能除不盡（在二進位裡
 * 0.01 是無限循環小數）。所以拿到結果就該立刻格式化成字串，
 * 不要再拿去加減乘除 —— 那等於把我們千辛萬苦避開的問題請回來。
 *
 * 前端真正該用的是 `MoneyText` 元件（Phase 1 建立），
 * 它負責千分位、幣別符號、小數位數。這個函式是它的底層。
 *
 * @param value 金額，單位為分
 * @returns 金額，單位為元
 */
export function toMajorUnits(value: Cents): number {
  return value / CENTS_PER_UNIT;
}

// ============================================================================
// 四則運算
//
// 為什麼加減也要包成函式（`add(a, b)` 明明比 `a + b` 囉唆）：
//   1. 回傳型別維持 `Cents` —— 直接寫 `a + b` 的結果會退化成 `number`，
//      branded type 的保護就從那一行開始失效了
//   2. 每一步都做邊界檢查 —— 溢位在第一時間就拋錯，而不是等對帳才發現
// ============================================================================

/**
 * 相加。
 *
 * @param a 被加數（分）
 * @param b 加數（分）
 * @returns 和（分）
 * @throws {MoneyError} 結果超出安全範圍時
 */
export function add(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

/**
 * 相減。
 *
 * 允許結果為負 —— `transactions.amount_cents` 就是用正負來表示
 * 「入帳」與「出帳」。真正不允許負數的是帳戶餘額，那條防線在
 * 資料庫的 `CHECK (cash_balance_cents >= 0)`，不在這裡。
 *
 * @param a 被減數（分）
 * @param b 減數（分）
 * @returns 差（分），可能為負
 * @throws {MoneyError} 結果超出安全範圍時
 */
export function subtract(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

/**
 * 金額乘以一個整數倍數。
 *
 * 典型用途是「單價 × 股數」：
 *
 *     const gross = multiply(cents(108500), 1000);   // 1000 股 × 1085 元
 *
 * 倍數限定為整數，因為這個函式的語意是「幾份」。
 * 需要乘小數（例如費率 0.1425%）的場合請用 `applyRate`，
 * 那個函式會強制你指定捨入方式。
 *
 * @param value 單價或單位金額（分）
 * @param factor 倍數，必須是整數（例如股數）
 * @returns 乘積（分）
 * @throws {MoneyError} factor 不是整數，或結果超出安全範圍時
 */
export function multiply(value: Cents, factor: number): Cents {
  if (!Number.isInteger(factor)) {
    throw new MoneyError(
      `multiply()：倍數必須是整數，收到 ${factor}。` +
        `要乘以費率之類的小數請改用 applyRate()`,
    );
  }
  return cents(value * factor);
}

/**
 * 捨入方式。
 *
 * 金融運算裡「往哪邊捨」不是細節而是業務規則 —— 手續費往下捨是對客戶
 * 有利，往上進是對券商有利，兩者差幾塊錢，但在稽核時是完全不同的事。
 * 所以這裡不給預設值，強迫呼叫端明確指定。
 */
export type Rounding =
  /** 四捨五入。用於一般換算 */
  | 'round'
  /** 無條件捨去（往零的方向）。台股手續費與證交稅採用此規則 */
  | 'floor'
  /** 無條件進位（遠離零的方向） */
  | 'ceil';

/**
 * 依指定方式把一個浮點結果捨入成整數分。
 *
 * 注意 `floor` / `ceil` 是**以零為基準**而不是以數線為基準：
 * -1.5 用 `floor` 得到 -1（往零捨去），不是 -2。
 * 這樣「捨去」對正負金額的語意才一致 —— 都是「金額變小」。
 */
function applyRounding(raw: number, mode: Rounding): number {
  switch (mode) {
    case 'round':
      return Math.round(raw);
    case 'floor':
      return Math.trunc(raw);
    case 'ceil':
      return raw < 0 ? Math.floor(raw) : Math.ceil(raw);
  }
}

/**
 * 金額乘以一個比率（費率、稅率、百分比）。
 *
 * @param value 基準金額（分）
 * @param rate 比率。**用小數表示，不是百分比** —— 0.1425% 要寫 0.001425
 * @param rounding 捨入方式。無預設值，必須明確指定（理由見 `Rounding`）
 * @returns 結果（分）
 * @throws {MoneyError} rate 不是有限數字，或結果超出安全範圍時
 *
 * @example
 *   // 成交金額 108,500 元的手續費（0.1425%，無條件捨去）
 *   applyRate(cents(10850000), 0.001425, 'floor')   // 15461 分 = 154.61 元
 */
export function applyRate(value: Cents, rate: number, rounding: Rounding): Cents {
  if (!Number.isFinite(rate)) {
    throw new MoneyError(`applyRate()：比率必須是有限數字，收到 ${String(rate)}`);
  }
  return cents(applyRounding(value * rate, rounding));
}

/**
 * 把金額捨入到「整數元」。
 *
 * 為什麼需要這個：台股的手續費與證交稅都是**以元為單位收取**的，
 * 不會出現 154.61 元的手續費，實際會收 154 元。所以算完費率之後
 * 還要再抹掉分的部分。
 *
 * @param value 金額（分）
 * @param rounding 捨入方式
 * @returns 捨入到整數元後的金額（分），保證是 100 的倍數
 *
 * @example
 *   roundToMajorUnit(cents(15461), 'floor')   // 15400 分 = 154 元
 */
export function roundToMajorUnit(value: Cents, rounding: Rounding): Cents {
  const units = applyRounding(value / CENTS_PER_UNIT, rounding);
  return cents(units * CENTS_PER_UNIT);
}

/**
 * 加總一串金額。
 *
 * 從 `ZERO_CENTS` 開始逐項相加，每一步都會經過 `add` 的邊界檢查。
 * 空陣列回傳零，這是刻意的 —— 「沒有任何交易」的總額就是零，不是錯誤。
 *
 * @param values 金額陣列（分）
 * @returns 總和（分）
 * @throws {MoneyError} 累加過程中任一步超出安全範圍時
 */
export function sum(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, value) => add(acc, value), ZERO_CENTS);
}

/**
 * 取絕對值。
 *
 * 明細頁會用到：`amount_cents` 存的是帶正負號的異動金額，
 * 但顯示時通常是「− NT$ 1,234」這種形式，正負號由 UI 決定，
 * 數字本身取絕對值。
 *
 * @param value 金額（分）
 * @returns 絕對值（分）
 */
export function abs(value: Cents): Cents {
  return cents(Math.abs(value));
}

/**
 * 取相反數。
 *
 * @param value 金額（分）
 * @returns 相反數（分）
 */
export function negate(value: Cents): Cents {
  return cents(-value);
}

// ============================================================================
// 比較
//
// 為什麼不直接用 `a > b`：
//   單純比大小其實直接用運算子沒問題（不會有型別退化的問題）。
//   提供這些函式是為了語意 —— `isInsufficient(balance, required)` 比
//   `balance < required` 更能表達「這是餘額檢查」而不是隨便一個比較。
// ============================================================================

/**
 * 比較兩個金額。
 *
 * 回傳值的約定與 `Array.prototype.sort` 的比較函式一致，
 * 所以可以直接拿來排序：`positions.sort((a, b) => compare(a.value, b.value))`
 *
 * @param a 左邊的金額（分）
 * @param b 右邊的金額（分）
 * @returns a < b 回傳負數；a === b 回傳 0；a > b 回傳正數
 */
export function compare(a: Cents, b: Cents): number {
  return a - b;
}

/**
 * 是否為零。
 *
 * @param value 金額（分）
 */
export function isZero(value: Cents): boolean {
  return value === 0;
}

/**
 * 是否為負數（出帳、虧損）。
 *
 * @param value 金額（分）
 */
export function isNegative(value: Cents): boolean {
  return value < 0;
}

/**
 * 是否為正數（入帳、獲利）。
 *
 * @param value 金額（分）
 */
export function isPositive(value: Cents): boolean {
  return value > 0;
}

/**
 * 餘額是否不足以支付。
 *
 * 這是下單流程的核心檢查之一。命名成 `isInsufficient` 而不是
 * `lessThan`，是為了讓呼叫端一眼看出這行在做業務判斷：
 *
 *     if (isInsufficient(account.balance, order.totalCost)) {
 *       throw new InsufficientFundsError();
 *     }
 *
 * ⚠️ **這個檢查必須在資料庫交易內、且在 `SELECT ... FOR UPDATE` 之後執行。**
 * 在交易外檢查等於沒檢查 —— 檢查完到實際扣款之間，餘額可能已經被
 * 另一個請求改掉了（TOCTOU 問題，詳見 docs/02-backend.md 的交易一致性設計）。
 *
 * @param available 可用餘額（分）
 * @param required 所需金額（分）
 * @returns 餘額不足時為 true
 */
export function isInsufficient(available: Cents, required: Cents): boolean {
  return available < required;
}

// ============================================================================
// 平均成本
// ============================================================================

/**
 * 計算加權平均成本。
 *
 * 這是持倉表 `avg_cost_cents` 的計算方式，也是整個 demo 資料可信度的關鍵 ——
 * 如果有人心算發現「持倉成本跟明細對不上」，整個 demo 的可信度就崩了。
 *
 * ── 公式 ──────────────────────────────────────────────────────────
 *
 *     新平均成本 = (原持股 × 原均價 + 新買股數 × 買入價) / (原持股 + 新買股數)
 *
 * 例：原本持有 1000 股、均價 100 元，再買 1000 股、價格 110 元
 *     → (1000 × 100 + 1000 × 110) / 2000 = 105 元
 *
 * ── 為什麼賣出不影響平均成本 ────────────────────────────────────────
 *
 * 賣出只減少股數，不改變剩餘股票的取得成本 —— 賣掉的部分變成
 * 「已實現損益」，留下的部分成本不變。這是會計上的標準處理，
 * 也是為什麼這個函式只處理「買入」的情況。
 *
 * ── 精度處理 ────────────────────────────────────────────────────────
 *
 * 除法必定除不盡（2000 股攤 105.5 元），這裡採**四捨五入到分**。
 * 由此產生的尾差最多 0.5 分／股，不會累積 —— 因為每次都是拿
 * 「總成本」重算，不是拿上次的平均值再平均。
 *
 * @param currentQuantity 目前持股數，必須 >= 0
 * @param currentAvgCost 目前平均成本（分／股）
 * @param addedQuantity 新增股數，必須 > 0
 * @param addedPrice 新增部位的成交價（分／股）
 * @returns 新的平均成本（分／股）
 * @throws {MoneyError} 股數為負、新增股數不為正、或股數不是整數時
 */
export function weightedAverageCost(
  currentQuantity: number,
  currentAvgCost: Cents,
  addedQuantity: number,
  addedPrice: Cents,
): Cents {
  if (!Number.isInteger(currentQuantity) || currentQuantity < 0) {
    throw new MoneyError(`weightedAverageCost()：目前股數必須是非負整數，收到 ${currentQuantity}`);
  }
  if (!Number.isInteger(addedQuantity) || addedQuantity <= 0) {
    throw new MoneyError(`weightedAverageCost()：新增股數必須是正整數，收到 ${addedQuantity}`);
  }

  // 用「總成本」而不是「平均值再平均」來計算，避免誤差累積。
  const currentCost = multiply(currentAvgCost, currentQuantity);
  const addedCost = multiply(addedPrice, addedQuantity);
  const totalCost = add(currentCost, addedCost);
  const totalQuantity = currentQuantity + addedQuantity;

  return cents(Math.round(totalCost / totalQuantity));
}
