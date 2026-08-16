/**
 * api/src/modules/positions/positions.controller.ts — 持倉查詢端點
 *
 *   GET /api/v1/positions
 *
 * ── 為什麼持倉獨立一個路由，而不是放在 /portfolio 底下 ────────────
 *
 * 因為它們的更新頻率與使用情境不同：
 *   總覽（summary）  —— 一個數字卡片，載入一次
 *   持倉（positions）—— 一個列表，會被前端獨立重新整理
 *                        （例如下單成功後只需要更新持倉，不用重抓總覽）
 *
 * 分開之後，前端的 TanStack Query 可以用不同的快取鍵與失效策略。
 * 塞在同一個端點的話，任何一部分要更新都得整包重抓。
 *
 * ⚠️ 但 docs/adr/0007 決定「總覽與持倉在**畫面上**合併單頁」——
 *    那是 UI 的決定，與 API 怎麼切是兩回事。
 *    一個畫面呼叫兩個端點是完全正常的。
 *
 * 在架構的哪一層：HTTP 介面層。
 */

import { Controller, Get } from '@nestjs/common';

import { type AuthenticatedUser, type Position } from '@fintech/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { authRequired } from '../../common/errors/app.error.js';
import { PortfolioService } from '../portfolio/portfolio.service.js';

@Controller('positions')
export class PositionsController {
  constructor(private readonly portfolioService: PortfolioService) {}

  /**
   * 取得當前帳戶的所有持倉。
   *
   * 回傳的每一筆都內嵌完整的標的資料（代號、名稱、昨收價），
   * 前端不需要為了顯示名稱再打一次 API。
   *
   * ⚠️ **回傳值不含市值與未實現損益** —— 那需要即時報價，
   *    由前端自己算（見 shared/schemas/portfolio.ts 的說明）。
   *
   * @param user 當前身分，由 JwtAuthGuard 注入
   * @returns 持倉清單，依成本總額由大到小排序
   */
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser | undefined): Promise<Position[]> {
    if (!user) throw authRequired();
    return this.portfolioService.getPositions(user.accountId);
  }
}
