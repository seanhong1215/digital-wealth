/**
 * api/src/common/decorators/current-user.decorator.ts — 取得當前登入身分
 *
 * 這個檔案是什麼：
 *   `@CurrentUser()` 參數裝飾器，讓 Controller 直接拿到已驗證的身分。
 *
 * ── 為什麼需要它 ──────────────────────────────────────────────────
 *
 * 沒有它的話，每個 Controller 方法都得這樣寫：
 *
 *     @Get('me')
 *     getMe(@Req() request: Request) {
 *       const user = (request as any).user;   // ← 型別是 any，而且要記得欄位名
 *       return this.service.find(user.accountId);
 *     }
 *
 * 有了它：
 *
 *     @Get('me')
 *     getMe(@CurrentUser() user: AuthenticatedUser) {
 *       return this.service.find(user.accountId);
 *     }
 *
 * 差別不只是短 —— **Controller 不再需要知道身分被放在 request 的哪個欄位**。
 * 那是 Guard 的實作細節，未來要改（例如改放 `request.auth`）
 * 只要動這個檔案，不用改二十個 Controller。
 *
 * ── createParamDecorator 是什麼 ───────────────────────────────────
 *
 * NestJS 讓你自訂「參數要從哪裡取值」。`@Body()`、`@Query()`、`@Param()`
 * 全都是用同一套機制做出來的，這只是我們自己再做一個。
 *
 * ── 這裡的安全前提 ★ ──────────────────────────────────────────────
 *
 * `request.user` 是 **JwtAuthGuard 驗證通過後才寫進去的**。
 * Guard 是全域註冊的，所以任何走到 Controller 的請求，
 * 要嘛已通過驗證、要嘛被標記為 @Public()。
 *
 * 這代表：**Controller 拿到的 accountId 絕對來自 token，
 * 不可能來自前端傳的參數。** 這是本專案防 IDOR 的根本機制 ——
 * 不是「記得要檢查」，而是「根本沒有管道讓前端指定帳戶」。
 *
 * 在架構的哪一層：橫切關注點。
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { type AuthenticatedUser } from '@digital-wealth/shared';

/**
 * Guard 把身分掛在 request 的哪個欄位。
 *
 * 這個常數同時被 JwtAuthGuard（寫入）與這個裝飾器（讀取）使用，
 * 是兩者之間唯一的耦合點。
 */
export const REQUEST_USER_KEY = 'user';

/** 加上身分欄位之後的 Express Request 型別。 */
export interface RequestWithUser extends Request {
  [REQUEST_USER_KEY]?: AuthenticatedUser;
}

/**
 * 取得當前登入者的身分（userId 與 accountId）。
 *
 * 只能用在有經過 JwtAuthGuard 的端點上。
 * 用在 `@Public()` 端點會拿到 undefined —— 這是預期行為，
 * 因為那些端點本來就沒有登入身分。
 *
 * @example
 *   @Get('me')
 *   getMe(@CurrentUser() user: AuthenticatedUser) {
 *     return this.accountsService.findByAccountId(user.accountId);
 *   }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return request[REQUEST_USER_KEY];
  },
);
