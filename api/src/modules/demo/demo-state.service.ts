/**
 * api/src/modules/demo/demo-state.service.ts — 控制台的當前狀態
 *
 * 這個檔案是什麼：
 *   一個放在記憶體裡的小狀態機：現在是哪個情境、種子是多少、
 *   開了哪些故障。
 *
 * 在架構的哪一層：
 *   Service。但它比較特別 —— 它不屬於任何業務領域，
 *   而是**橫切**在所有請求之上的一個開關。
 *
 * ── 為什麼狀態放記憶體，不放資料庫 ★ ─────────────────────────────
 *
 *   放資料庫的話，每一個被故障注入攔截的請求都要先查一次資料庫
 *   才知道要不要故障 —— 那是給每一個 API 加上一次額外往返，
 *   只為了一個開發用的功能。
 *
 *   而且這個狀態**本來就該是短暫的**：服務重啟後回到預設值是
 *   正確行為，不是遺失資料。面試官關掉電腦隔天再開，
 *   應該看到乾淨的預設情境，而不是昨天留下的「所有 API 都 500」。
 *
 *   代價是多個 api 實例之間狀態不同步 —— 但本專案只跑一個實例
 *   （adr/0004：本機 Docker Compose），這個代價不存在。
 *
 * ── 為什麼這個 Service 「永遠」被註冊，即使控制台關閉 ★ ──────────
 *
 *   DemoModule 是動態模組，關閉時**路由不存在**（回 404）。
 *   但 QuotesGateway 與故障 middleware 需要注入這個 Service ——
 *   如果它跟著模組一起消失，那兩處就要寫成「可選注入」，
 *   然後到處是 `this.demoState?.` 的判斷。
 *
 *   做法是：Service 永遠註冊，但在控制台關閉時**拒絕任何狀態變更**。
 *   於是它永遠回報「預設情境、零故障」，下游完全不必知道
 *   控制台是開是關。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_DEMO_STATE,
  type AccountScenarioValue,
  type DemoState,
  type FaultKindValue,
} from '@digital-wealth/shared';

/**
 * 「控制台是否啟用」的注入 token。
 *
 * ── 為什麼用 token，不用模組層的變數 ★ ──────────────────────────
 *
 *   第一版是在 `DemoModule.forRoot()` 裡寫 `moduleEnabled = options.enabled`，
 *   然後期待 Service 讀得到 —— 但 Service 是由 DI 容器 new 出來的，
 *   它跟那個模組層變數之間**沒有任何連結**。結果是 enabled 永遠是
 *   建構子的預設值 false，所有狀態變更被靜默忽略：
 *   切換情境回 200、狀態卻沒變，完全沒有錯誤訊息。
 *
 *   用 token 讓相依變成顯式的 —— 忘記提供就會在啟動時噴
 *   「Nest can't resolve dependencies」，而不是安靜地不動作。
 */
export const DEMO_ENABLED = Symbol('DEMO_ENABLED');

@Injectable()
export class DemoStateService {
  private readonly logger = new Logger(DemoStateService.name);

  private scenario: AccountScenarioValue = DEFAULT_DEMO_STATE.scenario;
  private seed = DEFAULT_DEMO_STATE.seed;
  private faults = new Set<FaultKindValue>();

  /**
   * 控制台是否啟用。由 `DemoModule.forRoot()` 透過 DI 提供。
   *
   * 關閉時這個 Service 仍然存在，但所有變更都會被忽略 ——
   * 也就是說正式環境下它是一個永遠回傳「沒有故障」的常數。
   */
  constructor(@Inject(DEMO_ENABLED) private readonly enabled: boolean) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  getState(): DemoState {
    return {
      scenario: this.scenario,
      seed: this.seed,
      faults: [...this.faults],
    };
  }

  /**
   * 某個故障是否開著。
   *
   * 這是熱路徑 —— 每一個 HTTP 請求都會呼叫好幾次，
   * 所以用 Set 而不是陣列的 includes()。
   */
  hasFault(kind: FaultKindValue): boolean {
    return this.enabled && this.faults.has(kind);
  }

  setScenario(scenario: AccountScenarioValue, seed?: number): DemoState {
    if (!this.enabled) return this.getState();

    this.scenario = scenario;
    if (seed !== undefined) this.seed = seed;

    this.logger.log(`情境切換為 ${scenario}（種子 ${this.seed}）`);
    return this.getState();
  }

  setFaults(faults: readonly FaultKindValue[]): DemoState {
    if (!this.enabled) return this.getState();

    this.faults = new Set(faults);

    this.logger.log(faults.length === 0 ? '已清除所有故障' : `故障注入：${faults.join('、')}`);
    return this.getState();
  }

  reset(): DemoState {
    if (!this.enabled) return this.getState();

    this.scenario = DEFAULT_DEMO_STATE.scenario;
    this.seed = DEFAULT_DEMO_STATE.seed;
    this.faults.clear();

    this.logger.log('已重設為預設情境');
    return this.getState();
  }
}
