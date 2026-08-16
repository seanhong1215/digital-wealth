/**
 * api/src/database/seeds/instruments.ts — 交易標的種子資料
 *
 * 這個檔案是什麼：
 *   一份台股標的清單，作為整個 demo 的標的池。
 *
 * 為什麼用真實的股票代號與名稱：
 *   PROJECT.md 的合規紅線是「不使用任何真實**金融機構**的名稱、Logo、
 *   主色、字體或 UI 截圖」—— 那是為了避免商標使用的疑慮。
 *
 *   **上市公司的股票代號與名稱是公開市場資訊，不在此列**：
 *     - 它們是證交所公告的公開資料，不是品牌識別的使用
 *     - 任何看盤軟體、新聞、教科書都會列出這些代號
 *     - 用虛構代號（例如「9999 假設公司」）反而會讓 demo 顯得不真實
 *
 *   ⚠️ 但**價格一律是程式產生的假資料**，不是真實報價。
 *      README 必須寫明這點，介面上也不得呈現任何投資建議
 *      （PROJECT.md 的延伸紅線 —— 投資建議涉及金管會的投顧特許業務）。
 *
 * 為什麼標的池要涵蓋不同價位：
 *   台股的最小跳動單位隨股價分級（未滿 10 元跳 0.01、1000 元以上跳 5）。
 *   如果標的全是幾百元的大型股，`shared/market-rules.ts` 的級距邏輯
 *   在 demo 裡永遠只會走到其中一兩個分支 —— 那等於沒有展示。
 *   下面刻意混入低價股與千元股，讓級距規則在畫面上真的看得到。
 *
 * 在架構的哪一層：
 *   seed 資料，不屬於執行期的應用程式。
 */

/** 標的的種子定義。價格用「元」表示，寫進資料庫前才換算成分。 */
export interface InstrumentSeed {
  /** 股票代號 */
  readonly symbol: string;
  /** 公司名稱 */
  readonly name: string;
  /** 上市（TWSE）或上櫃（TPEX） */
  readonly market: 'TWSE' | 'TPEX';
  /**
   * 起始價格（元／股）。
   *
   * 這是價格序列的起點，不是真實報價。之後每天的收盤價由
   * factory.ts 的隨機漫步從這裡推導出來。
   */
  readonly basePriceInUnits: number;
  /**
   * 年化波動度，用於產生價格走勢。
   *
   * 值越大，走勢起伏越劇烈。0.2 大約是大型權值股的水準，
   * 0.5 則接近中小型股。給不同標的不同的波動度，
   * 走勢圖看起來才不會每條線都長一樣。
   */
  readonly volatility: number;
}

/**
 * 標的池。
 *
 * 20 檔的規模是刻意的：
 *   - `active` 情境會從中挑 8–15 檔建立持倉（規格要求）
 *   - 剩下的留給「搜尋標的」與「下單時挑新標的」的情境
 *   - 再多就只是灌水，對展示沒有幫助
 */
export const INSTRUMENT_SEEDS: readonly InstrumentSeed[] = [
  // ── 千元以上（跳動單位 5 元）───────────────────────────────────
  { symbol: '2330', name: '台積電', market: 'TWSE', basePriceInUnits: 1085, volatility: 0.24 },
  { symbol: '3008', name: '大立光', market: 'TWSE', basePriceInUnits: 2340, volatility: 0.32 },

  // ── 100–1000 元（跳動單位 0.5 / 1 元）──────────────────────────
  { symbol: '2454', name: '聯發科', market: 'TWSE', basePriceInUnits: 1_240, volatility: 0.3 },
  { symbol: '2317', name: '鴻海', market: 'TWSE', basePriceInUnits: 205, volatility: 0.26 },
  { symbol: '2308', name: '台達電', market: 'TWSE', basePriceInUnits: 412, volatility: 0.28 },
  { symbol: '2382', name: '廣達', market: 'TWSE', basePriceInUnits: 268, volatility: 0.34 },
  { symbol: '3231', name: '緯創', market: 'TWSE', basePriceInUnits: 118, volatility: 0.38 },
  { symbol: '2379', name: '瑞昱', market: 'TWSE', basePriceInUnits: 486, volatility: 0.31 },
  { symbol: '3034', name: '聯詠', market: 'TWSE', basePriceInUnits: 512, volatility: 0.29 },
  { symbol: '5269', name: '祥碩', market: 'TWSE', basePriceInUnits: 1_505, volatility: 0.35 },

  // ── 50–100 元（跳動單位 0.1 元）────────────────────────────────
  { symbol: '2412', name: '中華電', market: 'TWSE', basePriceInUnits: 124, volatility: 0.11 },
  { symbol: '1301', name: '台塑', market: 'TWSE', basePriceInUnits: 52, volatility: 0.18 },
  { symbol: '2002', name: '中鋼', market: 'TWSE', basePriceInUnits: 22, volatility: 0.16 },
  { symbol: '2891', name: '中信金', market: 'TWSE', basePriceInUnits: 36, volatility: 0.15 },
  { symbol: '2884', name: '玉山金', market: 'TWSE', basePriceInUnits: 27, volatility: 0.14 },

  // ── 10–50 元（跳動單位 0.05 元）────────────────────────────────
  { symbol: '2603', name: '長榮', market: 'TWSE', basePriceInUnits: 198, volatility: 0.45 },
  { symbol: '2609', name: '陽明', market: 'TWSE', basePriceInUnits: 68, volatility: 0.48 },
  { symbol: '6488', name: '環球晶', market: 'TPEX', basePriceInUnits: 445, volatility: 0.36 },
  { symbol: '5483', name: '中美晶', market: 'TPEX', basePriceInUnits: 142, volatility: 0.33 },

  // ── 未滿 10 元（跳動單位 0.01 元）★ 讓最小級距在 demo 裡看得到 ──
  { symbol: '2409', name: '友達', market: 'TWSE', basePriceInUnits: 16.5, volatility: 0.42 },
];
