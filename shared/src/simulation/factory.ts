/**
 * api/src/database/seeds/factory.ts — 種子資料產生器
 *
 * 這個檔案是什麼：
 *   依「情境 + 種子」產生一整套自洽的假資料：價格走勢、交易明細、
 *   當前持倉、每日資產快照。
 *
 * 為什麼這個檔案是 P0 最重要的檔案之一：
 *   **沒有真實市場資料的金融 demo，九成垮在假資料上。**
 *
 *   垮的方式通常是這樣：持倉頁顯示「台積電 均價 1050 元」，
 *   點進明細，看到歷史買入是 1200、1180、1210 ——
 *   均價怎麼可能是 1050？整個專案的可信度當場歸零。
 *
 *   所以這裡的核心設計原則是：**先產生歷史，再從歷史推導現況。**
 *
 *     價格序列  →  交易事件  →  持倉（由交易推導）
 *                            →  快照（由持倉 × 當日價格推導）
 *
 *   持倉的平均成本**真的是**歷史買入的加權平均，因為它就是那樣算出來的，
 *   而不是隨便給一個數字。快照的總資產也真的等於當天的現金加持股市值。
 *   怎麼心算都對得起來。
 *
 * ── 兩條硬性規則 ────────────────────────────────────────────────────
 *
 *   1. **一律使用相對時間**（`now - 30d`），絕不寫死日期。
 *      否則半年後打開，明細停在去年，可信度歸零。
 *
 *   2. **固定亂數種子**。同一個 seed + 同一個 scenario，
 *      每次產生的資料必須完全一致（見 rng.ts 的說明）。
 *
 * 在架構的哪一層：
 *   seed 工具，不屬於執行期的應用程式。它依賴 shared 的金額與台股規則 ——
 *   這點很重要：**seed 用的費用計算與真實下單用的是同一份程式碼**，
 *   所以 seed 產生的歷史手續費，跟使用者現在下單算出來的手續費，
 *   規則完全一致。
 */

import {
  type Cents,
  add,
  alignToTick,
  calculateTradeCost,
  cents,
  fromMajorUnits,
  multiply,
  subtract,
  weightedAverageCost,
} from '../index.js';

import { INSTRUMENT_SEEDS, type InstrumentSeed } from './instruments.js';
import { chance, createRng, pick, randomInt, randomNormal, type Rng } from './rng.js';

// ============================================================================
// 對外型別
// ============================================================================

/**
 * 帳戶情境。決定產生什麼形狀的資料。
 *
 * 這個列舉同時是 Demo 控制台的切換選項（Phase 4）——
 * 使用者可以自己切換情境，看到空狀態、正常、餘額不足、大量資料
 * 四種畫面，不需要你在旁邊解說。
 */
export type AccountScenario = 'new-user' | 'active' | 'insufficient' | 'heavy-history';

/** 帳務流水的一列。對應 `transactions` 資料表。 */
export interface SeedTransaction {
  readonly type: 'BUY' | 'SELL' | 'FEE' | 'TAX' | 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL';
  /** 標的代號。入出金類為 null */
  readonly symbol: string | null;
  /** 股數。非交易類為 null（null 代表「不適用」，不是「零」） */
  readonly quantity: number | null;
  /** 單價（分／股）。非交易類為 null */
  readonly priceCents: Cents | null;
  /** 對餘額的影響（分）。正為入帳，負為出帳 */
  readonly amountCents: Cents;
  /** 異動後餘額（分） */
  readonly balanceAfterCents: Cents;
  readonly description: string;
  readonly occurredAt: Date;
}

/** 當前持倉的一列。對應 `positions` 資料表。 */
export interface SeedPosition {
  readonly symbol: string;
  readonly quantity: number;
  /** 平均成本（分／股），由歷史買入加權平均而來 */
  readonly avgCostCents: Cents;
}

/** 每日資產快照的一列。對應 `portfolio_snapshots` 資料表。 */
export interface SeedSnapshot {
  /** 快照日期，UTC 午夜（資料庫欄位是 DATE，只取日期部分） */
  readonly date: Date;
  readonly cashCents: Cents;
  readonly marketValueCents: Cents;
  readonly totalValueCents: Cents;
}

