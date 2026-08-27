/**
 * api/src/database/seeds/rng.ts — 可重現的偽亂數產生器
 *
 * 這個檔案是什麼：
 *   一個吃「種子（seed）」的亂數產生器，以及幾個基於它的取樣工具。
 *
 * 為什麼不用 Math.random()：
 *   **因為 demo 的資料每次重整都必須一模一樣。**
 *
 *   面試官打開 demo 看到總資產 1,234,567 元，重整一次變成 987,654 元 ——
 *   他會立刻知道這是隨機產生的假資料，整個專案的可信度就打折了。
 *   更實際的問題是：你自己在錄 demo 影片時，數字一直變根本沒辦法對稿。
 *
 *   `Math.random()` 無法指定種子，所以必須自己實作一個。
 *
 * ── mulberry32 是什麼 ─────────────────────────────────────────────
 *
 *   一個極短的 32 位元 PRNG（偽亂數產生器）。它的特性是：
 *     - **同一個種子必定產生同一串數字**（這正是我們要的）
 *     - 統計品質對「產生假資料」而言綽綽有餘
 *     - 實作只有五行，不需要任何相依套件
 *
 *   ⚠️ **絕對不可用於加密、token、密碼重設連結。**
 *      它的輸出完全可預測 —— 知道種子就知道未來所有的值。
 *      需要安全亂數時請用 `node:crypto` 的 `randomBytes`。
 *
 * 在架構的哪一層：
 *   seed 工具的底層，只被 factory.ts 使用。不屬於執行期的應用程式。
 */

/**
 * 亂數產生器：呼叫一次回傳一個 [0, 1) 之間的浮點數。
 *
 * 與 `Math.random` 的簽章相同，所以可以直接替換。
 */
export type Rng = () => number;

/**
 * 建立一個以指定種子初始化的亂數產生器。
 *
 * ── 演算法逐行說明 ────────────────────────────────────────────────
 *
 * 每次呼叫都對內部狀態 `a` 做一連串位元運算，把它打散成看起來
 * 毫無規律的值，再壓縮到 [0, 1) 區間。關鍵在於這串運算是
 * **完全確定性**的 —— 相同的 `a` 必定得到相同的下一個值。
 *
 *   a |= 0            強制轉成 32 位元整數（JS 的位元運算都在 32 位元下進行）
 *   a = a + 0x6D2B79F5 | 0    加一個大質數常數，讓狀態每次都大幅跳動
 *   Math.imul(...)    32 位元整數乘法。用 imul 而不是 * 是因為
 *                     一般乘法會轉成浮點數而失去低位精度
 *   ^ (a >>> 15)      右移後互斥或，把高位的資訊混進低位
 *   >>> 0             轉成無號 32 位元（0 ~ 4294967295）
 *   / 4294967296      除以 2³² 壓縮到 [0, 1)
 *
 * 這些常數是原作者實驗出來的，沒有特別的數學意義 ——
 * 它們的作用就是「把數字攪得夠亂」。
 *
 * @param seed 種子。同一個種子永遠產生同一串數字
 * @returns 亂數產生器
 *
 * @example
 *   const rng = createRng(42);
 *   rng(); // 0.6011037519201636 —— 換到任何機器、任何時間都是這個值
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 取一個範圍內的整數（含頭含尾）。
 *
 * @param rng 亂數產生器
 * @param min 最小值（含）
 * @param max 最大值（含）
 * @returns min 到 max 之間的整數
 */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 從陣列裡隨機取一個元素。
 *
 * @param rng 亂數產生器
 * @param items 候選陣列，不可為空
 * @returns 陣列中的一個元素
 * @throws {Error} 陣列為空時。回傳 undefined 會讓錯誤在很遠的地方才爆炸，
 *                 不如當場拋出
 */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pick()：候選陣列不可為空');
  }
  // noUncheckedIndexedAccess 開啟時，索引存取的型別會含 undefined，
  // 上面的長度檢查保證了這裡一定取得到值。
  return items[randomInt(rng, 0, items.length - 1)]!;
}

/**
 * 以指定機率回傳 true。
 *
 * @param rng 亂數產生器
 * @param probability 機率，0 到 1 之間。0.3 代表三成的機會
 * @returns 命中時為 true
 */
export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

/**
 * 取一個近似常態分布的隨機數（平均 0、標準差 1）。
 *
 * ── 為什麼股價走勢需要常態分布而不是均勻分布 ──────────────────────
 *
 * 用 `rng()` 產生的均勻分布來走股價，每天漲跌 −1% 到 +1% 的機率完全相同，
 * 走出來的線會像鋸齒一樣規律，一眼就看得出是亂數。
 *
 * 真實股價的日報酬率接近常態分布 —— **大部分時候小幅波動，
 * 偶爾出現大漲大跌**。用常態分布產生的走勢才有「像真的」的形狀。
 *
 * 這裡用 Box-Muller 轉換：把兩個均勻分布的隨機數轉成常態分布。
 * `1 - rng()` 是為了避開 0（log(0) 是負無限大）。
 *
 * @param rng 亂數產生器
 * @returns 近似常態分布的隨機數，約 68% 落在 ±1、95% 落在 ±2 之間
 */
export function randomNormal(rng: Rng): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
