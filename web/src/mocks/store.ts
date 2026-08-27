/**
 * web/src/mocks/store.ts — 瀏覽器裡的假後端狀態
 *
 * 這個檔案是什麼：
 *   一份活在記憶體裡的資料庫。GitHub Pages 上沒有後端，
 *   所有 API 由 MSW 攔截並從這裡回答。
 *
 * 在架構的哪一層：
 *   完全在正式程式碼之外。`web/src/mocks` 底下的東西**只有兩種情況
 *   會被載入**：跑測試時，以及 `VITE_MOCK_API=1` 的靜態展示版。
 *   一般開發與 Docker 版都不會碰到它。
 *
 * ── 為什麼線上展示版用 MSW，而不是把後端也部署上去 ★ ─────────────
 *
 *   這個專案需要 PostgreSQL ＋ Redis ＋ 兩個 Node 服務。免費方案的現實：
 *
 *     · Render 的免費 PostgreSQL **30 天就過期**，再 14 天寬限後刪庫
 *     · 免費 Web Service 閒置 15 分鐘後休眠，冷啟動要數十秒
 *     · market-feed 是背景常駐程序，免費方案不提供 Background Worker
 *
 *   而作品集最常見的死法，正是「六個月後面試官點進去，畫面全白」。
 *   30 天比六個月還糟。
 *
 *   所以決策是**把兩種展示分開**：
 *
 *     本機 `docker compose up`   完整全端 —— 真的 PostgreSQL 行鎖、
 *                                真的 Redis pub/sub、真的 WebSocket
 *     GitHub Pages（靜態）       前端 UI 展示 —— 資料由 MSW 提供
 *
 *   靜態託管沒有伺服器，也就沒有到期問題。
 *
 * ── 為什麼這件事「本身」就是一個架構證明 ★ ────────────────────────
 *
 *   前端能夠原封不動地跑在假後端上，證明了它**沒有跟後端耦合死**：
 *   元件不直接呼叫 fetch（一律經由 feature 的 api 層），
 *   而 api 層只認得 HTTP 契約。抽掉後端，換一個講同樣契約的東西，
 *   整個前端一行都不用改。
 *
 *   而且假資料是用 `@digital-wealth/shared/simulation` 產生的 ——
 *   跟真實後端 seed 用的是**同一份規則、同一顆種子**。
 *   線上 demo 的數字跟本機跑出來的完全一致，不是另外編的一套。
 */

import {
  DEFAULT_DEMO_STATE,
  cents,
  type AccountScenarioValue,
  type Cents,
  type DemoState,
  type FaultKindValue,
  type Instrument,
  type Order,
  type Position,
  type Transaction,
} from '@digital-wealth/shared';
import {
  DEFAULT_LOT_SIZE,
  INSTRUMENT_SEEDS,
  buildSeedData,
  type SeedData,
} from '@digital-wealth/shared/simulation';

/** demo 帳號。與後端 seed.ts 的值一致。 */
export const MOCK_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'demo@digital-wealth.local',
  displayName: '示範帳戶',
};

export const MOCK_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';
export const MOCK_ACCOUNT_NO = '1234-5678';

interface MockState {
  scenario: AccountScenarioValue;
  seed: number;
  faults: Set<FaultKindValue>;
  loggedIn: boolean;

  cashBalanceCents: Cents;
  instruments: Instrument[];
  positions: Position[];
  transactions: Transaction[];
  snapshots: SeedData['snapshots'];
  orders: Map<string, Order>;
  /** 已使用過的冪等鍵。真後端靠 Redis ＋ DB UNIQUE，這裡用一個 Set */
  idempotencyKeys: Set<string>;
  /** 每檔標的的即時價格。由 walker 驅動 */
  prices: Map<string, Cents>;
}

