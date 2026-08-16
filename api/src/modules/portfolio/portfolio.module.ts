/**
 * api/src/modules/portfolio/portfolio.module.ts — 投組模組
 *
 * 同時提供 /portfolio 與 /positions 兩組路由 ——
 * 它們共用同一個 Service 與 Repository，只是 HTTP 入口分開
 * （理由見 positions.controller.ts 的說明）。
 *
 * 在架構的哪一層：業務模組。
 */

import { Module } from '@nestjs/common';

import { PositionsController } from '../positions/positions.controller.js';
import { PortfolioController } from './portfolio.controller.js';
import { PortfolioRepository } from './portfolio.repository.js';
import { PortfolioService } from './portfolio.service.js';

@Module({
  controllers: [PortfolioController, PositionsController],
  providers: [PortfolioService, PortfolioRepository],
  exports: [PortfolioService],
})
export class PortfolioModule {}
