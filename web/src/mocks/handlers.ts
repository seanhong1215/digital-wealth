/**
 * web/src/mocks/handlers.ts — 假後端的 HTTP 契約實作
 *
 * 這個檔案是什麼：
 *   把後端每一個端點在瀏覽器裡重新實作一次。**回應的形狀必須
 *   逐欄位對齊真後端** —— 前端讀的是同一份 zod schema，
 *   少一個欄位就會在執行期爆掉。
 *
 * 在架構的哪一層：正式程式碼之外（見 store.ts 的說明）。
 *
 * ── 這裡刻意「重新實作」而不是「簡化」★ ──────────────────────────
 *
 *   最省事的做法是每個端點回一份寫死的 JSON。但那樣的 demo
 *   一按下單就穿幫 —— 餘額不會變、明細不會多一筆。
 *
 *   所以下單在這裡是真的走完整流程：檢查餘額、算費用（用**同一個**
 *   `calculateTradeCost`）、扣款、更新持倉的加權平均、寫三列流水。
 *   冪等鍵也真的擋重複。
 *
 *   唯一演不出來的是**並行競態** —— 瀏覽器的 JavaScript 是單執行緒，
 *   根本不可能有兩個請求同時讀到舊餘額。而那正是整個專案技術密度
 *   最高的部分（`SELECT … FOR UPDATE`）。
 *
 *   這就是為什麼線上版只是「前端 UI 展示」，全端能力仍然要
 *   `docker compose up` 才看得到。README 有把這件事寫清楚。
 */

import { HttpResponse, delay, http, ws } from 'msw';

import { step, type WalkerState } from '@digital-wealth/shared/simulation';
import {
  QUOTES_WS_PATH,
  add,
  calculateTradeCost,
  cents,
  isInsufficient,
  isValidTick,
  isWithinPriceLimits,
  priceLimits,
  subtract,
  tickSize,
  type Cents,
  type ErrorCode,
  type Quote,
  type Transaction,
} from '@digital-wealth/shared';

import { MOCK_ACCOUNT_ID, MOCK_ACCOUNT_NO, MOCK_USER, mockDb } from './store';

const BASE = '*/api/v1';

/** 產生與後端 Exception Filter 完全相同的錯誤格式。 */
function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return HttpResponse.json(
    { error: { code, message, details, traceId: crypto.randomUUID() } },
    { status },
  );
}

/**
 * 故障注入。與後端 middleware 對應，順序也一樣。
 *
 * 回傳 `null` 代表沒有故障、可以繼續處理。
 */
async function injectFaults(path: string): Promise<Response | null> {
  if (path.includes('/demo') || path.includes('/health')) return null;

  if (mockDb.hasFault('api-timeout')) {
    // 真後端是把 TCP 連線砍掉。瀏覽器裡做不到，所以用「永遠不回應」
    // 模擬 —— 對前端來說效果相同：請求懸著，走進「狀態未知」的分支。
    await delay('infinite');
    return null;
  }

  if (mockDb.hasFault('api-500')) {
    return errorResponse(500, 'INTERNAL_ERROR', '系統發生未預期的錯誤', { injected: true });
  }

  if (mockDb.hasFault('slow-network')) {
    await delay(3000);
  }

  return null;
}

/** 未登入時的統一回應。 */
function requireLogin(): Response | null {
  return mockDb.state.loggedIn ? null : errorResponse(401, 'AUTH_REQUIRED', '請先登入');
}

// ============================================================================
// 報價模擬
// ============================================================================

/**
 * 瀏覽器裡的 market-feed。
 *
 * 用的是 `@digital-wealth/shared/simulation` 的 `step()` ——
 * 跟真正的 market-feed 服務**同一個函式**。所以線上版的報價
 * 跳動方式、波動幅度、跳動點對齊規則，跟本機跑起來完全一樣。
 */
function createWalkers(): Map<string, WalkerState> {
  return new Map(
    mockDb.state.instruments.map((instrument) => [
      instrument.symbol,
      {
        symbol: instrument.symbol,
        prevCloseCents: instrument.prevCloseCents,
        priceCents: instrument.prevCloseCents,
        rawPriceCents: instrument.prevCloseCents,
        volume: 0,
      },
    ]),
  );
}

// ============================================================================
// Handlers
// ============================================================================

