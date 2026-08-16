/**
 * api/src/redis/redis.service.ts — Redis 連線
 *
 * 這個檔案是什麼：
 *   管理與 Redis 的連線，目前只提供連線本身與健康檢查。
 *
 * 為什麼這個服務需要 Redis（只有兩個理由，多一個都不行）：
 *
 *   1. **報價 pub/sub 扇出**（Phase 2）
 *      market-feed 服務 publish 報價 → api 訂閱 → 廣播給所有 WebSocket 連線
 *
 *   2. **下單冪等鍵**（Phase 3）
 *      `SET idem:{key} NX EX 300` —— 擋掉使用者連點兩次確認鈕
 *
 *   ADR 0003 說得很直接：沒有這兩個理由就該砍掉 Redis。
 *   面試時被問「為什麼需要 Redis」而答不出來，比不用還扣分。
 *
 * ⚠️ **Redis 不是本專案的權威資料來源。** 帳戶餘額、持倉、交易明細
 *    一律以 PostgreSQL 為準。Redis 掛掉時，除了即時報價之外的功能
 *    都必須還能用（降級原則，見 docs/02-backend.md 的報價新鮮度狀態機）。
 *
 * 在架構的哪一層：基礎設施層，與 DatabaseService 平行。
 */

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

import { env } from '../config/env.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /**
   * Redis 客戶端。
   *
   * ⚠️ **Redis 的訂閱模式會獨佔連線** —— 一條連線一旦進入 subscribe 狀態，
   *    就不能再拿來下一般指令了。所以 Phase 2 做報價訂閱時，
   *    必須用 `client.duplicate()` 另外開一條專用連線，不能共用這一條。
   *    這是新手最常踩的坑，先寫在這裡備忘。
   */
  private readonly client: RedisClientType = createClient({
    url: `redis://${env.redis.host}:${env.redis.port}`,

    socket: {
      /**
       * 重連策略：指數退避，上限 3 秒。
       *
       * `retries` 是已經失敗幾次，回傳值是「下次隔多久再試（毫秒）」。
       * 不設上限的話，斷線久一點之後間隔會長到幾分鐘，
       * Redis 明明已經恢復卻遲遲不重連。
       */
      reconnectStrategy: (retries: number) => Math.min(retries * 200, 3_000),
    },
  });

  /**
   * 取得底層客戶端，供其他服務下指令用。
   *
   * 目前沒有使用者 —— 它是為 Phase 2（pub/sub）與 Phase 3（冪等鍵）預留的。
   * 屆時 QuotesGateway 與 OrdersService 會透過這個方法拿到 client。
   */
  getClient(): RedisClientType {
    return this.client;
  }

  /**
   * 建立連線。
   *
   * 與 DatabaseService 不同，Redis 連不上時**只記錄警告、不讓服務啟動失敗**。
   *
   * 為什麼差別待遇：
   *   PostgreSQL 是權威資料來源，連不上的話所有 API 都沒有意義，
   *   服務起來也只是浪費資源。
   *   Redis 只影響即時報價與冪等的快速路徑 —— 沒有它，
   *   使用者仍然可以查詢持倉、看明細、甚至下單（冪等還有資料庫的
   *   UNIQUE 約束當第二道防線）。
   *
   *   **這個差別本身就是「降級是設計的一部分」的實例。**
   */
  async onModuleInit(): Promise<void> {
    // 連線錯誤事件如果沒有監聽者，node-redis 會把它變成
    // unhandled error 直接讓行程崩潰。所以這行必須在 connect 之前註冊。
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis 連線錯誤：${error.message}`);
    });

    try {
      await this.client.connect();
      this.logger.log(`Redis 連線成功：${env.redis.host}:${env.redis.port}`);
    } catch (error) {
      this.logger.warn(
        `Redis 連線失敗，服務仍會啟動但即時報價功能不可用：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 關閉連線。
   *
   * 用 `disconnect()` 而不是 `quit()`：`quit()` 會等待所有 pending 指令完成，
   * 但如果連線本來就是斷的，它會一直等到逾時，讓服務關不掉。
   * 關閉流程要能在任何狀態下都成功結束。
   */
  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.disconnect();
    }
    this.logger.log('Redis 連線已關閉');
  }

  /**
   * 健康檢查。
   *
   * @returns Redis 可用時為 true，任何錯誤都回傳 false（不拋出）
   */
  async ping(): Promise<boolean> {
    try {
      if (!this.client.isOpen) return false;
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }
}
