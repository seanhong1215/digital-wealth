/**
 * api/src/modules/auth/auth.controller.ts — 認證端點
 *
 * 這個檔案是什麼：
 *   登入、登出、取得當前身分三個端點。
 *
 *   POST /api/v1/auth/login
 *   POST /api/v1/auth/logout
 *   GET  /api/v1/auth/me
 *
 * ── 這是唯一會碰到 cookie 的地方 ──────────────────────────────────
 *
 * Controller 的職責是「HTTP 的事」，而 cookie 就是純粹的 HTTP 機制。
 * AuthService 只負責「驗密碼、簽 token」，完全不知道 token 最後
 * 是放在 cookie、標頭還是回應主體裡。
 *
 * 這個分工的好處：未來要改成 Bearer token（例如給手機 App 用），
 * 只要改這個檔案，Service 一行都不用動。
 *
 * 在架構的哪一層：HTTP 介面層。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { CookieOptions, Response } from 'express';

import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_TTL_SECONDS,
  loginRequestSchema,
  type AuthenticatedUser,
  type AuthSession,
  type LoginRequest,
} from '@digital-wealth/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { authRequired } from '../../common/errors/app.error.js';
import { isProduction } from '../../config/env.js';
import { AuthService } from './auth.service.js';

/**
 * 存放 JWT 的 cookie 設定。★ 每個選項都在防一種攻擊
 *
 *   httpOnly  JavaScript 讀不到這個 cookie。
 *             ★ **這是整組設定裡最重要的一個。**
 *             只要頁面上有任何 XSS 漏洞（例如渲染了未逃逸的使用者輸入），
 *             攻擊者一行 `document.cookie` 或 `localStorage.getItem('token')`
 *             就能把身分偷走。httpOnly 從瀏覽器層級阻止這件事。
 *
 *   sameSite  跨站請求不帶這個 cookie，用來防 CSRF。
 *             'lax' 允許「使用者點連結進來」這種頂層導航帶 cookie
 *             （否則從別的網站點連結進來會變成未登入狀態），
 *             但擋掉 <img>、<form> 這類由別的網站發起的請求。
 *
 *   secure    只在 HTTPS 連線時傳送。
 *             本機開發是 http://localhost，開了會導致 cookie 完全不生效，
 *             所以只在正式環境開啟。
 *
 *   path      限制 cookie 只送給 /api 底下的路徑。
 *             前端靜態資源的請求就不會白白帶上 token。
 *
 *   maxAge    存活時間（毫秒）。與 JWT 本身的 exp 設成一致 ——
 *             ⚠️ 兩者是**獨立**的機制：cookie 過期是瀏覽器不再送，
 *             JWT 過期是後端不再接受。只設一個的話會出現
 *             「cookie 還在但 token 已失效」的怪狀態。
 */
const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  path: '/api',
  maxAge: AUTH_TOKEN_TTL_SECONDS * 1000,
};

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 登入。驗證帳密，成功則下發 httpOnly cookie。
   *
   * `@Public()` 是必要的 —— 還沒登入的人當然不可能通過認證，
   * 沒標記的話這個端點會回 401，變成永遠登不進來。
   *
   * `@Res({ passthrough: true })` 的 passthrough 很關鍵：
   *   不加的話，一旦注入 response 物件，NestJS 就把回應的控制權
   *   完全交給你 —— 你必須自己呼叫 `res.json(...)`，
   *   而且回傳值會被忽略（症狀是請求卡住不回應）。
   *   加上 passthrough 之後，你可以用 res 設 cookie，
   *   同時仍然用 `return` 讓 NestJS 處理回應主體。
   *
   * @param body 登入請求，已由 ZodValidationPipe 驗證
   * @param response Express 的回應物件，用來設定 cookie
   * @returns 使用者與帳戶資料（**不含 token**）
   * @throws {AppError} 帳密錯誤時（AUTH_INVALID_CREDENTIALS，401）
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    const { token, session } = await this.authService.login(body);

    response.cookie(AUTH_COOKIE_NAME, token, AUTH_COOKIE_OPTIONS);

    // ⚠️ 回傳的資料**刻意不含 token**。
    //    token 只存在於 Set-Cookie 標頭裡，前端 JavaScript 拿不到 ——
    //    這正是 httpOnly 的意義。如果這裡順手回傳一份，
    //    前端就會有人把它存進 localStorage，整套防護就破功了。
    return session;
  }

  /**
   * 登出。清除 cookie。
   *
   * ── 為什麼登出這麼簡單（不用去資料庫做什麼）──────────────────
   *
   * 因為 **JWT 是無狀態的**：後端不保存任何 session，
   * 驗證完全靠簽章。所以「登出」就只是讓瀏覽器不再帶著那個 token。
   *
   * ⚠️ **代價：被清掉的 token 在到期前仍然是有效的。**
   *    如果它在登出前已經被偷走，攻擊者還能用到 24 小時後。
   *
   *    真實系統會用「撤銷清單」（把已登出的 token id 存進 Redis，
   *    Guard 每次檢查）來解決，但那等於把無狀態的好處丟掉一半。
   *    本專案是單一 demo 帳號、本機部署，接受這個取捨 ——
   *    **README 要寫明這是刻意的決定**，而不是不知道有這回事。
   *
   * `@Public()` 是為了讓 token 已過期的使用者也能正常登出
   * （否則會卡在「登不出去因為沒登入」的荒謬狀態）。
   *
   * 回傳 204 No Content —— 沒有東西要回，就不要回一個空物件。
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) response: Response): void {
    // clearCookie 的選項必須與當初 set 時**完全一致**（尤其是 path），
    // 否則瀏覽器會認為那是不同的 cookie 而清不掉 ——
    // 症狀是「按了登出但重整之後還是登入狀態」，很難查。
    response.clearCookie(AUTH_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/api',
    });
  }

  /**
   * 取得當前登入者的身分。
   *
   * 前端重整頁面後會呼叫這個 —— cookie 還在，但記憶體裡的使用者狀態
   * 沒了，需要重新取得。
   *
   * 它同時也是「我還在登入狀態嗎」的檢查：回 200 就是還在，
   * 回 401 就是該導向登入頁了。
   *
   * @param user 當前身分，由 JwtAuthGuard 驗證後注入
   * @returns 使用者與帳戶資料（含**最新的**餘額）
   * @throws {AppError} 未登入時（由 Guard 拋出，401）
   */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser | undefined): Promise<AuthSession> {
    // 理論上走到這裡 user 一定存在（Guard 沒放行的話根本到不了）。
    // 但 TypeScript 不知道這件事 —— 對它來說 @CurrentUser() 的型別
    // 就是可能為 undefined。
    //
    // 與其用 `user!` 把檢查關掉，不如明確處理：萬一哪天 Guard 的
    // 註冊被誤刪，這裡會拋出乾淨的 401，而不是一個
    // 「Cannot read property 'userId' of undefined」的 500。
    if (!user) throw authRequired();

    return this.authService.getSession(user.userId);
  }
}
