/**
 * market-feed/src/walker.ts — 價格隨機漫步
 *
 * 這個檔案是什麼：
 *   把一檔股票的「上一個價格」變成「下一個價格」的規則。
 *
 * 在架構的哪一層：
 *   純函式邏輯層。不碰 Redis、不碰資料庫、不看時間 ——
 *   所以它可以被單獨測試，也不會在半夜產生奇怪的價格。
 *
 * ── 為什麼假報價值得認真做 ★ ─────────────────────────────────────
 *
 *   沒有真實市場資料的金融 demo，九成垮在假資料上。而報價是最容易
 *   露餡的地方 —— 一個數字如果每秒 ±10 元亂跳，或者跳到 888.037，
 *   任何看過股票 App 的人三秒就知道那是假的。
 *
 *   所以這個漫步有三條硬性約束：
 *
 *     1. **價格必須落在合法跳動點上**（888 元的股票只能跳 1 元，
 *        不會出現 888.5）—— 用 shared 的 alignToTick()
 *     2. **不得超出當日漲跌停 ±10%** —— 用 shared 的 priceLimits()
 *     3. **波動幅度要像真的**（單筆 tick 通常在 0.1% 上下，
 *        不是每秒暴漲暴跌）
 *
 *   前兩條直接用後端與前端共用的那份市場規則，所以 market-feed
 *   產生的價格，永遠是使用者「真的能下單」的價格 —— 不會出現
 *   「畫面顯示 888.03，下單卻被拒」這種自打嘴巴的情況。
 */

import {
  alignToTick,
  cents,
  priceLimits,
  type Cents,
} from '../index.js';

/** 一檔標的在記憶體中的狀態。 */
export interface WalkerState {
  readonly symbol: string;
  /** 昨收價，決定漲跌停範圍。整個交易日不變 */
  readonly prevCloseCents: Cents;
  /** 目前價格（已對齊跳動點，這是對外公布的價格） */
  priceCents: Cents;
  /**
   * 未對齊的「真實」價格。
   *
   * ★ 這個欄位存在的理由，是一個實測才會發現的坑：
   *
   *   1645 元的股票，跳動單位是 5 元。而單筆 tick 的波動是 ±0.12%，
   *   大約 2 元 —— **不到半個跳動單位**。如果每次都拿對齊後的價格
   *   當下一次的起點，那 2 元的變動會在對齊時被四捨五入掉，
   *   價格永遠停在 1645，看起來像當機。
   *
   *   （888 元的股票沒這個問題，因為它的跳動單位是 1 元，
   *     單筆波動 1 元剛好跨得過去。所以這個 bug 只發生在高價股，
   *     很容易在開發時漏掉。）
   *
   *   解法是把未對齊的價格留在記憶體裡累積，只在「公布」時對齊。
   *   連續四五筆同方向的小變動累積起來就會跨過一檔，
   *   價格於是以「跳一檔、停一下、再跳一檔」的方式移動 ——
   *   這正是真實高價股在盤中的樣子。
   */
  rawPriceCents: number;
  /** 今日累計成交量（股） */
  volume: number;
}

/**
 * 單筆 tick 的價格變動幅度（標準差）。
 *
 * 0.0012 代表約 ±0.12%。以 888 元的股票來說，單筆變動約 1 元 ——
 * 剛好是一個跳動單位，看起來就像真的在成交。
 *
 * 調大會讓畫面很熱鬧但不可信（真實個股不會每秒跳 1%），
 * 調小則幾乎看不出在動，失去「報價會動」這個重點。
 */
const TICK_VOLATILITY = 0.0012;

/**
 * 每筆 tick 的成交量範圍（股）。
 *
 * 用零股級距（1–999）而不是整張，是因為累加起來的數字比較自然 ——
 * 每筆都是 1000 的倍數看起來像程式產生的。
 */
const VOLUME_PER_TICK_MIN = 1;
const VOLUME_PER_TICK_MAX = 900;

/**
 * 產生下一個價格。
 *
 * ── 為什麼用「常態分布」而不是 `Math.random() * 2 - 1` ──────────
 *
 *   均勻分布的隨機漫步，大幅變動和小幅變動出現的機率一樣。
 *   但真實市場是**小變動很多、大變動很少**（常態分布的形狀）。
 *
 *   用 Box-Muller 轉換把兩個均勻亂數變成常態分布，成本是兩行，
 *   換來的是走勢圖看起來像股票而不是鋸齒。
 *
 * @param state 這檔標的的當前狀態（會被就地修改）
 * @param random 亂數來源。抽成參數是為了測試時可以注入固定序列
 */
export function step(state: WalkerState, random: () => number = Math.random): void {
  const limits = priceLimits(state.prevCloseCents);

  // 常態分布的隨機變動率
  const drift = gaussian(random) * TICK_VOLATILITY;

  // ★ 均值回歸：價格離昨收越遠，越傾向往回走。
  //
  // 沒有這一項的話，純隨機漫步會慢慢飄到漲停或跌停然後貼在那裡不動 ——
  // 因為下面的 clamp 會把它壓住。加上這個輕微的回歸力道，
  // 價格會在昨收附近來回，看起來自然得多。
  const deviation = (state.rawPriceCents - state.prevCloseCents) / state.prevCloseCents;
  const meanReversion = -deviation * 0.05;

  // 漫步走在「未對齊」的價格上，不足一檔的變動才能累積下來
  // （理由見 WalkerState.rawPriceCents 的說明）。
  state.rawPriceCents = state.rawPriceCents * (1 + drift + meanReversion);

  // 先夾住未對齊的價格，再對齊跳動點。
  //
  // 順序很重要：如果先對齊再夾，被夾住的值可能不在跳動點上
  // （漲跌停本身是對齊過的，所以這裡夾完再對齊仍然安全，
  //   但夾在未對齊的值上可以避免 raw 無限往外飄）。
  state.rawPriceCents = Math.min(
    Math.max(state.rawPriceCents, limits.lower),
    limits.upper,
  );

  state.priceCents = alignToTick(cents(Math.round(state.rawPriceCents)));
  state.volume += Math.floor(random() * (VOLUME_PER_TICK_MAX - VOLUME_PER_TICK_MIN + 1)) +
    VOLUME_PER_TICK_MIN;
}

/**
 * Box-Muller 轉換：兩個 [0,1) 均勻亂數 → 一個標準常態分布的值。
 *
 * 回傳值約 68% 落在 ±1、95% 落在 ±2 之間。
 *
 * `1 - random()` 是為了避免取到 0 —— `Math.log(0)` 是 -Infinity，
 * 會讓整個價格變成 NaN，然後所有下游計算跟著壞掉。
 * 這種邊界一年可能只會踩到一次，但踩到時很難查。
 */
function gaussian(random: () => number): number {
  const u1 = 1 - random();
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