/** 一次產生的完整資料集。 */
export interface SeedData {
  /** 帳戶最終現金餘額（分） */
  readonly cashBalanceCents: Cents;
  readonly transactions: readonly SeedTransaction[];
  readonly positions: readonly SeedPosition[];
  readonly snapshots: readonly SeedSnapshot[];
  /**
   * 各標的的最後收盤價（分／股）。
   *
   * 寫進 `instruments.prev_close_cents`，作為漲跌與漲跌停的計算基準。
   * 它必須來自價格序列的最後一天 —— 如果隨便給一個數字，
   * 快照裡的市值就會跟「持股 × 昨收」對不上。
   */
  readonly closingPrices: ReadonlyMap<string, Cents>;
}

// ============================================================================
// 情境設定
// ============================================================================

interface ScenarioConfig {
  /** 初始入金（元） */
  readonly initialDepositInUnits: number;
  /** 從標的池挑幾檔來交易 */
  readonly instrumentCount: number;
  /** 產生多少個「日曆天」的歷史（實際交易日會扣掉週末） */
  readonly historyDays: number;
  /** 目標明細筆數。達到後就停止產生新交易 */
  readonly targetTransactionCount: number;
  /**
   * 最終現金餘額（元）。設定時會在最後補一筆轉出，把餘額壓到這個數字。
   *
   * 只有 `insufficient` 情境用得到 —— 那個情境的目的是測「下單餘額不足」，
   * 所以最終餘額必須是一個確定的小數字，不能靠模擬碰運氣。
   */
  readonly finalCashInUnits?: number;
}

const SCENARIOS: Record<AccountScenario, ScenarioConfig> = {
  /** 新使用者：有錢，但什麼都還沒做。用來測所有的空狀態畫面 */
  'new-user': {
    initialDepositInUnits: 1_000_000,
    instrumentCount: 0,
    historyDays: 0,
    targetTransactionCount: 0,
  },

  /** 標準情境。8–15 檔持倉、約 3,000 筆明細、混合損益 */
  active: {
    initialDepositInUnits: 3_000_000,
    instrumentCount: 12,
    historyDays: 365,
    targetTransactionCount: 3_000,
  },

  /** 餘額不足：有持倉有歷史，但現金只剩 500 元。用來測下單被拒 */
  insufficient: {
    initialDepositInUnits: 1_500_000,
    instrumentCount: 6,
    historyDays: 180,
    targetTransactionCount: 400,
    finalCashInUnits: 500,
  },

  /** 壓測用：8,000 筆明細，驗證虛擬滾動在真實資料量下的表現 */
  'heavy-history': {
    initialDepositInUnits: 5_000_000,
    instrumentCount: 18,
    historyDays: 730,
    targetTransactionCount: 8_000,
  },
};

// ============================================================================
// 時間
// ============================================================================

/**
 * 台股交易時段：09:00–13:30（台北時間）。
 *
 * 這裡用 UTC 來表示，是為了讓 seed 的結果**不受執行機器的時區影響**。
 * 台北是 UTC+8，所以 09:00 台北 = 01:00 UTC。
 *
 * 如果直接用 `new Date(y, m, d, 9, 0)`，在時區設為 UTC 的 Docker 容器裡
 * 產生的會是 09:00 UTC = 17:00 台北 —— 明細會顯示「下午五點成交」，
 * 那是台股不可能發生的時間。
 */
const TRADING_START_UTC_HOUR = 1;
/** 交易時段長度（分鐘）：09:00 到 13:30 共 270 分鐘 */
const TRADING_WINDOW_MINUTES = 270;

/**
 * 產生最近 N 個日曆天內的「交易日」清單，由舊到新。
 *
 * 交易日 = 週一到週五。**不處理國定假日** ——
 * 那需要一份逐年更新的行事曆，對 demo 的可信度提升有限，
 * 但維護成本會延續到未來每一年。這是刻意的取捨，值得寫進 README。
 *
 * @param historyDays 往回推幾個日曆天
 * @param today 今天（UTC 午夜）。由呼叫端傳入而非在函式內取 `new Date()`，
 *              是為了讓這個函式可測試
 * @returns 交易日陣列，由舊到新。每個元素是該日的 UTC 午夜
 */
