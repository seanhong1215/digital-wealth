/**
 * api/src/modules/auth/auth.module.ts — 認證模組
 *
 * 這個檔案是什麼：
 *   組裝認證相關的 Controller / Service / Repository，
 *   並設定 JWT 的簽章密鑰與有效期。
 *
 * ── 為什麼標記 @Global() ──────────────────────────────────────────
 *
 * 因為 `JwtAuthGuard` 是**全域註冊**的（見 app.module.ts），
 * 而它需要注入 `JwtService`。全域 Guard 是在根模組的注入容器裡建立的，
 * 拿不到某個子模組私有的 provider。
 *
 * 把 JwtModule 從這裡 export 並標記 @Global()，
 * JwtService 才會出現在全域容器裡讓 Guard 拿得到。
 *
 * ⚠️ 這是 @Global() 的**正當用途**（技術上必要），
 *    而不是為了省打字。業務模組仍然一律不准加。
 *
 * 在架構的哪一層：業務模組。
 */

import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AUTH_TOKEN_TTL_SECONDS } from '@fintech/shared';

import { env } from '../../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';

@Global()
@Module({
  imports: [
    /**
     * JWT 的簽章設定。
     *
     * ── secret（簽章密鑰）★ 最敏感的一個設定 ────────────────────
     *
     * 這把密鑰決定了「誰能簽出有效的 token」。任何人拿到它，
     * 就能偽造出任意身分的 token —— 等於整套認證直接失效。
     *
     * 所以：
     *   1. 它從環境變數讀，**絕不寫死在程式碼裡**
     *      （寫死的話會跟著 git 歷史永久留存，就算之後刪掉也救不回）
     *   2. `.env` 已寫進 .gitignore
     *   3. 產生方式：openssl rand -base64 32
     *
     * ── expiresIn ────────────────────────────────────────────────
     *
     * token 的有效期，24 小時（定義在 shared 的 AUTH_TOKEN_TTL_SECONDS）。
     * 到期後 Guard 的 verifyAsync 會拋錯，前端收到 401 導向登入頁。
     *
     * 為什麼是 24 小時而不是更短：本專案不做 refresh token，
     * 設太短會讓使用者頻繁被登出。真實系統的做法是
     * 「access token 15 分鐘 + refresh token 30 天」，
     * 但那套機制的複雜度遠超本專案的價值（見 docs/02-backend.md）。
     */
    JwtModule.register({
      secret: env.jwtSecret,
      signOptions: {
        expiresIn: AUTH_TOKEN_TTL_SECONDS,
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository],
  exports: [
    // JwtModule 要 export 才能讓全域 Guard 注入 JwtService（見檔頭說明）
    JwtModule,
    // AuthRepository 給其他模組（accounts）查帳戶用
    AuthRepository,
  ],
})
export class AuthModule {}
