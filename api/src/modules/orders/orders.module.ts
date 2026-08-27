/**
 * api/src/modules/orders/orders.module.ts — 下單模組
 *
 * 這個模組同時依賴 DatabaseModule 與 RedisModule ——
 * 它是全專案唯一同時用到兩者的模組，因為冪等鍵在 Redis、
 * 交易一致性在 PostgreSQL（見 docs/adr/0003：Redis 只承擔兩個職責，
 * 這是其中之一）。
 *
 * 在架構的哪一層：業務模組。
 */

import { Module } from '@nestjs/common';

import { OrdersController } from './orders.controller.js';
import { OrdersRepository } from './orders.repository.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
