/**
 * api/src/modules/transactions/transactions.module.ts — 明細模組
 *
 * 沒有 Service 層 —— 目前這個模組只做「撈資料」，沒有任何業務判斷。
 * 出現邏輯（例如明細的分類彙總、月結報表）時再補上。
 * 理由同 instruments.controller.ts 的說明。
 *
 * 在架構的哪一層：業務模組。
 */

import { Module } from '@nestjs/common';

import { TransactionsController } from './transactions.controller.js';
import { TransactionsRepository } from './transactions.repository.js';

@Module({
  controllers: [TransactionsController],
  providers: [TransactionsRepository],
})
export class TransactionsModule {}
