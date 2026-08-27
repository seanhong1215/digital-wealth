/**
 * api/src/modules/orders/orders.repository.ts — 下單的資料存取
 *
 * 這個檔案是什麼：
 *   下單流程會用到的所有 SQL。每一個方法對應交易流程中的一步。
 *
 * 在架構的哪一層：
 *   Repository。這是唯一寫 SQL 的地方 —— Controller 與 Service 都不碰資料庫
 *   （PROJECT.md 的兩條硬性規則之一）。
 *
 * ── 為什麼幾乎每個方法都要收一個 `tx` 參數 ★ ─────────────────────────
 *
 *   其他 repository（例如 instruments）都是直接用 `this.db.query()`，
 *   每次查詢自己開一條連線、自己就是一個交易。
 *
 *   下單不行。下單的 10 個步驟必須是**同一個交易**，全成功或全失敗 ——
 *   扣了款卻沒寫持倉，錢就憑空蒸發了。而 PostgreSQL 的交易是綁在
 *   「連線」上的，所以這 10 步必須跑在同一條連線上。
 *
 *   `TransactionClient` 就是那條連線的把手。誰開交易誰負責傳進來，
 *   Repository 只管在別人給的交易裡下查詢。這讓「交易邊界」這件事
 *   留在 Service（業務層）決定，而不是散落在 SQL 層。
 *
 *   對照 Spring Boot：那邊用 `@Transactional` 註解 + ThreadLocal 隱式傳遞，
 *   這裡是顯式傳參數。顯式比較囉嗦，但看得到交易從哪裡開始、到哪裡結束。
 *
 * 相關文件：docs/02-backend.md → 交易一致性設計
 */

import { Injectable } from '@nestjs/common';

import {
  cents,
  type Cents,
  type Execution,
  type Instrument,
  type Order,
  type OrderSideValue,
  type OrderStatusValue,
} from '@fintech/shared';

import {
  DatabaseService,
  type TransactionClient,
} from '../../database/database.service.js';
import {
  INSTRUMENT_JOIN_COLUMNS,
  mapInstrumentRow,
} from '../instruments/instruments.repository.js';

/** 帳戶餘額（已鎖定）。 */
export interface LockedAccount {
  readonly id: string;
  readonly cashBalanceCents: Cents;
}

/** 持倉現況（已鎖定）。持倉不存在時整個物件為 null。 */
export interface LockedPosition {
  readonly id: string;
  readonly quantity: number;
  readonly avgCostCents: Cents;
}

@Injectable()
export class OrdersRepository {
  constructor(private readonly db: DatabaseService) {}

  // ==========================================================================
  // 步驟 2 — 鎖住帳戶 ★ 整個專案最重要的一行 SQL
  // ==========================================================================

