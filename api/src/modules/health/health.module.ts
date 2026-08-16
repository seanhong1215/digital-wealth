/**
 * api/src/modules/health/health.module.ts — 健康檢查模組
 *
 * 這個模組的 imports 是空的，因為 DatabaseModule 與 RedisModule 都是
 * `@Global()`，它們的 exports 全域可見，不需要在這裡再 import 一次。
 *
 * 注意這個模組**沒有** `@Global()` —— 業務模組一律不加，
 * 理由見 DatabaseModule 的說明。
 */

import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
