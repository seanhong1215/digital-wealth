/**
 * shared/src/schemas/portfolio.ts — 標的、持倉、投組的契約
 *
 * 這個檔案是什麼：
 *   投組相關的所有 schema：交易標的、持倉、總覽聚合、資產快照。
 *
 * 對應端點：
 *   GET /api/v1/instruments
 *   GET /api/v1/instruments/:symbol
 *   GET /api/v1/positions
 *   GET /api/v1/portfolio/summary
 *   GET /api/v1/portfolio/snapshots
 *
 * ── 這個檔案裡最重要的觀念：權威值 vs 衍生值 ──────────────────────
 *
 * 全端專案最容易做錯的地方，是同一個數字在前後端各算一次然後兜不攏。
 * 本專案的判準寫在 docs/00-architecture.md：
 *
 *   **涉及金錢正確性的用後端算；隨即時報價變動的用前端算。**
 *
 *   後端算（權威）：帳戶餘額、持倉成本、已實現損益
 *   前端算（衍生）：總市值、未實現損益、漲跌幅、漲跌色
 *
 * 為什麼未實現損益要前端算：它隨每個報價 tick 變動。若由後端算，
 * 每次 tick 都要重算整個投組再推送，頻寬與運算都不划算，
 * 而且推送延遲會讓數字看起來卡頓。
 *
 * 所以下面的 schema 裡，後端只提供**成本基礎與昨收價**，
 * 前端拿到即時報價後自己算市值與損益。
 *
 * 在架構的哪一層：契約層。
 */

import { z } from 'zod';

import {
  centsSchema,
  isoDateSchema,
  limitSchema,
  nonNegativeCentsSchema,
  quantitySchema,
  uuidSchema,
} from './common.js';

// ============================================================================
// 交易標的
// ============================================================================

/** 市場別。TWSE = 上市，TPEX = 上櫃。 */
export const marketSchema = z.enum(['TWSE', 'TPEX']);
export type Market = z.infer<typeof marketSchema>;

/**
 * 交易標的。
 *
 * ⚠️ 注意這裡**沒有 tickSize 欄位**，是刻意的。
 *
 * 台股的最小跳動單位隨股價分級（未滿 10 元跳 0.01、1000 元以上跳 5）。
 * 它是**規則**不是**資料** —— 同一檔股票漲過 100 元之後級距就變了，
 * 存成欄位反而要處理同步問題。
 *
 * 前端需要它時，呼叫 `tickSize(prevCloseCents)`
 * （來自 shared/market-rules.ts，前後端共用同一份實作）。
 */
export const instrumentSchema = z.object({
  id: uuidSchema,
  /** 股票代號，例如 `2330` */
  symbol: z.string(),
  /** 公司名稱，例如 `台積電` */
  name: z.string(),
  market: marketSchema,
  /** 一張的股數。台股整股一張 = 1000 股 */
  lotSize: z.number().int().positive(),
  /**
   * 昨日收盤價（分／股）。
   *
   * **這是漲跌計算的基準**：漲跌幅 =（現價 − 昨收）/ 昨收。
   * 漲跌停區間也由它推算（見 shared/market-rules.ts 的 priceLimits）。
   */
  prevCloseCents: nonNegativeCentsSchema,
  /** 是否可交易。停止交易的標的下單會被拒絕 */
  isActive: z.boolean(),
});

export type Instrument = z.infer<typeof instrumentSchema>;

/**
 * 標的搜尋的查詢參數。
 *
 * 對應 `GET /instruments?q=2330&limit=20`
 */
export const instrumentQuerySchema = z.object({
  /**
   * 搜尋關鍵字，比對代號或名稱。
   *
   * 省略時回傳全部（受 limit 限制）。這個行為是刻意的 ——
   * 下單頁一開啟就要顯示可選標的清單，不該強迫使用者先打字。
   */
  q: z.string().trim().optional(),
  limit: limitSchema,
});

export type InstrumentQuery = z.infer<typeof instrumentQuerySchema>;

// ============================================================================
// 持倉
// ============================================================================

/**
 * 單筆持倉。
 *
 * ── 後端提供什麼、不提供什麼 ──────────────────────────────────────
 *
 *   ✅ 提供：股數、平均成本、成本總額、標的資料（含昨收價）
 *   ❌ 不提供：市值、未實現損益、報酬率
 *
 * 後三者需要**即時報價**才算得準，由前端在收到 WebSocket 報價後
 * 自行計算：
 *
 *     市值     = quantity × 即時價
 *     未實現損益 = 市值 − costBasisCents
 *     報酬率    = 未實現損益 / costBasisCents
 *
 * 報價還沒進來時（Phase 2 之前，或報價中斷時），
 * 前端可以先用 `instrument.prevCloseCents` 當作近似值，
 * 並在 UI 上標示「非即時」—— 這就是降級顯示。
 */
