/**
 * api/src/modules/instruments/instruments.repository.ts — 標的資料存取
 *
 * 這個檔案是什麼：
 *   查詢交易標的的 SQL，以及 row → 物件的轉換。
 *
 * 這個模組同時是其他模組的基礎 —— 持倉與明細都需要標的資料，
 * 所以下面的 `mapInstrumentRow` 會被它們重複使用。
 *
 * 在架構的哪一層：資料存取層。
 */

import { Injectable } from '@nestjs/common';

import { cents, type Instrument, type Market } from '@digital-wealth/shared';

import { DatabaseService } from '../../database/database.service.js';

/**
 * `instruments` 表的 row 形狀。
 *
 * 注意 `prev_close_cents` 的型別是 `string` 而不是 `number` ——
 * 因為 SQL 裡用 `::text` 轉出來的。
 *
 * ── 為什麼 BIGINT 要轉成字串再讀 ★ ────────────────────────────────
 *
 * `pg` 套件預設把 PostgreSQL 的 `BIGINT`（int8）**當成字串回傳**。
 * 這不是 bug，是刻意的保護：BIGINT 的範圍是 ±9.2×10¹⁸，
 * 遠超過 JavaScript 的安全整數 ±9.0×10¹⁵。如果自動轉成 number，
 * 超出範圍的值會**靜默失去精度** —— 對金額來說是災難。
 *
 * 我們的金額不會超過安全範圍（見 money.ts 的 MAX_SAFE_CENTS 說明），
 * 所以明確用 `::text` 取出、再用 `cents(Number(...))` 轉換並驗證。
 *
 * 「明確轉換」比「依賴套件的預設行為」好 —— 讀程式碼的人一眼就知道
 * 這裡有一個型別轉換，而不是以為它本來就是數字。
 */
export interface InstrumentRow {
  id: string;
  symbol: string;
  name: string;
  market: string;
  lot_size: number;
  prev_close_cents: string;
  is_active: boolean;
}

/**
 * 把標的的 row 轉成應用層物件。
 *
 * 匯出成獨立函式（而非類別的私有方法），是因為 positions 與
 * transactions 的查詢也會 JOIN 標的表，需要用同一套轉換邏輯。
 *
 * 前綴參數讓它能處理「JOIN 之後欄位有別名」的情況：
 *
 *   SELECT i.id AS instrument_id, i.symbol AS instrument_symbol, ...
 *   → mapInstrumentRow(row, 'instrument_')
 *
 * @param row 含有標的欄位的資料庫 row
 * @param prefix 欄位名前綴，JOIN 查詢時用來避免欄位名衝突
 * @returns 應用層的標的物件
 */
export function mapInstrumentRow(row: Record<string, unknown>, prefix = ''): Instrument {
  return {
    id: String(row[`${prefix}id`]),
    symbol: String(row[`${prefix}symbol`]),
    name: String(row[`${prefix}name`]),
    market: String(row[`${prefix}market`]) as Market,
    lotSize: Number(row[`${prefix}lot_size`]),
    prevCloseCents: cents(Number(row[`${prefix}prev_close_cents`])),
    isActive: Boolean(row[`${prefix}is_active`]),
  };
}

/** JOIN 查詢時取得標的欄位的 SELECT 片段，欄位皆加上 `instrument_` 前綴。 */
export const INSTRUMENT_JOIN_COLUMNS = `
  i.id                       AS instrument_id,
  i.symbol                   AS instrument_symbol,
  i.name                     AS instrument_name,
  i.market                   AS instrument_market,
  i.lot_size                 AS instrument_lot_size,
  i.prev_close_cents::text   AS instrument_prev_close_cents,
  i.is_active                AS instrument_is_active`;

@Injectable()
export class InstrumentsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 搜尋標的。
   *
   * @param keyword 關鍵字，比對代號或名稱。省略時回傳全部
   * @param limit 最多回傳幾筆
   * @returns 符合條件的標的，依代號排序
   */
  async search(keyword: string | undefined, limit: number): Promise<Instrument[]> {
    // ── 為什麼用兩段式的條件，而不是動態拼接 SQL ────────────────
    //
    // 常見的寫法是「有關鍵字才加 WHERE 子句」，用字串拼接組出 SQL。
    // 那樣做有兩個問題：拼接容易出錯（多一個 AND、少一個空格），
    // 而且是 SQL Injection 的溫床。
    //
    // 這裡改成**條件永遠存在**，用 `$1 IS NULL OR ...` 讓它在
    // 沒有關鍵字時自動失效。SQL 是靜態的，參數是動態的 ——
    // 這才是參數化查詢該有的樣子。
    const { rows } = await this.db.query<InstrumentRow>(
      `SELECT
         id, symbol, name, market, lot_size,
         prev_close_cents::text AS prev_close_cents,
         is_active
       FROM instruments
       WHERE is_active = true
         AND ($1::text IS NULL OR symbol ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%')
       ORDER BY symbol
       LIMIT $2`,
      // ILIKE 是 PostgreSQL 的不分大小寫比對（LIKE 的 case-insensitive 版）。
      // 台股代號是數字、名稱是中文，其實用不到大小寫，
      // 但未來若加入美股代號（AAPL / aapl）就會需要。
      [keyword ?? null, limit],
    );

    return rows.map((row) => mapInstrumentRow(row as unknown as Record<string, unknown>));
  }

  /**
   * 依代號查單一標的。
   *
   * @param symbol 股票代號，例如 `2330`
   * @returns 標的；不存在時為 null
   */
  async findBySymbol(symbol: string): Promise<Instrument | null> {
    const { rows } = await this.db.query<InstrumentRow>(
      `SELECT
         id, symbol, name, market, lot_size,
         prev_close_cents::text AS prev_close_cents,
         is_active
       FROM instruments
       WHERE symbol = $1
       LIMIT 1`,
      [symbol],
    );

    const row = rows[0];
    return row ? mapInstrumentRow(row as unknown as Record<string, unknown>) : null;
  }
}