function buildTradingDays(historyDays: number, today: Date): Date[] {
  const days: Date[] = [];

  for (let offset = historyDays; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
    const weekday = date.getUTCDay(); // 0 = 週日，6 = 週六
    if (weekday !== 0 && weekday !== 6) {
      days.push(date);
    }
  }

  return days;
}

/**
 * 在某個交易日內，依序號分配一個成交時間。
 *
 * 同一天的事件會平均散布在 09:00–13:30 之間，且**嚴格遞增**。
 *
 * 為什麼要嚴格遞增：`transactions.balance_after_cents`（結餘）的正確性
 * 依賴事件順序。如果兩筆的 `occurred_at` 相同，按時間排序時順序不確定，
 * 讀出來的結餘序列就可能是亂的 —— 那正是這個欄位要避免的問題。
 *
 * @param day 交易日（UTC 午夜）
 * @param index 這是當天第幾個事件（從 0 起算）
 * @param total 當天總共有幾個事件
 * @returns 分配到的時間點
 */
function assignTimeWithinDay(day: Date, index: number, total: number): Date {
  // total 為 1 時避免除以零；此時放在時段開頭。
  const ratio = total <= 1 ? 0 : index / total;
  const minutesIntoWindow = Math.floor(ratio * TRADING_WINDOW_MINUTES);

  return new Date(
    day.getTime() +
      TRADING_START_UTC_HOUR * 60 * 60 * 1000 +
      minutesIntoWindow * 60 * 1000 +
      // 加上秒數讓時間看起來不會太整齊，但仍由 index 決定而非亂數，
      // 以維持嚴格遞增。
      (index % 60) * 1000,
  );
}

// ============================================================================
// 價格序列
// ============================================================================

/**
 * 為一檔標的產生每日收盤價序列。
 *
 * ── 用的是「幾何布朗運動」的離散近似 ──────────────────────────────
 *
 * 這是金融領域模擬股價最常見的模型。核心想法是：
 * **股價的「報酬率」呈常態分布，而不是股價本身。**
 *
 *   下一天價格 = 今天價格 × exp(隨機報酬率)
 *
 * 為什麼是乘法而不是加法：股價 20 元的股票不會單日漲 50 元，
 * 但股價 2000 元的可以。用乘法（百分比變動）才符合實際。
 * 而 `exp()` 保證了價格**永遠不會變成負數** —— 加法模型會。
 *
 *   dailyVolatility  年化波動度換算成日波動度。除以 √252 是因為
 *                    一年約有 252 個交易日，而波動度隨時間的平方根成長
 *   -0.5 × σ²        Itô 修正項。沒有這一項的話，因為 exp() 是凸函數，
 *                    模擬出來的價格長期會系統性地往上飄
 *   drift            微幅正向漂移，讓走勢整體略微向上 ——
 *                    這樣 demo 的損益才會是「有賺有賠但整體小賺」，
 *                    比全部虧損好看，也比全部大賺可信
 *
 * 產生後每個價格都會 `alignToTick` 對齊到合法跳動點，
 * 所以序列裡的每一個價格都是「真的可以掛出去的價格」。
 *
 * @param instrument 標的定義
 * @param dayCount 要產生幾天
 * @param rng 亂數產生器
 * @returns 收盤價序列（分／股），索引對應交易日的順序
 */
function buildPriceSeries(instrument: InstrumentSeed, dayCount: number, rng: Rng): Cents[] {
  const dailyVolatility = instrument.volatility / Math.sqrt(252);
  const drift = 0.00025; // 日均約 +0.025%，年化約 +6%

  const series: Cents[] = [];
  let priceInUnits = instrument.basePriceInUnits;

  for (let day = 0; day < dayCount; day += 1) {
    if (day > 0) {
      const shock = dailyVolatility * randomNormal(rng);
      priceInUnits *= Math.exp(drift - 0.5 * dailyVolatility ** 2 + shock);
    }

    // 防呆：極端情況下價格可能被壓到接近零，
    // 而 tickSize() 對非正數會拋錯。設一個地板讓模擬不會中斷。
    const floored = Math.max(priceInUnits, 1);
    series.push(alignToTick(fromMajorUnits(floored)));
  }

  return series;
}

