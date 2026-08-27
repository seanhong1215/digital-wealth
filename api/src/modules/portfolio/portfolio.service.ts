/**
 * api/src/modules/portfolio/portfolio.service.ts — 投組業務邏輯
 *
 * 這個檔案是什麼：
 *   把 Repository 撈回來的原始數字，組合成前端要的總覽形狀。
 *
 * ── 這一層真正在做的事：權威值 vs 衍生值的分界 ────────────────────
 *
 * 全端專案最容易做錯的地方，是同一個數字在前後端各算一次然後兜不攏。
 * 本專案的判準（docs/00-architecture.md）：
 *
 *   **涉及金錢正確性的用後端算；隨即時報價變動的用前端算。**
 *
 * 所以這個 Service 算的是：現金、成本、已實現損益 —— 全都是
 * 「不會因為報價跳動而改變」的權威值。
 *
 * 它**不算**未實現損益 —— 那需要即時報價，由前端在收到 WebSocket
 * 推送後自己算。若由後端算，每個 tick 都要重算整個投組再推送，
 * 頻寬與運算都不划算，而且推送延遲會讓數字看起來卡頓。
 *
 * 在架構的哪一層：業務邏輯層。
 */

import { Injectable } from '@nestjs/common';

import {
  ZERO_CENTS,
  add,
  subtract,
  type PortfolioSnapshot,
  type PortfolioSummary,
  type Position,
} from '@digital-wealth/shared';

import { PortfolioRepository } from './portfolio.repository.js';

@Injectable()
export class PortfolioService {
  constructor(private readonly repository: PortfolioRepository) {}

  /**
   * 取得持倉清單。
   *
   * @param accountId 帳戶 id（★ 來自 JWT）
   * @returns 持倉清單，含標的資料與成本總額
   */
  async getPositions(accountId: string): Promise<Position[]> {
    return this.repository.findPositions(accountId);
  }

  /**
   * 取得資產走勢快照。
   *
   * @param accountId 帳戶 id（★ 來自 JWT）
   * @param days 要取最近幾天
   * @returns 快照清單，依日期由舊到新
   */
  async getSnapshots(accountId: string, days: number): Promise<PortfolioSnapshot[]> {
    return this.repository.findSnapshots(accountId, days);
  }

  /**
   * 取得投組總覽。
   *
   * @param accountId 帳戶 id（★ 來自 JWT）
   * @returns 總覽聚合
   */
  async getSummary(accountId: string): Promise<PortfolioSummary> {
    const inputs = await this.repository.findSummaryInputs(accountId);

    // ── 已實現損益 ─────────────────────────────────────────────
    //
    //   已實現損益 = 現金 + 持倉成本 − 淨入金
    //
    // 完整的推導寫在 portfolio.repository.ts 的 findSummaryInputs()。
    // 簡短版：展開之後等於「賣出價差 − 手續費 − 證交稅 + 股利」，
    // 也就是扣掉所有成本後真正落袋的損益。可能為負。
    //
    // ★ 注意所有算術都經過 shared/money.ts 的函式，
    //   不是直接寫 a + b - c。這樣結果的型別維持 Cents，
    //   而且每一步都有溢位檢查（見 money.ts 的說明）。
    const realizedPnlCents = subtract(
      add(inputs.cashCents, inputs.totalCostBasisCents),
      inputs.netDepositCents,
    );

    // ── 今日損益 ───────────────────────────────────────────────
    //
    //   今日損益 = 最新一日總資產 − 前一日總資產
    //
    // ⚠️ 這個算法**包含當日的入出金**，嚴格來說不是純粹的投資損益。
    //    精確的算法需要逐日的每檔收盤價，而我們只存了最新的昨收價
    //    （見 instruments.prev_close_cents）。
    //
    //    以 demo 用途來說這個近似夠用。要做精確版的話，
    //    schema 得多一張「每日收盤價」表 —— 那是為了一個小數字
    //    付出的大成本，不划算。
    //
    // 快照不足兩天時回 0（新帳戶的第一天，或 new-user 情境）。
    const todayPnlCents =
      inputs.latestTotalValueCents !== null && inputs.previousTotalValueCents !== null
        ? subtract(inputs.latestTotalValueCents, inputs.previousTotalValueCents)
        : ZERO_CENTS;

    return {
      cashCents: inputs.cashCents,
      // ⚠️ 這個市值是**以昨收價計算的基準值**，不是即時市值。
      //    它存在的理由是讓前端在報價還沒進來時有東西可以顯示，
      //    不用先出現一個空白或 0。報價進來後前端會重算並覆蓋它。
      marketValueCents: inputs.marketValueCents,
      totalValueCents: add(inputs.cashCents, inputs.marketValueCents),
      totalCostBasisCents: inputs.totalCostBasisCents,
      realizedPnlCents,
      todayPnlCents,
    };
  }
}
