/**
 * api/src/modules/health/health.controller.ts — 健康檢查端點
 *
 * 這個檔案是什麼：
 *   `GET /api/v1/health` —— 回報服務本身與其相依（PostgreSQL、Redis）的狀態。
 *
 * 為什麼第一個做的端點是它：
 *   1. 它是**最小的端到端驗證** —— 能回應就代表 NestJS 啟動、路由註冊、
 *      DI 注入、資料庫連線這一整條鏈路都通了
 *   2. Docker Compose 的 healthcheck 需要它。有了它，
 *      `depends_on: condition: service_healthy` 才有意義
 *   3. 它不需要認證、不碰業務邏輯，是驗證骨架的理想對象
 *
 * ── `@Controller()` 是什麼（NestJS 第一次出現）──────────────────────
 *
 * Controller 負責**處理 HTTP 請求**，職責只有三件事：
 *   1. 解析請求（路徑參數、query、body）
 *   2. 呼叫 Service
 *   3. 回傳結果
 *
 * **Controller 不得直接碰資料庫** —— 這是 00-architecture.md 的硬性分層規則。
 * 這個檔案是唯一的例外情況：健康檢查本來就是在測基礎設施，
 * 中間再包一層 Service 只會多一層沒有邏輯的轉發。
 *
 * `@Controller('health')` 的參數是路由前綴。搭配 main.ts 設定的
 * 全域前綴 `api/v1`，完整路徑就是 `/api/v1/health`。
 *
 * 對照 Spring Boot：`@Controller` ≈ `@RestController`，
 * `@Get()` ≈ `@GetMapping`。觀念一對一。
 */

import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

import { DatabaseService } from '../../database/database.service.js';
import { RedisService } from '../../redis/redis.service.js';

/** 單一相依的健康狀態。 */
interface DependencyHealth {
  /** `up` 代表可連線，`down` 代表連不上 */
  readonly status: 'up' | 'down';
}

/** 健康檢查的回應形狀。 */
interface HealthResponse {
  /**
   * 整體狀態。
   *
   * - `ok`       全部相依正常
   * - `degraded` PostgreSQL 正常但 Redis 掛了 —— **服務仍可用**，
   *              只是即時報價不會動。這個狀態的存在本身就是
   *              「降級是設計的一部分」的證據
   * - `down`     PostgreSQL 掛了，服務實質不可用
   */
  readonly status: 'ok' | 'degraded' | 'down';
  /** 回應產生的時間，ISO 8601 格式（後端一律回原始值，不做格式化） */
  readonly at: string;
  readonly dependencies: {
    readonly postgres: DependencyHealth;
    readonly redis: DependencyHealth;
  };
}

@Controller('health')
export class HealthController {
  /**
   * ── 這個 constructor 就是依賴注入 ─────────────────────────────────
   *
   * 我們沒有寫 `new DatabaseService()`，只是宣告「我需要這兩個東西」。
   * NestJS 在啟動時讀取參數的型別（靠 SWC 的 decoratorMetadata 產生的
   * 型別資訊，見 api/.swcrc），從容器裡找出對應的實例傳進來。
   *
   * `private readonly` 是 TypeScript 的參數屬性語法糖，
   * 等同於「宣告一個私有唯讀欄位，並在 constructor 裡指派」。
   */
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 回報服務健康狀態。
   *
   * **無論相依是否正常，這個端點都回 200。** 這是刻意的：
   * 回應內容才是判斷依據，HTTP 狀態碼只代表「健康檢查本身執行成功」。
   * 如果 Redis 掛掉就回 503，Docker 會判定容器不健康而重啟它 ——
   * 但重啟 api 並不會修好 Redis，只會讓服務反覆重啟。
   *
   * @returns 各相依的連線狀態
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async check(): Promise<HealthResponse> {
    // 兩個檢查互不相依，用 Promise.all 並行執行。
    // 序列執行的話，兩個都逾時會花兩倍的時間。
    const [postgresUp, redisUp] = await Promise.all([this.database.ping(), this.redis.ping()]);

    return {
      status: !postgresUp ? 'down' : redisUp ? 'ok' : 'degraded',
      at: new Date().toISOString(),
      dependencies: {
        postgres: { status: postgresUp ? 'up' : 'down' },
        redis: { status: redisUp ? 'up' : 'down' },
      },
    };
  }
}
