/**
 * api/src/modules/instruments/instruments.controller.ts — 標的查詢端點
 *
 *   GET /api/v1/instruments?q=2330&limit=20
 *   GET /api/v1/instruments/:symbol
 *
 * ── 這個 Controller 為什麼沒有 Service 層 ─────────────────────────
 *
 * 00-architecture.md 的硬性規則是「Controller 不得直接碰資料庫，
 * 一律經由 Service → Repository」。這裡 Controller 直接用 Repository，
 * 看起來像是違規 —— 但注意規則禁止的是**直接碰資料庫**，
 * 而不是「一定要有三層」。
 *
 * 標的查詢沒有任何業務邏輯（不需要計算、不需要權限判斷、
 * 不需要組合多個資料來源），中間再包一層 Service 只會是
 * 一個純轉發的空殼，讓人多讀一個檔案卻什麼也沒學到。
 *
 * ⚠️ 但這是**例外不是常態**。只要開始出現任何判斷
 * （例如「停止交易的標的要不要顯示」變成依使用者角色而定），
 * 就該立刻補上 Service 層。持倉、投組、明細都有 Service，因為它們有邏輯。
 *
 * 在架構的哪一層：HTTP 介面層。
 */

import { Controller, Get, Param, Query } from '@nestjs/common';

import {
  instrumentQuerySchema,
  type Instrument,
  type InstrumentQuery,
} from '@fintech/shared';

import { notFound } from '../../common/errors/app.error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { InstrumentsRepository } from './instruments.repository.js';

@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly repository: InstrumentsRepository) {}

  /**
   * 搜尋標的。
   *
   * 沒帶 `q` 時回傳全部（受 limit 限制）—— 這是刻意的，
   * 下單頁一開啟就該顯示可選清單，不該強迫使用者先打字。
   *
   * @param query 查詢參數，已由 ZodValidationPipe 驗證與轉型
   *              （limit 從字串轉成數字並套用預設值 30、上限 100）
   * @returns 符合條件的標的清單
   */
  @Get()
  async search(
    @Query(new ZodValidationPipe(instrumentQuerySchema)) query: InstrumentQuery,
  ): Promise<Instrument[]> {
    return this.repository.search(query.q, query.limit);
  }

  /**
   * 依代號查單一標的。
   *
   * ── 這裡用 symbol 當路徑參數，而不是 id ──────────────────────
   *
   * 因為對使用者與前端來說，`2330` 才是有意義的識別碼；
   * UUID 是資料庫的內部主鍵。網址 `/instruments/2330` 也比
   * `/instruments/3f2a1b4c-...` 好讀好分享。
   *
   * ⚠️ 這與 `/accounts/me` 的原則不衝突：標的是**公開資料**，
   *    任何登入者都能查任何標的，所以用可猜測的識別碼沒有風險。
   *    帳戶是**私有資料**，才必須從 token 取得身分。
   *
   * @param symbol 股票代號
   * @returns 標的資料
   * @throws {AppError} 代號不存在時（NOT_FOUND，404）
   */
  @Get(':symbol')
  async findOne(@Param('symbol') symbol: string): Promise<Instrument> {
    const instrument = await this.repository.findBySymbol(symbol);

    if (!instrument) {
      throw notFound('標的');
    }
    return instrument;
  }
}
