/**
 * api/src/modules/demo/demo.service.ts — 情境切換
 *
 * 這個檔案是什麼：
 *   把「切換情境」翻譯成「重建資料庫」。
 *
 * 在架構的哪一層：Service。
 */

import { Injectable, Logger } from '@nestjs/common';

import type { AccountScenarioValue, DemoState } from '@digital-wealth/shared';

import { DatabaseService } from '../../database/database.service.js';
import { applySeed } from '../../database/seeds/seed.js';
import { DemoStateService } from './demo-state.service.js';

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly demoState: DemoStateService,
  ) {}

  /**
   * 切換情境：更新狀態 → 重建資料。
   *
   * ── 為什麼一定要包在 db.transaction() 裡 ★ ──────────────────────
   *
   *   `applySeed()` 會先 `TRUNCATE` 再重新寫入幾千列。這兩件事必須
   *   是**同一個交易**，否則中途失敗（例如連線斷了）會留下一個
   *   「已清空但還沒寫入」的資料庫 —— 面試官看到的是一個空系統，
   *   而且重新整理也救不回來。
   *
   *   `db.transaction()` 會向連線池借一條連線、下 BEGIN、
   *   把那條連線交給我們、結束時 COMMIT 或 ROLLBACK。
   *
   *   ⚠️ 不能改用 `db.query()` 一句一句下 —— 那個方法每次向池子
   *      拿一條新連線，`BEGIN` 和後面的 `INSERT` 會跑在不同連線上，
   *      結果是 BEGIN 開了一個空交易、資料以 autocommit 寫進去。
   *      症狀特別惡劣：**成功時看起來完全正常**，只有失敗時才會發現
   *      「回滾沒有回滾」。
   */
  async switchScenario(scenario: AccountScenarioValue, seed?: number): Promise<DemoState> {
    const next = this.demoState.setScenario(scenario, seed);

    this.logger.log(`重建資料：情境 ${next.scenario}、種子 ${next.seed}`);

    const summary = await this.db.transaction((tx) =>
      applySeed(tx, { scenario: next.scenario, seed: next.seed }),
    );

    this.logger.log(`完成：明細 ${summary.transactionCount} 筆、持倉 ${summary.positionCount} 檔`);

    return next;
  }

  /**
   * 重設：清除故障 ＋ 回到預設情境的資料。
   *
   * 兩件事都要做。只清故障不重建資料的話，面試官在 `heavy-history`
   * 情境下按「重設」，畫面仍然是 8,000 筆 —— 那不叫重設。
   */
  async reset(): Promise<DemoState> {
    const next = this.demoState.reset();
    return this.switchScenario(next.scenario, next.seed);
  }
}
