/**
 * api/src/modules/transactions/transactions.controller.ts — 明細查詢端點
 *
 *   GET /api/v1/transactions?cursor=...&limit=30&type=BUY,SELL&from=...&to=...
 *
 * 這是本專案資料量最大的端點（3,000–8,000 筆），
 * 也是前端虛擬滾動（TanStack Virtual，單元 1.8）的資料來源。
 *
 * 在架構的哪一層：HTTP 介面層。
 */

import { Controller, Get, Query } from '@nestjs/common';

import {
  transactionQuerySchema,
  type AuthenticatedUser,
  type TransactionPage,
  type TransactionQuery,
} from '@fintech/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { authRequired } from '../../common/errors/app.error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { TransactionsRepository } from './transactions.repository.js';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly repository: TransactionsRepository) {}

  /**
   * 查詢交易明細（cursor 分頁）。
   *
   * ── 前端該怎麼用 ────────────────────────────────────────────
   *
   *   第一次：GET /transactions?limit=30
   *           → { items: [...30 筆], nextCursor: "eyJvY2N1..." }
   *
   *   往下捲：GET /transactions?limit=30&cursor=eyJvY2N1...
   *           → { items: [...30 筆], nextCursor: "eyJvY2N1..." }
   *
   *   到底了：→ { items: [...剩下幾筆], nextCursor: null }
   *              ↑ null 就是停止捲動的訊號
   *
   * **`cursor` 原封不動傳回來就好，不要解析它、不要自己組。**
   * 它是不透明字串（見 cursor.ts 的說明）。
   *
   * @param user 當前身分，由 JwtAuthGuard 注入
   * @param query 查詢條件，已由 zod 驗證與轉型
   * @returns 一頁明細與下一頁的游標
   */
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query(new ZodValidationPipe(transactionQuerySchema)) query: TransactionQuery,
  ): Promise<TransactionPage> {
    if (!user) throw authRequired();
    return this.repository.findPage(user.accountId, query);
  }
}
