/**
 * api/src/modules/portfolio/portfolio.repository.ts — 投組資料存取
 *
 * 這個檔案是什麼：
 *   持倉、資產快照、以及總覽聚合所需的 SQL。
 *
 * ── 這個檔案裡最值得看的是 findSummaryInputs() 的算式 ─────────────
 *
 * 已實現損益的計算是本單元唯一「不只是撈資料」的地方，
 * 詳細推導寫在那個方法的註解裡。
 *
 * 在架構的哪一層：資料存取層。
 */

import { Injectable } from '@nestjs/common';

import {
  cents,
  multiply,
  type Cents,
  type Position,
  type PortfolioSnapshot,
} from '@digital-wealth/shared';

import { DatabaseService } from '../../database/database.service.js';
import {
  INSTRUMENT_JOIN_COLUMNS,
  mapInstrumentRow,
} from '../instruments/instruments.repository.js';

/** 計算總覽所需的原始數字，全部單位為分。 */
export interface SummaryInputs {
  /** 帳戶現金餘額 */
  readonly cashCents: Cents;
  /** 持倉成本總額 = Σ(股數 × 平均成本) */
  readonly totalCostBasisCents: Cents;
  /** 以昨收價計算的持股市值 = Σ(股數 × 昨收價) */
  readonly marketValueCents: Cents;
  /** 淨入金 = Σ入金 − Σ出金 */
  readonly netDepositCents: Cents;
  /** 最新一日的總資產快照。無快照時為 null */
  readonly latestTotalValueCents: Cents | null;
  /** 前一日的總資產快照。快照不足兩天時為 null */
  readonly previousTotalValueCents: Cents | null;
}