export const positionSchema = z.object({
  id: uuidSchema,
  /** 標的完整資料。內嵌而非只給 id，避免前端為了顯示名稱再打一次 API */
  instrument: instrumentSchema,
  /** 持有股數 */
  quantity: quantitySchema,
  /**
   * 平均成本（分／股）。由歷史買入加權平均而來。
   *
   * **賣出不改變這個值** —— 賣掉的部分變成已實現損益，
   * 留下的部分取得成本不變。這是會計上的標準處理。
   */
  avgCostCents: nonNegativeCentsSchema,
  /**
   * 成本總額（分）= quantity × avgCostCents。
   *
   * 為什麼後端幫忙算好，而不是讓前端自己乘：
   *   這是純粹的便利性 —— 它不隨報價變動，屬於權威值的一部分。
   *   前端每次渲染都乘一次也不會錯，但由後端提供可以少一個出錯的地方。
   */
  costBasisCents: nonNegativeCentsSchema,
});

export type Position = z.infer<typeof positionSchema>;

// ============================================================================
// 投組總覽
// ============================================================================

/**
 * 投組總覽聚合。
 *
 * 對應 `GET /portfolio/summary`。
 *
 * ⚠️ **這裡的 marketValueCents 是以「昨收價」計算的基準值，不是即時市值。**
 *
 * 它存在的理由是讓前端在報價還沒進來時（頁面剛載入的前幾百毫秒、
 * 或報價中斷時）有東西可以顯示，不用先出現一個空白或 0。
 * 報價進來後前端會用即時價重算並覆蓋它。
 *
 * 這是「先顯示近似值，再用精確值取代」的常見模式 ——
 * 比讓使用者盯著骨架屏等待好得多。
 */
export const portfolioSummarySchema = z.object({
  /** 可用現金（分）。權威值 */
  cashCents: nonNegativeCentsSchema,
  /** 持股市值（分），**以昨收價計算的基準值**。前端會用即時報價覆蓋 */
  marketValueCents: nonNegativeCentsSchema,
  /** 總資產（分）= cashCents + marketValueCents。同樣是基準值 */
  totalValueCents: nonNegativeCentsSchema,
  /** 持倉成本總額（分）。權威值，不隨報價變動 */
  totalCostBasisCents: nonNegativeCentsSchema,
  /**
   * 已實現損益（分）。**權威值，由後端計算。**
   *
   * 定義：`現金餘額 + 持倉成本總額 − 淨入金`
   *
   * 展開之後等於「賣出價差 − 手續費 − 證交稅 + 股利」，
   * 也就是**扣掉所有成本之後、真正已經落袋的損益**。
   * 可能為負（賠錢或費用大於獲利）。
   *
   * 為什麼用這個算式而不是逐筆累加賣出價差：
   *   逐筆計算需要知道「每次賣出當下的成本基礎」，
   *   而我們只存了當前的平均成本。用餘額回推可以一條 SQL 算完，
   *   而且結果在數學上是等價的。
   *
   * ⚠️ 誤差來源：平均成本以「分／股」為單位四捨五入儲存，
   *    所以持倉成本總額會有最多 0.5 分／股的捨入誤差。
   *    以本專案的量級（萬股級）影響在數十分以內，可以接受。
   */
  realizedPnlCents: centsSchema,
  /**
   * 今日損益（分）。
   *
   * 定義：`最新一日快照的總資產 − 前一日快照的總資產`
   *
   * ⚠️ 這個算法**包含當日的入出金**，嚴格來說不是純粹的投資損益。
   *    真正精確的算法需要逐日的每檔收盤價，而我們只存了最新的昨收價。
   *    以 demo 的用途來說這個近似夠用，但值得知道差別在哪。
   *
   * 快照不足兩天時為 0（新帳戶的第一天）。
   */
  todayPnlCents: centsSchema,
});

export type PortfolioSummary = z.infer<typeof portfolioSummarySchema>;

// ============================================================================
// 資產快照（走勢曲線）
// ============================================================================

/**
 * 單日資產快照。
 *
 * ── 為什麼走勢曲線讀快照而不是即時計算 ────────────────────────────
 *
 * 要畫近 30 天的資產曲線，即時算的話得對每一天重建
 * 「當天持倉 × 當天收盤價」，等於把整個交易歷史重播 30 次。
 *
 * 快照表用空間換時間，一天一列，30 天就是 30 列 ——
 * 這是**預先計算（pre-aggregation）** 的典型應用場景。
 *
 * 真實系統會用排程每日收盤後寫入；本專案 MVP 由 seed 直接產生。
 */
export const portfolioSnapshotSchema = z.object({
  /** 快照日期，`YYYY-MM-DD`。用 DATE 而非時間點，粒度就是「一天」 */
  date: isoDateSchema,
  cashCents: nonNegativeCentsSchema,
  marketValueCents: nonNegativeCentsSchema,
  totalValueCents: nonNegativeCentsSchema,
});

export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;

/**
 * 資產走勢的查詢參數。
 *
 * 對應 `GET /portfolio/snapshots?days=30`
 *
 * 上限 365 天是刻意的：一年的資料點畫在手機螢幕上已經遠超過像素密度，
 * 再多只是浪費頻寬。真的需要更長區間時，該做的是**降採樣**
 * （例如改成每週一點），而不是把上限調高。
 */
export const snapshotQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export type SnapshotQuery = z.infer<typeof snapshotQuerySchema>;
