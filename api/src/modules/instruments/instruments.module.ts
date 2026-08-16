/**
 * api/src/modules/instruments/instruments.module.ts — 標的模組
 *
 * exports 了 Repository，因為 positions 與 transactions 模組
 * 需要重用它的 row 轉換邏輯與查詢。
 *
 * 在架構的哪一層：業務模組。
 */

import { Module } from '@nestjs/common';

import { InstrumentsController } from './instruments.controller.js';
import { InstrumentsRepository } from './instruments.repository.js';

@Module({
  controllers: [InstrumentsController],
  providers: [InstrumentsRepository],
  exports: [InstrumentsRepository],
})
export class InstrumentsModule {}