/**
 * 把種子資料攤平成「像資料庫查詢結果」的形狀。
 *
 * 真後端做這件事的是 SQL（JOIN instruments、算 cost_basis）。
 * 這裡在記憶體裡做同樣的事 —— 重點是**輸出的形狀必須完全相同**，
 * 因為前端讀的是同一份 zod schema。
 */
function materialise(scenario: AccountScenarioValue, seed: number): Omit<
  MockState,
  'scenario' | 'seed' | 'faults' | 'loggedIn' | 'orders' | 'idempotencyKeys' | 'prices'
> {
  const data = buildSeedData(scenario, seed);

  const instruments: Instrument[] = INSTRUMENT_SEEDS.flatMap((seedInstrument, index) => {
    const prevClose = data.closingPrices.get(seedInstrument.symbol);
    if (prevClose === undefined) return [];

    return [
      {
        // id 由索引決定而不是隨機 —— 同一顆種子重整後 id 也一樣，
        // 這樣 React 的 key 才不會每次重建都變。
        id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        symbol: seedInstrument.symbol,
        name: seedInstrument.name,
        market: seedInstrument.market,
        lotSize: DEFAULT_LOT_SIZE,
        prevCloseCents: prevClose,
        isActive: true,
      },
    ];
  });

  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  const positions: Position[] = data.positions.flatMap((p, index) => {
    const instrument = bySymbol.get(p.symbol);
    if (!instrument) return [];

    return [
      {
        id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        instrument,
        quantity: p.quantity,
        avgCostCents: p.avgCostCents,
        // 成本基礎在真後端是 SQL 算的（quantity * avg_cost_cents）
        costBasisCents: cents(p.quantity * p.avgCostCents),
      },
    ];
  });

  // 明細由新到舊 —— 與 cursor 分頁的排序一致。
  const transactions: Transaction[] = data.transactions
    .map((tx, index) => ({
      id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      type: tx.type,
      instrument: tx.symbol === null ? null : (bySymbol.get(tx.symbol) ?? null),
      quantity: tx.quantity,
      priceCents: tx.priceCents,
      amountCents: tx.amountCents,
      balanceAfterCents: tx.balanceAfterCents,
      description: tx.description,
      occurredAt: tx.occurredAt.toISOString(),
    }))
    .reverse();

  return {
    cashBalanceCents: data.cashBalanceCents,
    instruments,
    positions,
    transactions,
    snapshots: data.snapshots,
  };
}

function createState(scenario: AccountScenarioValue, seed: number): MockState {
  const materialised = materialise(scenario, seed);

  return {
    scenario,
    seed,
    faults: new Set(),
    // 靜態展示版仍然走完整的登入流程 —— 那是要展示的東西之一。
    loggedIn: false,
    ...materialised,
    orders: new Map(),
    idempotencyKeys: new Set(),
    prices: new Map(materialised.instruments.map((i) => [i.symbol, i.prevCloseCents])),
  };
}

/** 全域唯一的假資料庫。 */
export const mockDb = {
  state: createState(DEFAULT_DEMO_STATE.scenario, DEFAULT_DEMO_STATE.seed),

  /** 切換情境＝重建整份資料（對應真後端的 TRUNCATE ＋ 重新 seed）。 */
  reseed(scenario: AccountScenarioValue, seed?: number): DemoState {
    const wasLoggedIn = this.state.loggedIn;
    const nextSeed = seed ?? this.state.seed;
    const faults = this.state.faults;

    this.state = createState(scenario, nextSeed);
    // 登入狀態與故障設定要跨越重建保留 —— 真後端也是這樣
    // （JWT 用固定 UUID、故障存在記憶體，都不受 reseed 影響）。
    this.state.loggedIn = wasLoggedIn;
    this.state.faults = faults;

    return this.demoState();
  },

  demoState(): DemoState {
    return {
      scenario: this.state.scenario,
      seed: this.state.seed,
      faults: [...this.state.faults],
    };
  },

  hasFault(kind: FaultKindValue): boolean {
    return this.state.faults.has(kind);
  },
};
