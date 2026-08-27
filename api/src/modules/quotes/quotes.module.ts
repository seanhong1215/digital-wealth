/**
 * api/src/modules/quotes/quotes.module.ts — 即時報價模組
 *
 * 這個模組只有一個 provider（Gateway），沒有 Controller ——
 * 它完全不走 HTTP，所有互動都在 WebSocket 上。
 *
 * 在架構的哪一層：業務模組。
 */

import { Module } from '@nestjs/common';

import { QuotesGateway } from './quotes.gateway.js';

@Module({
  providers: [QuotesGateway],
})
export class QuotesModule {}