// ============================================================================
// 主流程
// ============================================================================

/** 模擬過程中追蹤的持倉狀態。 */
interface MutablePosition {
  quantity: number;
  avgCostCents: Cents;
}

/**
 * 產生一整套種子資料。
 *
 * @param scenario 帳戶情境
 * @param seed 亂數種子。同一組 (scenario, seed) 永遠產生完全相同的資料
 * @param today 今天。預設取當下的 UTC 午夜；測試時可傳入固定值
 * @returns 完整且自洽的資料集
 *
 * @example
 *   const data = buildSeedData('active', 42);
 *   // data.positions 的平均成本，真的等於 data.transactions 裡歷史買入的加權平均
 */
export function buildSeedData(
  scenario: AccountScenario,
  seed: number,
  today: Date = startOfUtcDay(new Date()),
): SeedData {
  const config = SCENARIOS[scenario];
  const rng = createRng(seed);

  const days = buildTradingDays(config.historyDays, today);

  // ── 挑選這個情境要用的標的 ────────────────────────────────────────
  // 從標的池的前 N 檔取，而不是隨機挑 —— 這樣不同 seed 產生的資料，
  // 標的組合是一致的，只有交易行為不同。demo 切換 seed 時比較好比較。
  const instruments = INSTRUMENT_SEEDS.slice(0, config.instrumentCount);

  // ── 價格序列 ─────────────────────────────────────────────────────
  const priceSeries = new Map<string, Cents[]>();
  for (const instrument of instruments) {
    priceSeries.set(instrument.symbol, buildPriceSeries(instrument, days.length, rng));
  }

  const closingPrices = new Map<string, Cents>();
  for (const instrument of INSTRUMENT_SEEDS) {
    const series = priceSeries.get(instrument.symbol);
    // 沒參與這個情境的標的仍要有 prev_close（搜尋標的、下單挑新標的時要用），
    // 直接用它的起始價。
    closingPrices.set(
      instrument.symbol,
      series?.at(-1) ?? alignToTick(fromMajorUnits(instrument.basePriceInUnits)),
    );
  }

  // ── new-user：什麼都不做，直接回傳空資料集 ────────────────────────
  if (config.instrumentCount === 0 || days.length === 0) {
    return {
      cashBalanceCents: fromMajorUnits(config.initialDepositInUnits),
      transactions: [],
      positions: [],
      snapshots: [],
      closingPrices,
    };
  }

  // ── 模擬 ─────────────────────────────────────────────────────────
  const transactions: SeedTransaction[] = [];
  const snapshots: SeedSnapshot[] = [];
  const holdings = new Map<string, MutablePosition>();

  let cash = cents(0);

  /**
   * 記一筆流水帳。
   *
   * 這個閉包是整份資料自洽性的關鍵：**餘額只在這裡被改動**。
   * 每筆流水的 `balanceAfterCents` 都是改動後的即時值，
   * 所以「前一筆結餘 + 這筆金額 = 這筆結餘」恆成立。
   */
  const record = (
    entry: Omit<SeedTransaction, 'balanceAfterCents' | 'occurredAt'>,
    occurredAt: Date,
  ): void => {
    cash = add(cash, entry.amountCents);
    transactions.push({ ...entry, balanceAfterCents: cash, occurredAt });
  };

  const initialDeposit = fromMajorUnits(config.initialDepositInUnits);
  const firstDay = days[0]!;

  record(
    {
      type: 'DEPOSIT',
      symbol: null,
      quantity: null,
      priceCents: null,
      amountCents: initialDeposit,
      description: '銀行轉入',
    },
    assignTimeWithinDay(firstDay, 0, 1),
  );

  // 每個交易日平均要產生幾筆交易，才能達到目標明細筆數。
  // 一筆買進產生 2 列（BUY + FEE），一筆賣出產生 3 列（SELL + FEE + TAX），
  // 平均約 2.4 列，所以除以 2.4 回推需要的交易筆數。
  const targetTrades = Math.ceil(config.targetTransactionCount / 2.4);
  const tradesPerDay = Math.max(1, Math.round(targetTrades / days.length));

  for (const [dayIndex, day] of days.entries()) {
    // 第一天只入金，不交易（總得先有錢才能買）。
    if (dayIndex > 0 && transactions.length < config.targetTransactionCount) {
      // 當天交易筆數上下浮動，避免每天都一樣多。
      const todayTradeCount = Math.max(0, tradesPerDay + randomInt(rng, -1, 1));

      // 先估算當天會產生幾個事件，好分配時間。估多了不影響正確性，
      // 只是時間分布會略微前傾。
      const estimatedEvents = todayTradeCount * 3;
      let eventIndex = 0;

      for (let t = 0; t < todayTradeCount; t += 1) {
        if (transactions.length >= config.targetTransactionCount) break;

        const occurredAt = assignTimeWithinDay(day, eventIndex, estimatedEvents);
        const produced = simulateOneTrade({
          rng,
          instruments,
          priceSeries,
          dayIndex,
          holdings,
          cash,
          initialDeposit,
          occurredAt,
          record,
        });
        eventIndex += produced;
      }

      // 股利：每天對每檔持股有極小機率配息。
      // 頻率刻意壓得很低（真實世界一年配一到兩次），
      // 但有它在，明細頁才會出現 DIVIDEND 這個類型。
      for (const [symbol, position] of holdings) {
        if (position.quantity > 0 && chance(rng, 0.002)) {
          const perShareInUnits = 0.5 + rng() * 2.5;
          const amount = multiply(fromMajorUnits(perShareInUnits), position.quantity);
          const name = instruments.find((i) => i.symbol === symbol)?.name ?? symbol;

          record(
            {
              type: 'DIVIDEND',
              symbol,
              quantity: position.quantity,
              priceCents: fromMajorUnits(perShareInUnits),
              amountCents: amount,
              description: `現金股利 — ${name}`,
            },
            assignTimeWithinDay(day, eventIndex, estimatedEvents + 1),
          );
          eventIndex += 1;
        }
      }
    }

    // ── 當日收盤：寫一筆資產快照 ──────────────────────────────────
    // 快照在**每個交易日的最後**產生，所以它反映的是當天所有交易之後的狀態。
    let marketValue = cents(0);
    for (const [symbol, position] of holdings) {
      if (position.quantity <= 0) continue;
      const price = priceSeries.get(symbol)?.[dayIndex];
      if (price === undefined) continue;
      marketValue = add(marketValue, multiply(price, position.quantity));
    }

    snapshots.push({
      date: day,
      cashCents: cash,
      marketValueCents: marketValue,
      totalValueCents: add(cash, marketValue),
    });
  }

  // ── 情境要求特定的最終餘額時，補一筆轉出 ──────────────────────────
  if (config.finalCashInUnits !== undefined) {
    const target = fromMajorUnits(config.finalCashInUnits);
    if (cash > target) {
      const lastDay = days.at(-1)!;
      record(
        {
          type: 'WITHDRAWAL',
          symbol: null,
          quantity: null,
          priceCents: null,
          amountCents: subtract(target, cash), // 負數
          description: '銀行轉出',
        },
        assignTimeWithinDay(lastDay, TRADING_WINDOW_MINUTES - 1, TRADING_WINDOW_MINUTES),
      );

      // 轉出發生在最後一天收盤後，所以最後一筆快照的現金要跟著更新，
      // 否則快照的總資產會跟帳戶餘額對不上。
      const last = snapshots.at(-1);
      if (last) {
        snapshots[snapshots.length - 1] = {
          ...last,
          cashCents: cash,
          totalValueCents: add(cash, last.marketValueCents),
        };
      }
    }
  }

  // ── 收尾：把模擬中的持倉轉成輸出格式 ──────────────────────────────
  const positions: SeedPosition[] = [];
  for (const [symbol, position] of holdings) {
    // 已經全部賣光的標的不留在持倉表裡。
    // 它的歷史仍在 transactions 裡查得到 —— 這正是兩張表的分工。
    if (position.quantity <= 0) continue;
    positions.push({
      symbol,
      quantity: position.quantity,
      avgCostCents: position.avgCostCents,
    });
  }

  return {
    cashBalanceCents: cash,
    transactions,
    positions,
    snapshots,
    closingPrices,
  };
}

