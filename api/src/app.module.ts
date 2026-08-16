/**
 * api/src/app.module.ts — 根模組
 *
 * 這個檔案是什麼：
 *   整個 NestJS 應用的組裝點。所有模組都要（直接或間接）掛在這裡，
 *   沒掛上來的模組等於不存在。
 *
 * 為什麼存在：
 *   NestJS 的模組系統是一棵樹，這是樹根。框架從這裡開始遞迴地
 *   建立所有 provider、註冊所有路由。
 *
 * ── 讀這個檔案就能知道整個服務有哪些功能 ────────────────────────────
 *
 *   這是 NestJS 架構的一個好處：`imports` 陣列就是服務的功能清單。
 *   下面的註解刻意保留了尚未實作的模組，讓這份清單同時是進度表。
 *
 * 在架構的哪一層：最上層的組裝層，不含任何業務邏輯。
 */

import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({
  imports: [
    // ── 基礎設施（@Global，只需在這裡 import 一次）──────────────────
    DatabaseModule,
    RedisModule,

    // ── 業務模組 ───────────────────────────────────────────────────
    HealthModule,

    // 【後續單元回來加】目錄已建好，等對應單元實作：
    //   AuthModule         → 單元 1.1（JWT 簽發與驗證）
    //   AccountsModule     → 單元 1.1（帳戶、餘額）
    //   InstrumentsModule  → 單元 1.1（標的基本資料）
    //   PositionsModule    → 單元 1.1（持倉、成本）
    //   TransactionsModule → 單元 1.8（明細、cursor 分頁）
    //   QuotesModule       → 單元 2.3（WebSocket Gateway、Redis 訂閱）
    //   OrdersModule       → 單元 3.1（下單：transaction + 行鎖 + 冪等）
    //   DemoModule         → 單元 4.3（故障注入，動態模組）
  ],
})
export class AppModule {}
