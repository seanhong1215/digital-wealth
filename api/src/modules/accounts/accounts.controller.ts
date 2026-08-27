/**
 * api/src/modules/accounts/accounts.controller.ts — 帳戶查詢端點
 *
 *   GET /api/v1/accounts/me
 *
 * ── 為什麼是 /me 而不是 /:id ★ 本專案最重要的安全設計之一 ─────────
 *
 * 如果寫成 `GET /accounts/:id`，攻擊者只要把網址裡的 id 換掉，
 * 就能看到別人的帳戶餘額。這叫 **IDOR（Insecure Direct Object
 * Reference，不安全的直接物件參考）**，是最常見也最容易犯的授權漏洞。
 *
 * 很多人的解法是「在 Service 裡檢查這個 id 是不是屬於當前使用者」——
 * 可行，但那是**靠人記得要檢查**。漏掉一個端點就破功，
 * 而且漏掉時不會有任何錯誤訊息。
 *
 * 本專案的做法是**從結構上消除這個可能性**：
 * 端點根本不接受 id 參數，帳戶身分只能來自 JWT。
 * 前端沒有管道指定要查誰的帳戶，所以不可能查錯。
 *
 * **「讓錯誤不可能發生」比「記得要檢查」可靠得多。**
 *
 * 在架構的哪一層：HTTP 介面層。
 */

import { Controller, Get } from '@nestjs/common';

import { type Account, type AuthenticatedUser } from '@digital-wealth/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { authRequired } from '../../common/errors/app.error.js';
import { AuthService } from '../auth/auth.service.js';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 取得當前登入者的帳戶資料。
   *
   * ── 與 GET /auth/me 有什麼不同 ──────────────────────────────
   *
   *   /auth/me      回傳 { user, account } —— 用於「我是誰」
   *   /accounts/me  只回傳 account        —— 用於「我有多少錢」
   *
   * 分開的理由是**更新頻率不同**：使用者資料幾乎不變，
   * 但餘額每次下單都會變。前端下單成功後只需要重抓餘額，
   * 不用把使用者資料也重抓一次。
   *
   * TanStack Query 的快取策略可以因此分開設定 —— 這是
   * 「API 切分要看資料的變動頻率，不是看資料的來源表」的實例。
   *
   * @param user 當前身分，由 JwtAuthGuard 注入
   * @returns 帳戶資料，含**最新的**現金餘額
   */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser | undefined): Promise<Account> {
    if (!user) throw authRequired();

    const session = await this.authService.getSession(user.userId);
    return session.account;
  }
}
