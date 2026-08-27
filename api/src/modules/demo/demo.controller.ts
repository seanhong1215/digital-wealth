/**
 * api/src/modules/demo/demo.controller.ts — Demo 控制台端點
 *
 *   GET  /api/v1/demo/state      取得當前情境與故障設定
 *   POST /api/v1/demo/scenario   切換情境（會重建資料）
 *   POST /api/v1/demo/faults     設定故障注入
 *   POST /api/v1/demo/reset      回到預設並清除所有故障
 *
 * 在架構的哪一層：HTTP 介面層。
 *
 * ── 為什麼這些端點是 @Public()（不需要登入）★ ────────────────────
 *
 *   看起來很危險，但想清楚就知道必須這樣：
 *
 *     1. `new-user` 情境會**重建整個資料庫**，包含使用者表。
 *        重建之後舊的 JWT 指向一個已經不存在的 user id ——
 *        如果切換情境需要登入，切完就再也不能切了（永遠 401）
 *
 *     2. 整個模組在正式環境**根本不會被註冊**（見 demo.module.ts），
 *        路由不存在，也就沒有「未授權存取」這回事
 *
 *   換句話說，安全性不是靠這一層的認證來保證，而是靠
 *   「這些路由在正式環境不存在」。那是更強的保證 ——
 *   認證會有 bug，不存在的路由不會。
 */

import { Body, Controller, Get, Post } from '@nestjs/common';

import {
  setFaultsSchema,
  setScenarioSchema,
  type DemoState,
  type SetFaultsRequest,
  type SetScenarioRequest,
} from '@digital-wealth/shared';

import { Public } from '../../common/decorators/public.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { DemoService } from './demo.service.js';
import { DemoStateService } from './demo-state.service.js';

@Public()
@Controller('demo')
export class DemoController {
  constructor(
    private readonly demoService: DemoService,
    private readonly demoState: DemoStateService,
  ) {}

  /** 當前狀態。前端載入時呼叫一次，用來還原控制台面板。 */
  @Get('state')
  state(): DemoState {
    return this.demoState.getState();
  }

  /**
   * 切換帳戶情境。
   *
   * ⚠️ 這會**清空並重建**整個資料庫。下過的單、切換前的所有變更
   *    都會消失 —— 這是預期行為，情境的意義就是「一個乾淨的起點」。
   */
  @Post('scenario')
  async setScenario(
    @Body(new ZodValidationPipe(setScenarioSchema)) request: SetScenarioRequest,
  ): Promise<DemoState> {
    return this.demoService.switchScenario(request.scenario, request.seed);
  }

  /**
   * 設定故障注入。傳空陣列等於全部關閉。
   *
   * 用「整份取代」而不是「逐項開關」（`POST /faults/:kind/enable`），
   * 是因為前端的面板本來就持有完整清單 —— 送整份過來，
   * 前後端狀態不可能不同步。逐項開關則會有「漏掉一個請求就對不上」
   * 的風險。
   */
  @Post('faults')
  setFaults(
    @Body(new ZodValidationPipe(setFaultsSchema)) request: SetFaultsRequest,
  ): DemoState {
    return this.demoState.setFaults(request.faults);
  }

  /** 回到預設情境並清除所有故障。面試官弄亂之後的「還原」按鈕。 */
  @Post('reset')
  async reset(): Promise<DemoState> {
    return this.demoService.reset();
  }
}