/** `simulateOneTrade` 的參數。獨立成介面純粹是因為參數太多，具名比較好讀。 */
interface TradeContext {
  readonly rng: Rng;
  readonly instruments: readonly InstrumentSeed[];
  readonly priceSeries: ReadonlyMap<string, Cents[]>;
  readonly dayIndex: number;
  readonly holdings: Map<string, MutablePosition>;
  readonly cash: Cents;
  readonly initialDeposit: Cents;
  readonly occurredAt: Date;
  readonly record: (
    entry: Omit<SeedTransaction, 'balanceAfterCents' | 'occurredAt'>,
    occurredAt: Date,
  ) => void;
}

/**
 * 模擬一筆交易，並記錄它產生的所有流水帳列。
 *
 * ── 買或賣怎麼決定 ────────────────────────────────────────────────
 *
 * 不是擲硬幣，而是依「現金水位」調整傾向：
 *   - 現金太少 → 傾向賣出（否則很快就什麼都買不起，明細會停止成長）
 *   - 現金太多 → 傾向買進（否則資產一直是現金，持倉頁空空如也）
 *
 * 這個機制讓模擬能長時間持續下去，產出的資產配置也比較像真的
 * —— 不會出現「一年後 95% 都是現金」這種不自然的結果。
 *
 * @returns 這筆交易產生了幾列流水帳（供呼叫端分配時間用）
 */
