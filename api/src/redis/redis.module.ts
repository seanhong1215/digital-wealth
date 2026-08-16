/**
 * api/src/redis/redis.module.ts — Redis 模組
 *
 * 與 DatabaseModule 同樣標記為 `@Global()`，理由也相同：
 * 它是基礎設施而非業務邏輯，幾乎每個需要即時或冪等的模組都會用到。
 *
 * 在架構的哪一層：基礎設施層。
 */

import { Global, Module } from '@nestjs/common';

import { RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
