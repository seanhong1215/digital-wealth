/**
 * api/src/modules/orders/orders.controller.ts — 下單端點
 *
 *   POST /api/v1/orders/preview   試算費用
 *   POST /api/v1/orders           送出委託
 *   GET  /api/v1/orders/:id       查詢委託
 *
 * 在架構的哪一層：
 *   HTTP 介面層。這個檔案裡**沒有任何業務邏輯** —— 它只做三件事：
 *   驗證輸入（交給 ZodValidationPipe）、取出身分（交給 CurrentUser）、
 *   呼叫 Service。所有「錢怎麼算、能不能下單」都在 Service。
 *
 * ── 路由順序的坑 ★ ────────────────────────────────────────────────
 *
 *   `@Post('preview')` 必須寫在 `@Get(':id')` 之前嗎？
 *   在這裡不必 —— 一個是 POST 一個是 GET，不會相撞。
 *
 *   但如果哪天加了 `GET /orders/preview`，它就會被 `GET /orders/:id`
 *   吃掉（NestJS 依註冊順序比對，`:id` 會匹配到字串 "preview"）。
 *   規則是：**靜態路徑一律寫在動態路徑之前**。
 */

import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import {
  createOrderSchema,
  orderDraftSchema,
  type AuthenticatedUser,
  type CreateOrderRequest,
  type Execution,
  type Order,
  type OrderDraft,
  type OrderPreview,
  type OrderResult,
} from '@fintech/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { authRequired } from '../../common/errors/app.error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * 試算費用。確認頁進來時呼叫一次。
   *
   * 為什麼是 POST 而不是 GET —— 它明明沒有副作用？
   *   因為請求本體有四個欄位（標的、方向、股數、價格），塞進 query string
   *   會很難讀，而且 GET 的 body 在很多代理伺服器上會被丟掉。
   *   「POST 但無副作用」在 RPC 風格的端點上是可接受的取捨。
   */
  @Post('preview')
  async preview(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body(new ZodValidationPipe(orderDraftSchema)) draft: OrderDraft,
  ): Promise<OrderPreview> {
    if (!user) throw authRequired();
    return this.ordersService.preview(draft);
  }

  /**
   * 送出委託。
   *
   * ⚠️ 注意 request body 裡**沒有 accountId** —— 帳戶身分一律從 JWT 取得。
   *    如果讓前端傳，攻擊者改一個 UUID 就能用別人的錢下單（IDOR）。
   *    「根本沒有管道可以指定別人的帳戶」比「記得要檢查」可靠得多。
   */
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body(new ZodValidationPipe(createOrderSchema)) request: CreateOrderRequest,
  ): Promise<OrderResult> {
    if (!user) throw authRequired();
    return this.ordersService.create(user.accountId, request);
  }

  /**
   * 查詢單一委託。
   *
   * 結果頁的網址是 `/trade/2330/result?orderId=...`，重新整理後
   * 前端靠這個端點把畫面還原 —— 這是「結果頁要能用連結分享」
   * 這個設計決策的後端支撐（見 docs/adr/0008）。
   */
  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id') id: string,
  ): Promise<{ order: Order; executions: Execution[] }> {
    if (!user) throw authRequired();
    return this.ordersService.findById(user.accountId, id);
  }
}