function simulateOneTrade(ctx: TradeContext): number {
  const { rng, instruments, priceSeries, dayIndex, holdings, cash, initialDeposit } = ctx;

  const heldSymbols = [...holdings.entries()]
    .filter(([, position]) => position.quantity > 0)
    .map(([symbol]) => symbol);

  // 現金佔初始入金的比例，用來決定買賣傾向。
  const cashRatio = cash / initialDeposit;
  const sellProbability = heldSymbols.length === 0 ? 0 : cashRatio < 0.15 ? 0.85 : 0.45;

  const side: 'BUY' | 'SELL' = chance(rng, sellProbability) ? 'SELL' : 'BUY';

  if (side === 'SELL') {
    return simulateSell(ctx, heldSymbols);
  }
  return simulateBuy(ctx, instruments, priceSeries, dayIndex);
}

/**
 * 模擬買進。
 *
 * @returns 產生的流水帳列數（2 列：BUY + FEE），資金不足時為 0
 */
function simulateBuy(
  ctx: TradeContext,
  instruments: readonly InstrumentSeed[],
  priceSeries: ReadonlyMap<string, Cents[]>,
  dayIndex: number,
): number {
  const { rng, holdings, cash, occurredAt, record } = ctx;

  const instrument = pick(rng, instruments);
  const price = priceSeries.get(instrument.symbol)?.[dayIndex];
  if (price === undefined) return 0;

  // 單筆投入現金的 2%–8%。控制在小比例，交易次數才夠多、
  // 且不會一兩筆就把錢花光。
  const budget = Math.floor(cash * (0.02 + rng() * 0.06));
  let quantity = Math.floor(budget / price);

  // 八成的交易買整張（1000 股的倍數），兩成買零股。
  // 保留零股是刻意的 —— 它會觸發「手續費最低 20 元」的規則，
  // 讓那條規則在 demo 的明細裡真的看得到。
  if (quantity >= 1000 && chance(rng, 0.8)) {
    quantity = Math.floor(quantity / 1000) * 1000;
  }

  if (quantity <= 0) return 0;

  const cost = calculateTradeCost(price, quantity, 'BUY');
  // 買不起就放棄這一筆。不做「減量重試」是因為那會讓模擬變複雜，
  // 而放棄的成本只是少一筆交易。
  if (cost.net > cash) return 0;

  record(
    {
      type: 'BUY',
      symbol: instrument.symbol,
      quantity,
      priceCents: price,
      amountCents: cents(-cost.gross),
      description: `買進 ${instrument.name} ${quantity.toLocaleString('en-US')} 股`,
    },
    occurredAt,
  );

  record(
    {
      type: 'FEE',
      symbol: instrument.symbol,
      quantity: null,
      priceCents: null,
      amountCents: cents(-cost.fee),
      description: `手續費 — ${instrument.name}`,
    },
    new Date(occurredAt.getTime() + 1000),
  );

  // ★ 更新持倉：平均成本用 shared 的 weightedAverageCost 計算。
  //   這是「持倉成本真的等於歷史買入加權平均」的實作保證 ——
  //   因為它就是用同一個函式、同一批數字算出來的。
  const existing = holdings.get(instrument.symbol);
  if (existing && existing.quantity > 0) {
    existing.avgCostCents = weightedAverageCost(
      existing.quantity,
      existing.avgCostCents,
      quantity,
      price,
    );
    existing.quantity += quantity;
  } else {
    holdings.set(instrument.symbol, { quantity, avgCostCents: price });
  }

  return 2;
}