  /**
   * 讀取帳戶餘額，並鎖住那一列直到交易結束。
   *
   * ── `FOR UPDATE` 到底做了什麼 ───────────────────────────────────
   *
   *   它對這一列加上「排他鎖」。其他交易若對同一列也下 `FOR UPDATE`，
   *   會**卡在這一行等待**，直到本交易 COMMIT 或 ROLLBACK 才繼續。
   *
   *   沒有它的話會發生 lost update：
   *
   *     t1  請求 A 讀到餘額 10,000
   *     t2  請求 B 讀到餘額 10,000      ← 讀到的是還沒扣款的舊值
   *     t3  A 檢查買 8,000 → 夠
   *     t4  B 檢查買 8,000 → 夠         ← 錯！A 的錢已經要花掉了
   *     t5  A 寫入餘額 2,000
   *     t6  B 寫入餘額 2,000            ← A 的扣款被整個蓋掉
   *
   *     結果：花了 16,000 元，餘額只少了 8,000 元。
   *
   *   加上 `FOR UPDATE` 之後，t2 會卡住等到 t5 之後才讀，
   *   讀到的是 2,000，檢查就會正確地失敗。
   *
   *   這叫 TOCTOU（Time-of-check to time-of-use）—— 檢查的時間點
   *   和使用的時間點之間，狀態被別人改了。
   *
   * ── 為什麼不用 SERIALIZABLE 隔離等級 ────────────────────────────
   *
   *   SERIALIZABLE 會自動偵測這類衝突，不需要手動鎖。但衝突時交易會
   *   直接失敗（serialization_failure），應用層必須實作重試迴圈。
   *   而且鎖的範圍由資料庫決定，出問題時很難推理。
   *
   *   READ COMMITTED + 顯式 FOR UPDATE 的好處是**它強迫你想清楚要鎖什麼** ——
   *   這個思考過程本身就是要展示的能力。
   *
   * @param tx 交易連線
   * @param accountId 帳戶 ID
   * @returns 鎖定後讀到的餘額；帳戶不存在時為 null
   */
  async lockAccount(tx: TransactionClient, accountId: string): Promise<LockedAccount | null> {
    const { rows } = await tx.query(
      `SELECT id, cash_balance_cents::text AS cash_balance_cents
         FROM accounts
        WHERE id = $1
          FOR UPDATE`,
      [accountId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: String(row.id),
      cashBalanceCents: cents(Number(row.cash_balance_cents)),
    };
  }

  /**
   * 讀取持倉並鎖住。賣出時用來檢查「可賣股數是否足夠」。
   *
   * 為什麼賣出也要鎖：理由和餘額一模一樣 —— 同時送出兩筆賣單，
   * 兩邊都讀到「還有 1000 股」，就會賣出 2000 股，股數變負數
   * （資料庫的 `CHECK (quantity >= 0)` 會擋下，但那是拋例外，
   * 不是我們想要的錯誤訊息）。
   *
   * ⚠️ 鎖的順序必須固定：**先鎖帳戶、再鎖持倉**。
   *    如果有的路徑先鎖持倉再鎖帳戶，兩個請求交錯就會死鎖
   *    （A 拿著帳戶等持倉，B 拿著持倉等帳戶）。
   *    本專案所有寫入路徑都遵守這個順序。
   *
   * @returns 持倉不存在時為 null（代表一股都沒有）
   */
  async lockPosition(
    tx: TransactionClient,
    accountId: string,
    instrumentId: string,
  ): Promise<LockedPosition | null> {
    const { rows } = await tx.query(
      `SELECT id,
              quantity::text       AS quantity,
              avg_cost_cents::text AS avg_cost_cents
         FROM positions
        WHERE account_id = $1 AND instrument_id = $2
          FOR UPDATE`,
      [accountId, instrumentId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: String(row.id),
      quantity: Number(row.quantity),
      avgCostCents: cents(Number(row.avg_cost_cents)),
    };
  }

  // ==========================================================================
  // 標的查詢
  // ==========================================================================

  /**
   * 依代號查標的。下單前要確認標的存在、且仍可交易。
   *
   * 這個方法有兩個版本的呼叫情境：交易內（下單）與交易外（試算），
   * 所以 `tx` 是選填 —— 沒傳就用連線池自己開一條。
   */
  async findInstrument(symbol: string, tx?: TransactionClient): Promise<Instrument | null> {
    const sql = `SELECT
                   id, symbol, name, market, lot_size,
                   prev_close_cents::text AS prev_close_cents,
                   is_active
                 FROM instruments
                WHERE symbol = $1
                LIMIT 1`;

    const { rows } = tx
      ? await tx.query(sql, [symbol])
      : await this.db.query(sql, [symbol]);

    const row = rows[0];
    return row ? mapInstrumentRow(row as unknown as Record<string, unknown>) : null;
  }

  // ==========================================================================
  // 步驟 5 / 10 — 委託
  // ==========================================================================

  /**
   * 建立委託，狀態 PENDING。
   *
   * ── 為什麼先寫 PENDING 再改 FILLED，而不是直接寫 FILLED ★ ────────
   *
   *   在本專案的同步模擬撮合下，這兩者的最終結果一樣。但這個寫法是
   *   為真實世界的非同步撮合預留的：真的下單到交易所，「已受理」和
   *   「已成交」之間會隔幾百毫秒到幾分鐘，中間使用者要看得到
   *   「委託處理中」。如果一開始就設計成只有 FILLED，之後要接真實
   *   撮合就得改資料模型。
   *
   *   `idempotency_key` 有 UNIQUE 約束 —— 這是冪等的**最終防線**。
   *   Redis 那層是快速路徑（見 orders.service.ts），但 Redis 不持久，
   *   重啟就沒了。資料庫的 UNIQUE 是永久有效的。
   *
   * @returns 新委託的 ID
   * @throws pg 的 unique_violation（code 23505）當冪等鍵重複
   */
  async insertOrder(
    tx: TransactionClient,
    params: {
      accountId: string;
      instrumentId: string;
      side: OrderSideValue;
      quantity: number;
      limitPriceCents: Cents;
      idempotencyKey: string;
    },
  ): Promise<string> {
    const { rows } = await tx.query(
      `INSERT INTO orders
         (account_id, instrument_id, side, order_type, quantity,
          limit_price_cents, status, idempotency_key)
       VALUES ($1, $2, $3, 'LIMIT', $4, $5, 'PENDING', $6)
       RETURNING id`,
      [
        params.accountId,
        params.instrumentId,
        params.side,
        params.quantity,
        params.limitPriceCents,
        params.idempotencyKey,
      ],
    );

    return String(rows[0]!.id);
  }

  /** 步驟 10 — 標記委託為已成交。 */
  async markOrderFilled(tx: TransactionClient, orderId: string): Promise<void> {
    await tx.query(
      `UPDATE orders SET status = 'FILLED', updated_at = now() WHERE id = $1`,
      [orderId],
    );
  }

  /**
   * 標記委託為被拒。
   *
   * ⚠️ 這個方法**不能在被回滾的交易裡呼叫** —— 交易一旦 ROLLBACK，
   *    這筆 UPDATE 也會跟著消失。被拒的委託如果要留存紀錄，
   *    必須在交易外、用另一條連線寫入（見 orders.service.ts 的說明）。
   */
  async markOrderRejected(orderId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE orders
          SET status = 'REJECTED', reject_reason = $2, updated_at = now()
        WHERE id = $1`,
      [orderId, reason],
    );
  }

  // ==========================================================================
  // 步驟 6 — 成交
  // ==========================================================================

  /** 寫入成交紀錄。本專案的模擬撮合固定以限價全額成交，所以只有一筆。 */
  async insertExecution(
    tx: TransactionClient,
    params: {
      orderId: string;
      quantity: number;
      priceCents: Cents;
      feeCents: Cents;
      taxCents: Cents;
    },
  ): Promise<Execution> {
    const { rows } = await tx.query(
      `INSERT INTO executions
         (order_id, filled_quantity, filled_price_cents, fee_cents, tax_cents)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id,
                 filled_quantity::text    AS filled_quantity,
                 filled_price_cents::text AS filled_price_cents,
                 fee_cents::text          AS fee_cents,
                 tax_cents::text          AS tax_cents,
                 executed_at`,
      [params.orderId, params.quantity, params.priceCents, params.feeCents, params.taxCents],
    );

    const row = rows[0]!;
    return {
      id: String(row.id),
      filledQuantity: Number(row.filled_quantity),
      filledPriceCents: cents(Number(row.filled_price_cents)),
      feeCents: cents(Number(row.fee_cents)),
      taxCents: cents(Number(row.tax_cents)),
      executedAt: new Date(row.executed_at as string).toISOString(),
    };
  }

  // ==========================================================================
  // 步驟 7 — 帳戶餘額
  // ==========================================================================

  /**
   * 更新帳戶餘額。
   *
   * ── 為什麼是寫入「算好的絕對值」而不是 `SET balance = balance - $1` ──
   *
   *   後者（相對更新）在沒有鎖的情況下比較安全，因為扣減發生在資料庫內部，
   *   不會有 lost update。但本專案**已經用 FOR UPDATE 鎖住了**，
   *   兩種寫法一樣安全，而寫絕對值有一個好處：
   *
   *     餘額是在 Service 裡用 shared/money.ts 算出來的，
   *     和寫進 transactions 表的 balance_after_cents 是**同一個值**。
   *
   *   如果用相對更新，資料庫算一次、Service 為了寫流水又算一次，
   *   兩邊就有可能不一致 —— 而流水帳的結餘對不上是金融系統的致命傷。
   */
  async updateAccountBalance(
    tx: TransactionClient,
    accountId: string,
    balanceCents: Cents,
  ): Promise<void> {
    await tx.query(
      `UPDATE accounts SET cash_balance_cents = $2, updated_at = now() WHERE id = $1`,
      [accountId, balanceCents],
    );
  }

  // ==========================================================================
  // 步驟 8 — 持倉
  // ==========================================================================

  /**
   * 寫入或更新持倉（買進用）。
   *
   * `ON CONFLICT ... DO UPDATE` 是 PostgreSQL 的 UPSERT：有就更新、沒有就新增。
   * 它靠的是 positions 表上的 `UNIQUE (account_id, instrument_id)` 約束。
   *
   * 為什麼不用「先 SELECT 看有沒有，再決定 INSERT 或 UPDATE」：
   *   那是兩次往返，而且中間有競態（兩個請求同時發現「沒有」，
   *   然後都去 INSERT，第二個撞 UNIQUE 爆掉）。UPSERT 是單一原子操作。
   *
   * @param quantity 更新後的**總股數**（不是增量）
   * @param avgCostCents 更新後的平均成本，由 weightedAverageCost() 算出
   */
  async upsertPosition(
    tx: TransactionClient,
    params: {
      accountId: string;
      instrumentId: string;
      quantity: number;
      avgCostCents: Cents;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO positions (account_id, instrument_id, quantity, avg_cost_cents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, instrument_id)
       DO UPDATE SET quantity       = EXCLUDED.quantity,
                     avg_cost_cents = EXCLUDED.avg_cost_cents,
                     updated_at     = now()`,
      [params.accountId, params.instrumentId, params.quantity, params.avgCostCents],
    );
  }

  /**
   * 賣出後更新持倉。股數歸零時**刪除該列**，而不是留一筆 quantity = 0。
   *
   * 為什麼要刪：持倉頁的定義是「我現在持有什麼」，一檔已經全部賣掉的股票
   * 留在列表裡顯示 0 股是雜訊。歷史紀錄在 transactions 表裡，不會遺失。
   * （seed 的測試也驗證了這一點：「持倉不含已出清的標的」）
   */
  async reducePosition(
    tx: TransactionClient,
    positionId: string,
    remainingQuantity: number,
  ): Promise<void> {
    if (remainingQuantity === 0) {
      await tx.query(`DELETE FROM positions WHERE id = $1`, [positionId]);
      return;
    }

    // 賣出不改變平均成本 —— 賣掉的部分變成已實現損益，
    // 留下的部分取得成本不變。理由見 shared/money.ts 的 weightedAverageCost()。
    await tx.query(
      `UPDATE positions SET quantity = $2, updated_at = now() WHERE id = $1`,
      [positionId, remainingQuantity],
    );
  }

  // ==========================================================================
  // 步驟 9 — 流水帳
  // ==========================================================================

  /**
   * 寫入一筆交易明細。
   *
   * ── `balanceAfterCents` 為什麼要存 ★ ──────────────────────────────
   *
   *   直覺會覺得這是冗餘欄位 —— 餘額可以從歷史明細累加算出來。
   *   但金融系統一定要存「當下結餘」，理由是：
   *
   *     1. **稽核**：對帳時要能指著某一筆說「這一刻餘額是多少」，
   *        而不是重播全部歷史。
   *     2. **效能**：明細頁一次顯示 30 筆，若要現算結餘就得把
   *        該帳戶從開戶到現在的每一筆都撈出來累加。
   *     3. **可驗證**：存下來之後，「結餘序列是否自洽」變成一個
   *        可以寫測試檢查的性質（seed 的測試就有這一條）。
   *
   *   代價是這個欄位必須**永遠正確**。所以它只能在鎖住帳戶的交易內寫入。
   *
   * ── `occurredAt` 為什麼是參數，不直接用 SQL 的 `now()` ★ ──────────
   *
   *   因為一筆成交會產生 2–3 列流水（成交／手續費／稅），如果三列都寫
   *   `now()`，它們的 `occurred_at` 會完全相同（PostgreSQL 的 `now()`
   *   回傳的是**交易開始時間**，同一個交易內呼叫幾次都一樣）。
   *
   *   而明細頁的排序是 `ORDER BY occurred_at DESC, id DESC` ——
   *   時間相同時就退化成比 UUID 大小，而 UUID 是隨機的。結果是
   *   同一筆交易的三列在畫面上順序隨機，結餘看起來像跳來跳去：
   *
   *     SELL  → 結餘 119,320,117     ← 看起來最新，其實是最舊的一列
   *     FEE   → 結餘 119,193,317
   *     TAX   → 結餘 118,926,317     ← 這才是真正的最新結餘
   *
   *   所以由呼叫端明確給定時間，每列相隔 1 秒。seed 產生歷史資料時
   *   用的是同一套規則（factory.ts 的 `occurredAt.getTime() + 1000`），
   *   兩邊的明細看起來才會一致。
   */
  async insertTransaction(
    tx: TransactionClient,
    params: {
      accountId: string;
      type: 'BUY' | 'SELL' | 'FEE' | 'TAX';
      instrumentId: string | null;
      quantity: number | null;
      priceCents: Cents | null;
      amountCents: Cents;
      balanceAfterCents: Cents;
      orderId: string;
      description: string;
      occurredAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO transactions
         (account_id, type, instrument_id, quantity, price_cents,
          amount_cents, balance_after_cents, order_id, description, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        params.accountId,
        params.type,
        params.instrumentId,
        params.quantity,
        params.priceCents,
        params.amountCents,
        params.balanceAfterCents,
        params.orderId,
        params.description,
        params.occurredAt,
      ],
    );
  }

  // ==========================================================================
  // 查詢（交易外）
  // ==========================================================================

  /**
   * 查詢單一委託，含標的與成交明細。
   *
   * ⚠️ `WHERE ... AND account_id = $2` 這個條件是**防 IDOR 的關鍵**。
   *    只用 `WHERE id = $1` 的話，任何人改網址上的 UUID 就能看別人的委託。
   *    帳戶 ID 來自 JWT，前端無法指定。
   */
  async findOrderById(
    orderId: string,
    accountId: string,
  ): Promise<{ order: Order; executions: Execution[] } | null> {
    const { rows } = await this.db.query(
      `SELECT o.id,
              o.side,
              o.order_type,
              o.quantity::text          AS quantity,
              o.limit_price_cents::text AS limit_price_cents,
              o.status,
              o.reject_reason,
              o.created_at,
              ${INSTRUMENT_JOIN_COLUMNS}
         FROM orders o
         JOIN instruments i ON i.id = o.instrument_id
        WHERE o.id = $1 AND o.account_id = $2
        LIMIT 1`,
      [orderId, accountId],
    );

    const row = rows[0];
    if (!row) return null;

    const order: Order = {
      id: String(row.id),
      instrument: mapInstrumentRow(row as Record<string, unknown>, 'instrument_'),
      side: String(row.side) as OrderSideValue,
      orderType: 'LIMIT',
      quantity: Number(row.quantity),
      limitPriceCents: cents(Number(row.limit_price_cents)),
      status: String(row.status) as OrderStatusValue,
      rejectReason: row.reject_reason ? String(row.reject_reason) : null,
      createdAt: new Date(row.created_at as string).toISOString(),
    };

    const { rows: execRows } = await this.db.query(
      `SELECT id,
              filled_quantity::text    AS filled_quantity,
              filled_price_cents::text AS filled_price_cents,
              fee_cents::text          AS fee_cents,
              tax_cents::text          AS tax_cents,
              executed_at
         FROM executions
        WHERE order_id = $1
        ORDER BY executed_at`,
      [orderId],
    );

    const executions: Execution[] = execRows.map((r) => ({
      id: String(r.id),
      filledQuantity: Number(r.filled_quantity),
      filledPriceCents: cents(Number(r.filled_price_cents)),
      feeCents: cents(Number(r.fee_cents)),
      taxCents: cents(Number(r.tax_cents)),
      executedAt: new Date(r.executed_at as string).toISOString(),
    }));

    return { order, executions };
  }
}
