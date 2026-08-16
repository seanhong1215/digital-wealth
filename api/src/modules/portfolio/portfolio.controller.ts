/**
 * api/src/modules/portfolio/portfolio.controller.ts — 投組查詢端點
 *
 *   GET /api/v1/portfolio/summary
 *   GET /api/v1/portfolio/snapshots?days=30
 *
 * ★ 注意這三個端點**都沒有任何路徑或查詢參數指定帳戶**。
 *   帳戶身分一律從 @CurrentUser() 取得，也就是從 JWT 來。
 *   這是防 IDOR 的根本做法 —— 不是「記得要檢查」，
 *   而是「根本沒有管道讓前端指定別人的帳戶」。
 *
 * 在架構的哪一層：HTTP 介面層。
 */

import { Controller, Get, Query } from '@nestjs/common';

import {
  snapshotQuerySchema,
  type AuthenticatedUser,
  type PortfolioSnapshot,
  type PortfolioSummary,
  type SnapshotQuery,
} from '@fintech/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { authRequired } from '../../common/errors/app.error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PortfolioService } from './portfolio.service.js';

@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  /**
   * 投組總覽：現金、市值、總資產、成本、已實現損益、今日損益。
   *
   * @param user 當前身分，由 JwtAuthGuard 注入
   * @returns 總覽聚合。所有金額單位為分，**不含格式化字串**
   */
  @Get('summary')
  async summary(@CurrentUser() user: AuthenticatedUser | undefined): Promise<PortfolioSummary> {
    if (!user) throw authRequired();
    return this.portfolioService.getSummary(user.accountId);
  }

  /**
   * 資產走勢：最近 N 天的每日快照。
   *
   * @param user 當前身分
   * @param query `?days=30`，已驗證（1–365，預設 30）
   * @returns 快照清單，依日期由舊到新（畫折線圖的順序）
   */
  @Get('snapshots')
  async snapshots(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query(new ZodValidationPipe(snapshotQuerySchema)) query: SnapshotQuery,
  ): Promise<PortfolioSnapshot[]> {
    if (!user) throw authRequired();
    return this.portfolioService.getSnapshots(user.accountId, query.days);
  }
}