@Injectable()
export class PortfolioRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 查詢帳戶的所有持倉，含標的資料。
   *
   * ── 為什麼用 JOIN 而不是先查持倉再逐筆查標的 ★ ───────────────
   *
   * 分開查的話會是這樣：
   *
   *     const positions = await queryPositions(accountId);       // 1 次
   *     for (const p of positions) {
   *       p.instrument = await queryInstrument(p.instrumentId);  // N 次
   *     }
   *
   * 12 檔持倉就是 13 次資料庫往返。這叫 **N+1 查詢問題**，
   * 是後端效能最經典的坑 —— 開發時資料少（2 檔持倉 = 3 次查詢）
   * 完全感覺不出來，上線後資料變多才發現頁面越來越慢。
   *
   * 用 JOIN 一次撈完永遠是 1 次往返。
   *
   * ⚠️ ORM 特別容易掉進這個坑（存取關聯屬性時自動發查詢，
   *    而且看不出來），這也是 ADR 0010 選擇手寫 SQL 的理由之一 ——
   *    SQL 寫在眼前，有幾次查詢一目瞭然。
   *
   * @param accountId 帳戶 id（★ 來自 JWT，不是前端傳的）
   * @returns 持倉清單，依成本總額由大到小排序
   */
  async findPositions(accountId: string): Promise<Position[]> {
    const { rows } = await this.db.query(
      `SELECT
         p.id,
         p.quantity::text        AS quantity,
         p.avg_cost_cents::text  AS avg_cost_cents,
         ${INSTRUMENT_JOIN_COLUMNS}
       FROM positions p
       JOIN instruments i ON i.id = p.instrument_id
       WHERE p.account_id = $1
         AND p.quantity > 0
       ORDER BY p.quantity * p.avg_cost_cents DESC`,
      // ★ 這個 WHERE 條件是防 IDOR 的關鍵。
      //   accountId 永遠來自 JWT，所以使用者不可能查到別人的持倉。
      //   本專案所有查詢都必須帶這個條件。
      [accountId],
    );

    return rows.map((row) => {
      const record = row as unknown as Record<string, unknown>;
      const quantity = Number(record['quantity']);
      const avgCostCents = cents(Number(record['avg_cost_cents']));

      return {
        id: String(record['id']),
        instrument: mapInstrumentRow(record, 'instrument_'),
        quantity,
        avgCostCents,
        // 成本總額由後端算好給前端。它不隨報價變動，屬於權威值。
        costBasisCents: multiply(avgCostCents, quantity),
      };
    });
  }

  /**
   * 查詢最近 N 天的資產快照。
   *
   * @param accountId 帳戶 id
   * @param days 要取幾天
   * @returns 快照清單，**依日期由舊到新**排序（畫折線圖的順序）
   */
  async findSnapshots(accountId: string, days: number): Promise<PortfolioSnapshot[]> {
    // ── 為什麼用子查詢先取最新 N 筆，外層再反轉排序 ─────────────
    //
    // 我們要的是「最近 30 天」，所以必須先由新到舊排序才能 LIMIT。
    // 但畫折線圖需要的順序是由舊到新（x 軸由左到右）。
    //
    // 在 SQL 裡處理比在 JavaScript 裡 `.reverse()` 好 ——
    // 少一次陣列複製，而且意圖直接寫在查詢裡。
    const { rows } = await this.db.query<{
      snapshot_date: Date;
      cash_cents: string;
      market_value_cents: string;
      total_value_cents: string;
    }>(
      `SELECT * FROM (
         SELECT snapshot_date,
                cash_cents::text,
                market_value_cents::text,
                total_value_cents::text
         FROM portfolio_snapshots
         WHERE account_id = $1
         ORDER BY snapshot_date DESC
         LIMIT $2
       ) recent
       ORDER BY snapshot_date ASC`,
      [accountId, days],
    );

    return rows.map((row) => ({
      // pg 把 DATE 欄位解析成 JavaScript 的 Date 物件（本地時區的午夜）。
      // 契約要的是 'YYYY-MM-DD' 字串，所以取 ISO 字串的前 10 個字元。
      date: row.snapshot_date.toISOString().slice(0, 10),
      cashCents: cents(Number(row.cash_cents)),
      marketValueCents: cents(Number(row.market_value_cents)),
      totalValueCents: cents(Number(row.total_value_cents)),
    }));
  }

  /**
   * 取得計算總覽所需的所有原始數字。
   *
   * ── 為什麼一次查完所有數字，而不是分成好幾個方法 ────────────
   *
   * 這些數字要一起呈現在同一張卡片上。分開查的話，
   * 兩次查詢之間如果有交易發生，湊出來的數字會是不同時間點的組合 ——
   * 現金是新的、持倉是舊的，加起來不等於任何一個真實時刻的總資產。
   *
   * 用一個查詢（同一個資料庫快照）撈完，數字必定自洽。
   *
   * ── 已實現損益的算式 ★ 本檔案最需要理解的部分 ──────────────
   *
   * 我們沒有存「已實現損益」這個欄位，要從現有資料推導。
   *
   * 先看每種交易對「現金」與「持倉成本」的影響：
   *
   *   入金       現金 +D
   *   買進       現金 −(股款+手續費)      持倉成本 +股款
   *   賣出       現金 +(股款−費用−稅)     持倉成本 −(賣出部分的成本)
   *   股利       現金 +股利
   *
   * 把「現金 + 持倉成本」加起來，展開後會發現：
   *
   *   現金 + 持倉成本
   *     = 淨入金
   *     + Σ(賣出股款 − 賣出部分的成本)    ← 毛已實現損益
   *     − Σ手續費 − Σ證交稅
   *     + Σ股利
   *
   * 所以：
   *
   *   **已實現損益 = 現金 + 持倉成本 − 淨入金**
   *
   * 這個值是「扣掉所有交易成本之後、真正落袋的損益」，
   * 可能為負（賠錢，或費用大於價差）。
   *
   * 好處是一條 SQL 就算得出來，不需要逐筆重播交易歷史。
   *
   * ⚠️ 誤差來源：平均成本以「分／股」四捨五入儲存，所以持倉成本
   *    會有最多 0.5 分／股的捨入誤差。萬股級的量級下影響在數十分以內。
   *
   * @param accountId 帳戶 id
   * @returns 計算總覽所需的原始數字
   * @throws {Error} 帳戶不存在時（查詢回傳空結果）
   */
  async findSummaryInputs(accountId: string): Promise<SummaryInputs> {
    // ── 為什麼用 CTE（WITH 子句）而不是好幾個子查詢 ─────────────
    //
    // CTE（Common Table Expression）讓每個中間結果都有名字，
    // 讀起來像一步一步的計算過程，而不是層層巢狀的括號。
    //
    // 這裡有四個獨立的聚合（現金、持倉、入出金、快照），
    // 最後用 CROSS JOIN 併成一列 —— 因為每個 CTE 都只回傳一列，
    // CROSS JOIN 的結果就是把它們的欄位橫向接起來。
    const { rows } = await this.db.query<{
      cash_cents: string;
      total_cost_basis_cents: string;
      market_value_cents: string;
      net_deposit_cents: string;
      latest_total_value_cents: string | null;
      previous_total_value_cents: string | null;
    }>(
      `WITH cash AS (
         SELECT cash_balance_cents AS value
         FROM accounts
         WHERE id = $1
       ),
       holdings AS (
         -- COALESCE 處理「完全沒有持倉」的情況。
         -- SUM 對空集合回傳 NULL 而不是 0，不處理的話 new-user
         -- 情境會拿到 NULL 然後在 Number(null) 變成 0 —— 剛好對，
         -- 但那是碰巧，不是設計。明確寫出來比較好。
         SELECT
           COALESCE(SUM(p.quantity * p.avg_cost_cents), 0)  AS cost_basis,
           COALESCE(SUM(p.quantity * i.prev_close_cents), 0) AS market_value
         FROM positions p
         JOIN instruments i ON i.id = p.instrument_id
         WHERE p.account_id = $1 AND p.quantity > 0
       ),
       deposits AS (
         -- amount_cents 本身帶正負號（入金為正、出金為負），
         -- 所以直接加總就是淨入金，不需要 CASE WHEN 分開處理。
         SELECT COALESCE(SUM(amount_cents), 0) AS value
         FROM transactions
         WHERE account_id = $1 AND type IN ('DEPOSIT', 'WITHDRAWAL')
       ),
       recent_snapshots AS (
         -- 取最近兩天的快照，用來算「今日損益」。
         -- ROW_NUMBER() 是視窗函式，給每一列一個序號；
         -- 序號 1 是最新的一天、2 是前一天。
         SELECT
           total_value_cents,
           ROW_NUMBER() OVER (ORDER BY snapshot_date DESC) AS rn
         FROM portfolio_snapshots
         WHERE account_id = $1
         LIMIT 2
       )
       SELECT
         cash.value::text          AS cash_cents,
         holdings.cost_basis::text AS total_cost_basis_cents,
         holdings.market_value::text AS market_value_cents,
         deposits.value::text      AS net_deposit_cents,
         (SELECT total_value_cents::text FROM recent_snapshots WHERE rn = 1)
                                   AS latest_total_value_cents,
         (SELECT total_value_cents::text FROM recent_snapshots WHERE rn = 2)
                                   AS previous_total_value_cents
       FROM cash
       CROSS JOIN holdings
       CROSS JOIN deposits`,
      [accountId],
    );

    const row = rows[0];
    if (!row) {
      // 帳戶不存在。走到這裡代表 JWT 裡的 accountId 指向一個
      // 已被刪除的帳戶 —— 不該發生，但不處理的話會變成
      // 「Cannot read property of undefined」的 500。
      throw new Error(`帳戶 ${accountId} 不存在`);
    }

    return {
      cashCents: cents(Number(row.cash_cents)),
      totalCostBasisCents: cents(Number(row.total_cost_basis_cents)),
      marketValueCents: cents(Number(row.market_value_cents)),
      netDepositCents: cents(Number(row.net_deposit_cents)),
      latestTotalValueCents:
        row.latest_total_value_cents === null
          ? null
          : cents(Number(row.latest_total_value_cents)),
      previousTotalValueCents:
        row.previous_total_value_cents === null
          ? null
          : cents(Number(row.previous_total_value_cents)),
    };
  }
}