export const handlers = [
  // ── 認證 ──────────────────────────────────────────────────────
  http.post(`${BASE}/auth/login`, async ({ request }) => {
    const fault = await injectFaults('/auth/login');
    if (fault) return fault;

    const body = (await request.json()) as { email?: string; password?: string };

    if (body.email !== MOCK_USER.email || body.password !== 'demo1234') {
      return errorResponse(401, 'AUTH_INVALID_CREDENTIALS', '帳號或密碼錯誤');
    }

    mockDb.state.loggedIn = true;
    return HttpResponse.json(session());
  }),

  http.post(`${BASE}/auth/logout`, () => {
    mockDb.state.loggedIn = false;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${BASE}/auth/me`, async () => {
    const fault = await injectFaults('/auth/me');
    if (fault) return fault;

    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    return HttpResponse.json(session());
  }),

  // ── 帳戶與投組 ────────────────────────────────────────────────
  http.get(`${BASE}/accounts/me`, async () => {
    const fault = await injectFaults('/accounts/me');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    return HttpResponse.json({
      id: MOCK_ACCOUNT_ID,
      accountNo: MOCK_ACCOUNT_NO,
      cashBalanceCents: mockDb.state.cashBalanceCents,
      currency: 'TWD',
    });
  }),

  http.get(`${BASE}/portfolio/summary`, async () => {
    const fault = await injectFaults('/portfolio/summary');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    const { positions, cashBalanceCents, snapshots } = mockDb.state;

    const totalCostBasisCents = positions.reduce((sum, p) => sum + p.costBasisCents, 0);
    // 以昨收計算 —— 與後端一致（後端沒有即時報價，市值由前端算）
    const marketValueCents = positions.reduce(
      (sum, p) => sum + p.instrument.prevCloseCents * p.quantity,
      0,
    );

    // 今日損益 = 最後一天快照 − 前一天快照，與後端的 SQL 同義
    const last = snapshots.at(-1);
    const previous = snapshots.at(-2);
    const todayPnlCents =
      last && previous ? last.totalValueCents - previous.totalValueCents : 0;

    return HttpResponse.json({
      cashCents: cashBalanceCents,
      marketValueCents,
      totalValueCents: cashBalanceCents + marketValueCents,
      totalCostBasisCents,
      realizedPnlCents: 0,
      todayPnlCents,
    });
  }),

  http.get(`${BASE}/portfolio/snapshots`, async ({ request }) => {
    const fault = await injectFaults('/portfolio/snapshots');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    const days = Number(new URL(request.url).searchParams.get('days') ?? 30);

    return HttpResponse.json(
      mockDb.state.snapshots.slice(-days).map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        cashCents: s.cashCents,
        marketValueCents: s.marketValueCents,
        totalValueCents: s.totalValueCents,
      })),
    );
  }),

  http.get(`${BASE}/positions`, async () => {
    const fault = await injectFaults('/positions');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    return HttpResponse.json(mockDb.state.positions);
  }),

  // ── 標的 ──────────────────────────────────────────────────────
  http.get(`${BASE}/instruments/:symbol`, async ({ params }) => {
    const fault = await injectFaults('/instruments');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    const found = mockDb.state.instruments.find((i) => i.symbol === params.symbol);
    return found
      ? HttpResponse.json(found)
      : errorResponse(404, 'NOT_FOUND', '找不到指定的標的');
  }),

  http.get(`${BASE}/instruments`, async ({ request }) => {
    const fault = await injectFaults('/instruments');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 20);

    const matched = mockDb.state.instruments.filter(
      (i) => q === '' || i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q),
    );

    return HttpResponse.json(matched.slice(0, limit));
  }),

  // ── 交易明細（cursor 分頁）─────────────────────────────────────
  http.get(`${BASE}/transactions`, async ({ request }) => {
    const fault = await injectFaults('/transactions');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? 30);
    const typeParam = url.searchParams.get('type');
    const cursor = url.searchParams.get('cursor');

    let items = mockDb.state.transactions;

    if (typeParam) {
      const types = new Set(typeParam.split(','));
      items = items.filter((tx) => types.has(tx.type));
    }

    // cursor 在後端是 base64(occurredAt,id) 的不透明字串。這裡沿用
    // 同樣的編碼 —— 前端不解析它，所以只要「送回來能定位」就夠了。
    const offset = cursor ? Number(atob(cursor)) : 0;
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;

    return HttpResponse.json({
      items: page,
      nextCursor: nextOffset < items.length ? btoa(String(nextOffset)) : null,
    });
  }),

  // ── 下單 ──────────────────────────────────────────────────────
  http.post(`${BASE}/orders/preview`, async ({ request }) => {
    const fault = await injectFaults('/orders/preview');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    const draft = (await request.json()) as {
      symbol: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      limitPriceCents: number;
    };

    const invalid = validatePrice(draft.symbol, cents(draft.limitPriceCents));
    if (invalid) return invalid;

    const cost = calculateTradeCost(cents(draft.limitPriceCents), draft.quantity, draft.side);

    return HttpResponse.json({
      grossCents: cost.gross,
      feeCents: cost.fee,
      taxCents: cost.tax,
      netCents: cost.net,
    });
  }),

  http.post(`${BASE}/orders`, async ({ request }) => {
    const fault = await injectFaults('/orders');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    if (mockDb.hasFault('order-rejected')) {
      return errorResponse(422, 'ORDER_REJECTED', '委託遭拒絕', { injected: true });
    }

    const body = (await request.json()) as {
      idempotencyKey: string;
      symbol: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      limitPriceCents: number;
    };

    // 冪等：真後端是 Redis SET NX ＋ DB UNIQUE，這裡是一個 Set。
    if (mockDb.state.idempotencyKeys.has(body.idempotencyKey)) {
      return errorResponse(409, 'DUPLICATE_REQUEST', '這筆委託已經送出過了', {
        idempotencyKey: body.idempotencyKey,
      });
    }

    const instrument = mockDb.state.instruments.find((i) => i.symbol === body.symbol);
    if (!instrument) return errorResponse(404, 'NOT_FOUND', '找不到指定的標的');

    const priceCents = cents(body.limitPriceCents);
    const invalid = validatePrice(body.symbol, priceCents);
    if (invalid) return invalid;

    const cost = calculateTradeCost(priceCents, body.quantity, body.side);
    const position = mockDb.state.positions.find((p) => p.instrument.symbol === body.symbol);

    if (body.side === 'SELL' && (position?.quantity ?? 0) < body.quantity) {
      return errorResponse(422, 'INSUFFICIENT_POSITION', '可賣出的股數不足', {
        requiredQuantity: body.quantity,
        availableQuantity: position?.quantity ?? 0,
      });
    }

    if (body.side === 'BUY' && isInsufficient(mockDb.state.cashBalanceCents, cost.net)) {
      return errorResponse(422, 'INSUFFICIENT_FUNDS', '可用餘額不足', {
        requiredCents: cost.net,
        availableCents: mockDb.state.cashBalanceCents,
        shortfallCents: subtract(cost.net, mockDb.state.cashBalanceCents),
      });
    }

    mockDb.state.idempotencyKeys.add(body.idempotencyKey);

    // ── 以下是真後端交易裡那 11 個步驟的記憶體版 ──────────────────
    const openingBalance = mockDb.state.cashBalanceCents;
    mockDb.state.cashBalanceCents =
      body.side === 'BUY' ? subtract(openingBalance, cost.net) : add(openingBalance, cost.net);

    applyPositionChange(body.symbol, body.side, body.quantity, priceCents);
    writeLedger(body.side, instrument.name, body.symbol, body.quantity, priceCents, cost, openingBalance);

    const orderId = crypto.randomUUID();
    const executedAt = new Date().toISOString();
    const order = {
      id: orderId,
      instrument,
      side: body.side,
      orderType: 'LIMIT' as const,
      quantity: body.quantity,
      limitPriceCents: priceCents,
      status: 'FILLED' as const,
      rejectReason: null,
      createdAt: executedAt,
    };
    mockDb.state.orders.set(orderId, order);

    return HttpResponse.json(
      {
        order,
        execution: {
          id: crypto.randomUUID(),
          filledQuantity: body.quantity,
          filledPriceCents: priceCents,
          feeCents: cost.fee,
          taxCents: cost.tax,
          executedAt,
        },
        cashBalanceCents: mockDb.state.cashBalanceCents,
      },
      { status: 201 },
    );
  }),

  http.get(`${BASE}/orders/:id`, async ({ params }) => {
    const fault = await injectFaults('/orders');
    if (fault) return fault;
    const unauthorised = requireLogin();
    if (unauthorised) return unauthorised;

    const order = mockDb.state.orders.get(String(params.id));
    if (!order) return errorResponse(404, 'NOT_FOUND', '找不到指定的委託');

    const cost = calculateTradeCost(order.limitPriceCents, order.quantity, order.side);

    return HttpResponse.json({
      order,
      executions: [
        {
          id: `${order.id}-exec`,
          filledQuantity: order.quantity,
          filledPriceCents: order.limitPriceCents,
          feeCents: cost.fee,
          taxCents: cost.tax,
          executedAt: order.createdAt,
        },
      ],
    });
  }),

  // ── Demo 控制台 ───────────────────────────────────────────────
  http.get(`${BASE}/demo/state`, () => HttpResponse.json(mockDb.demoState())),

  http.post(`${BASE}/demo/scenario`, async ({ request }) => {
    const body = (await request.json()) as { scenario: never; seed?: number };
    return HttpResponse.json(mockDb.reseed(body.scenario, body.seed));
  }),

  http.post(`${BASE}/demo/faults`, async ({ request }) => {
    const body = (await request.json()) as { faults: never[] };
    mockDb.state.faults = new Set(body.faults);
    return HttpResponse.json(mockDb.demoState());
  }),

  http.post(`${BASE}/demo/reset`, () => {
    mockDb.state.faults.clear();
    return HttpResponse.json(mockDb.reseed('active', 42));
  }),

  // ── 即時報價（WebSocket）★ ────────────────────────────────────
  //
  //   MSW 2.x 可以攔截 WebSocket。這讓靜態版連即時報價都能演 ——
  //   而且用的是跟 market-feed 完全相同的 `step()` 函式。
  quotesLink(),
];

// ============================================================================
// WebSocket
// ============================================================================

function quotesLink() {
  const link = ws.link(`*${QUOTES_WS_PATH}`);

  return link.addEventListener('connection', ({ client }) => {
    if (mockDb.hasFault('quote-disconnect')) {
      client.send(
        JSON.stringify({ type: 'error', code: 'SERVICE_UNAVAILABLE', message: '報價服務暫時無法使用' }),
      );
      client.close(4001, 'SERVICE_UNAVAILABLE');
      return;
    }

    const walkers = createWalkers();
    const subscribed = new Set<string>();

    client.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        symbols?: string[];
      };

      if (message.type === 'ping') {
        client.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (message.type === 'subscribe') {
        for (const s of message.symbols ?? []) subscribed.add(s);
      }
      if (message.type === 'unsubscribe') {
        for (const s of message.symbols ?? []) subscribed.delete(s);
      }
    });

    // 與 market-feed 相同的節奏：每 800ms 更新一批。
    const timer = setInterval(() => {
      if (mockDb.hasFault('quote-disconnect')) {
        client.close(4001, 'SERVICE_UNAVAILABLE');
        clearInterval(timer);
        return;
      }

      for (const symbol of subscribed) {
        const walker = walkers.get(symbol);
        if (!walker) continue;

        step(walker);
        mockDb.state.prices.set(symbol, walker.priceCents);

        const quote: Quote = {
          symbol,
          priceCents: walker.priceCents,
          prevCloseCents: walker.prevCloseCents,
          volume: walker.volume,
          at: new Date().toISOString(),
        };
        client.send(JSON.stringify({ type: 'quote', data: quote }));
      }
    }, 800);

    client.addEventListener('close', () => clearInterval(timer));
  });
}

// ============================================================================
// 小工具
// ============================================================================

function session() {
  return {
    user: MOCK_USER,
    account: {
      id: MOCK_ACCOUNT_ID,
      accountNo: MOCK_ACCOUNT_NO,
      cashBalanceCents: mockDb.state.cashBalanceCents,
      currency: 'TWD',
    },
  };
}

/** 價格檢查。與後端 OrdersService.assertPriceIsLegal 同一套規則。 */
function validatePrice(symbol: string, priceCents: Cents): Response | null {
  const instrument = mockDb.state.instruments.find((i) => i.symbol === symbol);
  if (!instrument) return errorResponse(404, 'NOT_FOUND', '找不到指定的標的');

  if (!isValidTick(priceCents)) {
    return errorResponse(422, 'PRICE_OUT_OF_RANGE', '委託價格不是合法的升降單位', {
      reason: 'INVALID_TICK',
      priceCents,
      tickCents: tickSize(priceCents),
    });
  }

  if (!isWithinPriceLimits(priceCents, instrument.prevCloseCents)) {
    const limits = priceLimits(instrument.prevCloseCents);
    return errorResponse(422, 'PRICE_OUT_OF_RANGE', '委託價格超出今日漲跌停範圍', {
      reason: 'DAILY_LIMIT',
      priceCents,
      upperLimitCents: limits.upper,
      lowerLimitCents: limits.lower,
    });
  }

  return null;
}

/** 更新持倉。買進重算加權平均、賣出只減股數（與後端相同）。 */
function applyPositionChange(
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  priceCents: Cents,
): void {
  const index = mockDb.state.positions.findIndex((p) => p.instrument.symbol === symbol);
  const existing = index >= 0 ? mockDb.state.positions[index] : undefined;

  if (side === 'BUY') {
    const instrument = mockDb.state.instruments.find((i) => i.symbol === symbol)!;
    const previousQty = existing?.quantity ?? 0;
    const previousCost = (existing?.avgCostCents ?? 0) * previousQty;
    const nextQty = previousQty + quantity;
    const nextAvg = cents(Math.round((previousCost + priceCents * quantity) / nextQty));

    const next = {
      id: existing?.id ?? `20000000-0000-4000-8000-${symbol.padStart(12, '0')}`,
      instrument,
      quantity: nextQty,
      avgCostCents: nextAvg,
      costBasisCents: cents(nextQty * nextAvg),
    };

    if (index >= 0) mockDb.state.positions[index] = next;
    else mockDb.state.positions.push(next);
    return;
  }

  if (!existing) return;
  const remaining = existing.quantity - quantity;

  // 股數歸零就從列表移除 —— 與後端 reducePosition 的 DELETE 一致。
  if (remaining === 0) {
    mockDb.state.positions.splice(index, 1);
    return;
  }

  mockDb.state.positions[index] = {
    ...existing,
    quantity: remaining,
    costBasisCents: cents(remaining * existing.avgCostCents),
  };
}

/** 寫流水。成交、手續費、稅各一列，每列相隔 1 秒（與後端一致）。 */
function writeLedger(
  side: 'BUY' | 'SELL',
  instrumentName: string,
  symbol: string,
  quantity: number,
  priceCents: Cents,
  cost: { gross: Cents; fee: Cents; tax: Cents },
  openingBalance: Cents,
): void {
  const instrument = mockDb.state.instruments.find((i) => i.symbol === symbol) ?? null;
  const base = Date.now();
  const rows: Transaction[] = [];

  let running =
    side === 'BUY' ? subtract(openingBalance, cost.gross) : add(openingBalance, cost.gross);

  rows.push({
    id: crypto.randomUUID(),
    type: side,
    instrument,
    quantity,
    priceCents,
    amountCents: side === 'BUY' ? cents(-cost.gross) : cost.gross,
    balanceAfterCents: running,
    description: `${side === 'BUY' ? '買進' : '賣出'} ${instrumentName} ${quantity.toLocaleString('en-US')} 股`,
    occurredAt: new Date(base).toISOString(),
  });

  running = subtract(running, cost.fee);
  rows.push({
    id: crypto.randomUUID(),
    type: 'FEE',
    instrument,
    quantity: null,
    priceCents: null,
    amountCents: cents(-cost.fee),
    balanceAfterCents: running,
    description: `手續費 — ${instrumentName}`,
    occurredAt: new Date(base + 1000).toISOString(),
  });

  if (cost.tax > 0) {
    running = subtract(running, cost.tax);
    rows.push({
      id: crypto.randomUUID(),
      type: 'TAX',
      instrument,
      quantity: null,
      priceCents: null,
      amountCents: cents(-cost.tax),
      balanceAfterCents: running,
      description: `證券交易稅 — ${instrumentName}`,
      occurredAt: new Date(base + 2000).toISOString(),
    });
  }

  // 明細是新到舊，所以新的插在最前面（且組內順序要反過來）。
  mockDb.state.transactions.unshift(...rows.reverse());
}
