/**
 * api/src/modules/demo/demo.module.ts — Demo 控制台（動態模組）
 *
 * 在架構的哪一層：業務模組。但它是全專案唯一的**動態模組**。
 *
 * ── 什麼是動態模組，為什麼這裡需要 ★ ─────────────────────────────
 *
 *   一般的 Module 是靜態的：`@Module({...})` 寫死了有哪些 controller
 *   與 provider。動態模組則是一個**回傳模組定義的函式**，
 *   可以依參數決定要註冊什麼。
 *
 *   這裡需要它，是因為控制台在正式環境**必須完全消失**。
 *   常見的三種做法，只有第三種是對的：
 *
 *     ❌ 掛上去，用 Guard 擋
 *        路由存在，回 403。攻擊者知道「這裡有東西」，
 *        而且 Guard 有 bug 就全開了
 *
 *     ❌ 掛上去，在每個 handler 開頭 if (!enabled) throw
 *        同上，而且判斷散在五個地方，漏一個就破功
 *
 *     ✅ 根本不註冊
 *        路由不存在，回 404 —— 與「這個系統沒有這個功能」
 *        完全無法區分。這是最強的保證：認證會有 bug，
 *        不存在的路由不會
 *
 * ── 為什麼 DemoStateService 不管開關都要註冊 ★ ────────────────────
 *
 *   因為 QuotesGateway 要注入它（判斷 quote-disconnect 故障）。
 *   如果 Service 跟著模組一起消失，Gateway 就要寫成可選注入，
 *   然後到處是 `this.demoState?.hasFault(...)` 的判斷 ——
 *   為了一個開發功能污染正式程式碼。
 *
 *   做法是 Service 永遠註冊，但關閉時它拒絕任何狀態變更、
 *   永遠回報「沒有故障」。下游完全不必知道控制台是開是關。
 *
 * 相關文件：README 第 9 節
 */

import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';

import { DemoController } from './demo.controller.js';
import { DemoService } from './demo.service.js';
import { DEMO_ENABLED, DemoStateService } from './demo-state.service.js';
import { FaultInjectionMiddleware } from './fault-injection.middleware.js';

/** 模組建立時是否啟用控制台。由 app.module.ts 依環境變數決定。 */
let moduleEnabled = false;

@Module({})
export class DemoModule implements NestModule {
  /**
   * 建立模組定義。
   *
   * @param options.enabled 為 false 時不註冊 controller 與 middleware，
   *                        只留下 DemoStateService（永遠回報無故障）
   */
  static forRoot(options: { enabled: boolean }): DynamicModule {
    moduleEnabled = options.enabled;

    return {
      module: DemoModule,

      // ★ @Global：讓 DemoStateService 不必被 import 就能注入。
      //
      //   QuotesModule 需要它，但 QuotesModule 不該 import DemoModule ——
      //   那會讓「即時報價」在型別上依賴「開發用的控制台」，
      //   是很糟的依賴方向。設成 Global 之後依賴只存在於 DI 容器裡，
      //   模組之間沒有 import 關係。
      global: true,

      // 關閉時 controllers 是空陣列 → 路由根本不存在 → 404
      controllers: options.enabled ? [DemoController] : [],

      providers: [
        // 開關本身也是一個 provider。這讓 DemoStateService 的相依
        // 變成顯式的 —— 忘記提供會在啟動時就爆，而不是靜默失效。
        { provide: DEMO_ENABLED, useValue: options.enabled },
        DemoStateService,
        ...(options.enabled ? [DemoService, FaultInjectionMiddleware] : []),
      ],

      exports: [DemoStateService],
    };
  }

  /**
   * 掛上故障注入 middleware。
   *
   * `forRoutes('*')` 是全域攔截 —— 每一個請求都會先經過它。
   * middleware 自己會豁免 `/demo` 與 `/health`
   * （理由見 fault-injection.middleware.ts）。
   *
   * ⚠️ NestJS 會對**每一個**註冊的模組呼叫 `configure()`，
   *    不管它是不是動態建立的。所以這裡必須自己再檢查一次開關 ——
   *    少了這個判斷，關閉控制台時 middleware 仍然會被掛上去，
   *    然後在啟動時因為 FaultInjectionMiddleware 沒有被註冊成 provider
   *    而拋出 DI 錯誤。
   */
  configure(consumer: MiddlewareConsumer): void {
    if (!moduleEnabled) return;
    consumer.apply(FaultInjectionMiddleware).forRoutes('*');
  }
}