/**
 * 模擬賣出。
 *
 * 注意**賣出不改變平均成本** —— 賣掉的部分變成已實現損益，
 * 留下的部分取得成本不變。這是會計上的標準處理，
 * 也是新手最容易寫錯的地方（很多人會在賣出時也去動 avg_cost）。
 *
 * @returns 產生的流水帳列數（3 列：SELL + FEE + TAX），無持股時為 0
 */
function simulateSell(ctx: TradeContext, heldSymbols: readonly string[]): number {
  const { rng, instruments, priceSeries, dayIndex, holdings, occurredAt, record } = ctx;

  if (heldSymbols.length === 0) return 0;

  const symbol = pick(rng, heldSymbols);
  const position = holdings.get(symbol);
  if (!position || position.quantity <= 0) return 0;

  const price = priceSeries.get(symbol)?.[dayIndex];
  if (price === undefined) return 0;

  // 賣出比例：四分之一、一半、或全部出清。
  //
  // 陣列裡「部分賣出」的權重刻意高於「全部出清」（4:1）。
  // 三者等機率的話，跑滿一年之後大部分標的都會在某次被清光，
  // 最終持倉只剩五六檔 —— 規格要求 8–15 檔，而且持倉太少的
  // 總覽頁看起來也很空。這是模擬參數需要配合驗收標準的一個例子。
  const fraction = pick(rng, [0.25, 0.25, 0.5, 0.5, 1]);
  let quantity = Math.floor(position.quantity * fraction);

  // 非全出清時對齊到整張，讓剩餘部位不會變成零碎的怪數字。
  if (fraction < 1 && quantity >= 1000) {
    quantity = Math.floor(quantity / 1000) * 1000;
  }
  if (quantity <= 0) return 0;

  const name = instruments.find((i) => i.symbol === symbol)?.name ?? symbol;
  const cost = calculateTradeCost(price, quantity, 'SELL');

  record(
    {
      type: 'SELL',
      symbol,
      quantity,
      priceCents: price,
      amountCents: cost.gross, // 賣出是入帳，正數
      description: `賣出 ${name} ${quantity.toLocaleString('en-US')} 股`,
    },
    occurredAt,
  );

  record(
    {
      type: 'FEE',
      symbol,
      quantity: null,
      priceCents: null,
      amountCents: cents(-cost.fee),
      description: `手續費 — ${name}`,
    },
    new Date(occurredAt.getTime() + 1000),
  );

  record(
    {
      type: 'TAX',
      symbol,
      quantity: null,
      priceCents: null,
      amountCents: cents(-cost.tax),
      description: `證券交易稅 — ${name}`,
    },
    new Date(occurredAt.getTime() + 2000),
  );

  position.quantity -= quantity;
  // avgCostCents 刻意不動，理由見函式說明。

  return 3;
}

/**
 * 取得某個時間點所在日期的 UTC 午夜。
 *
 * 用於把「現在」正規化成一個乾淨的日期起點，
 * 讓 seed 在同一天的任何時刻執行都得到相同的日期序列。
 */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
