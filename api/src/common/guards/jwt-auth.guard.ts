/**
 * api/src/common/guards/jwt-auth.guard.ts — JWT 認證守衛
 *
 * 這個檔案是什麼：
 *   在請求進入 Controller 之前驗證 JWT，通過就把身分掛到 request 上，
 *   不通過就擋下來回 401。
 *
 * ── Guard 是什麼（NestJS，第一次出現）─────────────────────────────
 *
 * Guard 回答一個是非題：**「這個請求可以繼續嗎？」**
 * 回傳 true 就放行，false 或拋錯就擋下。
 *
 * 它在請求生命週期裡的位置：
 *
 *   請求 → Middleware → **Guard** → Pipe → Controller → Service
 *                        ↑
 *                        這裡。在參數驗證(Pipe)之前，
 *                        所以未登入的請求連驗證都不用跑
 *
 * 對照 Spring Boot：≈ Spring Security 的 Filter / `@PreAuthorize`。
 *
 * ── Guard 與 Middleware 的差別（常見混淆）────────────────────────
 *
 *   Middleware  只看得到原始的 request/response，不知道即將執行哪個
 *               Controller 方法
 *   Guard       拿得到 ExecutionContext，**知道目標是哪個方法**，
 *               所以才能讀取該方法上的 @Public() metadata
 *
 * 這正是認證要做成 Guard 而不是 Middleware 的原因。
 *
 * 在架構的哪一層：橫切關注點，全域註冊於 AppModule。
 */

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AUTH_COOKIE_NAME, jwtPayloadSchema } from '@digital-wealth/shared';

import { authRequired } from '../errors/app.error.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUEST_USER_KEY, type RequestWithUser } from '../decorators/current-user.decorator.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  /**
   * @param reflector NestJS 提供的工具，用來讀取裝飾器附加的 metadata
   *                  （這裡是讀 @Public()）
   * @param jwtService @nestjs/jwt 提供的簽發與驗證服務
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 決定請求能否繼續。
   *
   * @param context 執行環境。包含 request，也包含「即將執行哪個方法」
   * @returns 通過時為 true
   * @throws {AppError} 未帶 token、token 無效或過期時（AUTH_REQUIRED）
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── 1. 這個端點有標記 @Public() 嗎 ──────────────────────────
    //
    // getAllAndOverride 會依序查「方法上」與「類別上」的 metadata，
    // 方法優先。這樣就能做到「整個 Controller 公開，但其中一個方法要認證」
    // 這種細緻的控制（本專案還用不到，但機制是這樣）。
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(), // 方法
      context.getClass(), // 類別
    ]);

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // ── 2. 從 cookie 取出 token ─────────────────────────────────
    //
    // ★ 只從 cookie 取，**不接受 Authorization 標頭**。
    //
    // 為什麼要限制來源：本專案的 token 是 httpOnly cookie，
    // 前端 JavaScript 根本讀不到它，所以也不可能把它放進 Authorization 標頭。
    // 如果這裡也接受標頭，等於開了一條「可以用 JS 傳 token」的路 ——
    // 那 httpOnly 的防護就白做了。
    //
    // 需要用 curl 測試時，帶 cookie 即可：
    //   curl -b "access_token=<jwt>" http://localhost:3000/api/v1/accounts/me
    const token = request.cookies?.[AUTH_COOKIE_NAME] as string | undefined;

    if (token === undefined || token === '') {
      throw authRequired();
    }

    // ── 3. 驗證簽章與有效期 ─────────────────────────────────────
    try {
      // verifyAsync 會做兩件事：
      //   (a) 用密鑰重算簽章，確認 token 沒被竄改
      //   (b) 檢查 exp 欄位，過期就拋錯
      //
      // ⚠️ 只有 (a) 通過才代表這個 token 是我們簽發的。
      //    JWT 的 payload 沒有加密，任何人都能改內容 ——
      //    但改了之後簽章就對不上，這一步就會失敗。
      const rawPayload: unknown = await this.jwtService.verifyAsync(token);

      // ── 4. 用 zod 再驗一次 payload 的形狀 ────────────────────
      //
      // 為什麼簽章驗過了還要驗形狀：
      //   簽章保證「這是我們簽的」，不保證「內容長得跟現在的程式碼相容」。
      //
      //   實際會遇到的情況：改版時 payload 加了新欄位，但使用者手上
      //   還拿著舊 token。少了欄位的話，`payload.accountId` 會是
      //   undefined 一路往下傳，最後在某個 SQL 查詢炸掉，
      //   而且錯誤訊息完全看不出跟認證有關。
      //
      //   在這裡驗，問題會變成一個乾淨的 401「請重新登入」。
      const payload = jwtPayloadSchema.parse(rawPayload);

      // ── 5. 把身分掛到 request 上 ─────────────────────────────
      //
      // 之後 @CurrentUser() 裝飾器會從這裡讀出來。
      // 只放兩個 id，不放整個 payload —— Controller 需要的就這些。
      request[REQUEST_USER_KEY] = {
        userId: payload.sub,
        accountId: payload.accountId,
      };

      return true;
    } catch {
      // 簽章錯誤、過期、payload 形狀不對 —— 一律回同一個錯誤。
      //
      // ⚠️ **刻意不區分是哪一種**。對前端來說處理方式完全一樣
      //    （導向登入頁），而告訴攻擊者「你的簽章錯了」還是
      //    「你的 token 過期了」對他來說是有用的資訊。
      throw authRequired();
    }
  }
}
