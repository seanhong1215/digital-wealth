/**
 * api/src/app.module.ts — 根模組
 *
 * 這個檔案是什麼：
 *   整個 NestJS 應用的組裝點。所有模組都要（直接或間接）掛在這裡，
 *   沒掛上來的模組等於不存在。
 *
 * ── 讀這個檔案就能知道整個服務有哪些功能 ────────────────────────
 *
 *   這是 NestJS 架構的一個好處：`imports` 陣列就是服務的功能清單。
 *   下面的註解刻意保留了尚未實作的模組，讓這份清單同時是進度表。
 *
 * 在架構的哪一層：最上層的組裝層，不含任何業務邏輯。
 */

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { DatabaseModule } from './database/database.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InstrumentsModule } from './modules/instruments/instruments.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PortfolioModule } from './modules/portfolio/portfolio.module.js';
import { QuotesModule } from './modules/quotes/quotes.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({
  imports: [
    // ── 基礎設施（@Global，只需在這裡 import 一次）──────────────────
    DatabaseModule,
    RedisModule,

    // ── 業務模組 ───────────────────────────────────────────────────
    HealthModule, //       GET  /health
    AuthModule, //         POST /auth/login｜/auth/logout｜GET /auth/me
    AccountsModule, //     GET  /accounts/me
    InstrumentsModule, //  GET  /instruments｜/instruments/:symbol
    PortfolioModule, //    GET  /portfolio/summary｜/portfolio/snapshots｜/positions
    TransactionsModule, // GET  /transactions
    OrdersModule, //       POST /orders｜/orders/preview｜GET /orders/:id
    QuotesModule, //       WS   /ws/quotes（即時報價）

    // 【後續單元回來加】目錄已建好，等對應單元實作：
    //   DemoModule    → 單元 4.3（故障注入，動態模組）
  ],

  providers: [
    /**
     * ── 全域 Guard：預設全部端點都要認證 ★ ────────────────────────
     *
     * `APP_GUARD` 是 NestJS 提供的特殊 token。用它註冊的 Guard 會套用到
     * **每一個端點**，不需要在每個 Controller 寫 `@UseGuards(...)`。
     *
     * 為什麼要「預設認證、例外才公開」而不是反過來：
     *
     *   忘記加 Guard   → API 裸奔，任何人都能讀別人的帳戶，
     *                    而且**不會有任何錯誤，你永遠不會發現**
     *   忘記加 @Public → 登入頁打不開回 401，第一次測試就發現
     *
     * **讓失誤往「拒絕」的方向倒，而不是往「放行」。**
     * 這叫 fail-safe / secure by default。
     *
     * 目前只有 POST /auth/login、POST /auth/logout、GET /health
     * 標記了 @Public()。
     *
     * 用 provider 的形式註冊（而不是 main.ts 的 app.useGlobalGuards）
     * 是因為這個 Guard 需要注入 Reflector 與 JwtService ——
     * 只有走 DI 容器才拿得到。
     */
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },

    /**
     * ── 全域 Exception Filter：統一錯誤回應格式 ────────────────────
     *
     * 所有未被接住的錯誤都會經過它，翻譯成同一個形狀：
     *
     *   { error: { code, message, details?, traceId } }
     *
     * 前端只要檢查 `error.code` 就好，不用為每種錯誤來源各寫一套解析。
     *
     * 同樣用 provider 形式註冊，理由與 Guard 相同（未來要注入服務時
     * 才不用改註冊方式）。
     */
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
