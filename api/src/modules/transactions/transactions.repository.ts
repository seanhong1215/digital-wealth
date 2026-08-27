/**
 * api/src/modules/transactions/transactions.repository.ts — 明細資料存取
 *
 * 這個檔案是什麼：
 *   交易明細的 cursor 分頁查詢。這是本單元技術含量最高的一段 SQL。
 *
 * ── 讀這個檔案前，先讀 cursor.ts ─────────────────────────────────
 *
 * 那裡解釋了為什麼不用 OFFSET、為什麼游標要包含 id、
 * 以及 `(a, b) < (c, d)` 這個列比較語法的語意。
 *
 * 在架構的哪一層：資料存取層。
 */

import { Injectable } from '@nestjs/common';

import {
  cents,
  type Transaction,
  type TransactionQuery,
  type TransactionType,
} from '@digital-wealth/shared';

import { DatabaseService } from '../../database/database.service.js';
import {
  INSTRUMENT_JOIN_COLUMNS,
  mapInstrumentRow,
} from '../instruments/instruments.repository.js';
import { decodeCursor, encodeCursor } from './cursor.js';

/** 一頁明細，以及下一頁的游標。 */
export interface TransactionPageResult {
  readonly items: Transaction[];
  /** `null` 代表沒有下一頁了 */
  readonly nextCursor: string | null;
}

@Injectable()
export class TransactionsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 以 cursor 分頁查詢交易明細。
   *
   * @param accountId 帳戶 id（★ 來自 JWT，不是前端傳的）
   * @param query 查詢條件，已由 zod 驗證
   * @returns 一頁明細與下一頁的游標
   * @throws {AppError} 游標格式不合法時（VALIDATION_FAILED）
   */
  async findPage(accountId: string, query: TransactionQuery): Promise<TransactionPageResult> {
    // 第一頁沒有游標；之後每頁都從上一頁的最後一筆位置往下取。
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);

    // ── 參數陣列的組法 ──────────────────────────────────────────
    //
    // SQL 的參數是位置式的（$1、$2…），所以參數陣列的**順序**
    // 必須與 SQL 裡的編號完全對應。
    //
    // 因為篩選條件是選填的，這裡採取「條件永遠存在、值為 NULL 時失效」
    // 的寫法（`$3::timestamptz IS NULL OR ...`），
    // 這樣 SQL 是靜態的、參數編號固定，不需要動態拼接字串。
    //
    // 動態拼接 SQL 是 SQL Injection 最常見的來源，能避就避。
    const params: unknown[] = [
      accountId, // $1
      query.limit + 1, // $2  ← 多取一筆，理由見下方
      query.from ?? null, // $3
      query.to ?? null, // $4
      // zod 已經把 'BUY,SELL' 拆成陣列，這裡直接傳給 PostgreSQL 的
      // = ANY($5) 語法。傳 null 時該條件自動失效。
      query.type ?? null, // $5
      position?.occurredAt ?? null, // $6
      position?.id ?? null, // $7
    ];

    const { rows } = await this.db.query(
      `SELECT
         t.id,
         t.type,
         t.quantity::text            AS quantity,
         t.price_cents::text         AS price_cents,
         t.amount_cents::text        AS amount_cents,
         t.balance_after_cents::text AS balance_after_cents,
         t.description,
         t.occurred_at,
         ${INSTRUMENT_JOIN_COLUMNS}
       FROM transactions t
       LEFT JOIN instruments i ON i.id = t.instrument_id
       WHERE t.account_id = $1
         AND ($3::timestamptz IS NULL OR t.occurred_at >= $3)
         AND ($4::timestamptz IS NULL OR t.occurred_at <= $4)
         AND ($5::text[]      IS NULL OR t.type = ANY($5))
         AND (
           $6::timestamptz IS NULL
           OR (t.occurred_at, t.id) < ($6::timestamptz, $7::uuid)
         )
       ORDER BY t.occurred_at DESC, t.id DESC
       LIMIT $2`,
      params,
    );

    // ── 為什麼是 LEFT JOIN 而不是 JOIN ★ ────────────────────────
    //
    // 因為入出金類的明細**沒有標的**（instrument_id 是 NULL）。
    //
    // 用一般的 JOIN（等同 INNER JOIN）會把這些列整個過濾掉 ——
    // 使用者的明細頁就會少掉「銀行轉入」「銀行轉出」那幾筆，
    // 而且結餘序列會突然斷掉對不上。
    //
    // LEFT JOIN 保留左表（transactions）的所有列，
    // 右表沒有對應時，那些欄位是 NULL。
    //
    // 這是新手最常見的 JOIN 錯誤之一，而且症狀是「資料少了幾筆」
    // 而不是報錯，很容易在開發時沒發現。

    // ── 為什麼要多取一筆（limit + 1）★ ──────────────────────────
    //
    // 我們需要知道「還有沒有下一頁」，才能決定 nextCursor 要不要給 null。
    //
    // 常見但錯誤的做法：另外下一個 `SELECT count(*)` 算總數。
    // 那要對整個結果集做一次完整掃描，在 8000 筆的表上比取資料本身還慢，
    // 而且 count 與取資料之間有時間差，數字可能對不上。
    //
    // 正確做法：**多取一筆**。
    //   拿回 limit + 1 筆 → 還有下一頁，把多的那筆丟掉
    //   拿回 ≤ limit 筆   → 到底了，nextCursor = null
    //
    // 成本只是多讀一列，而且完全準確。
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;

    const items = pageRows.map((row) => this.toDomain(row as unknown as Record<string, unknown>));

    // 下一頁的游標指向**這一頁最後一筆**的位置。
    // 沒有下一頁時是 null，前端據此停止無限捲動。
    const last = pageRows.at(-1) as unknown as Record<string, unknown> | undefined;
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            occurredAt: (last['occurred_at'] as Date).toISOString(),
            id: String(last['id']),
          })
        : null;

    return { items, nextCursor };
  }

  /**
   * 把明細的 row 轉成應用層物件。
   *
   * ── NULL 的處理是這裡的重點 ──────────────────────────────────
   *
   * `instrument` / `quantity` / `priceCents` 在非交易類異動
   * （入出金、費用）時是 NULL。
   *
   * **必須保留 null，不可以轉成 0：**
   *   0    代表「數量是零」
   *   null 代表「這個概念不適用」
   *
   * 混用的話，畫面上會出現「銀行轉入 0 股 @ 0 元」這種荒謬的文字。
   * 前端要能區分兩者才能正確顯示「—」或整個欄位不出現。
   */
  private toDomain(row: Record<string, unknown>): Transaction {
    // LEFT JOIN 沒對應到標的時，所有 instrument_ 開頭的欄位都是 null。
    // 檢查其中一個就能判斷有沒有標的。
    const hasInstrument = row['instrument_id'] !== null && row['instrument_id'] !== undefined;

    const quantityRaw = row['quantity'];
    const priceRaw = row['price_cents'];

    return {
      id: String(row['id']),
      type: String(row['type']) as TransactionType,
      instrument: hasInstrument ? mapInstrumentRow(row, 'instrument_') : null,
      quantity: quantityRaw === null ? null : Number(quantityRaw),
      priceCents: priceRaw === null ? null : cents(Number(priceRaw)),
      amountCents: cents(Number(row['amount_cents'])),
      balanceAfterCents: cents(Number(row['balance_after_cents'])),
      description: String(row['description']),
      occurredAt: (row['occurred_at'] as Date).toISOString(),
    };
  }
}
