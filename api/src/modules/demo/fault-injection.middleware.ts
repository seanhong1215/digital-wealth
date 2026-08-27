/**
 * api/src/modules/demo/fault-injection.middleware.ts — 故障注入
 *
 * 這個檔案是什麼：
 *   一個 Express middleware。它在請求到達任何 Controller **之前**
 *   攔下來，依照控制台的設定製造失敗。
 *
 * 在架構的哪一層：
 *   最外層，比 Guard 還前面。這個位置是刻意的 ——
 *   故障要發生在「業務邏輯完全還沒開始」的地方，
 *   才像是真的網路或伺服器出問題。
 *
 * ── 為什麼故障要在後端注入，不在前端 mock ★ ─────────────────────
 *
 *   前端 mock（例如 MSW 攔截 fetch）比較好寫，但它測到的東西不對：
 *
 *     · mock 攔截的是**前端自己的網路層**。前端的錯誤處理程式碼
 *       在這種情況下有機會「知道自己在被測試」—— 只要有任何一處
 *       依賴了 mock 才有的行為，那段程式碼上線就會壞
 *     · 真實的 500 會經過瀏覽器、代理、nginx。mock 全部跳過
 *
 *   放在後端之後，前端**完全無法分辨**這是注入的故障還是真的爆了。
 *   而「前端無法分辨」正是這個設計要證明的事情：分層是乾淨的。
 *
 * ── 為什麼是 middleware，不是 Interceptor 或 Filter ────────────
 *
 *     Middleware    ✅ 在所有東西之前。可以直接把連線砍掉（模擬逾時），
 *                      也可以在 Guard 執行前就回 500
 *     Guard         只能決定「放行或拒絕」，回傳的是 403，不能自訂
 *     Interceptor   在 Controller 前後，但 Guard 已經跑過了 ——
 *                      模擬「伺服器整個掛掉」時，連認證都不該成功
 *     Filter        只處理已經拋出的例外，沒辦法製造例外
 *
 * 相關文件：README 第 9 節
 */

import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ERROR_DEFAULT_MESSAGES } from '@digital-wealth/shared';

import { DemoStateService } from './demo-state.service.js';

/** `slow-network` 的延遲。3 秒足以看清骨架屏，又不會讓人以為當掉了。 */
const SLOW_NETWORK_DELAY_MS = 3_000;

/**
 * `api-timeout` 在多久之後切斷連線。
 *
 * 8 秒的取捨：要比 TanStack Query 的預設重試間隔長（讓使用者
 * 真的看到「等待中」的狀態），又要短到不會讓人以為 demo 壞了。
 */
const TIMEOUT_ABORT_MS = 8_000;

@Injectable()
export class FaultInjectionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(FaultInjectionMiddleware.name);

  constructor(private readonly demoState: DemoStateService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    // ── 為什麼用 originalUrl 而不是 path ★ ────────────────────────
    //
    //   `request.path` 在 middleware 裡是**相對於掛載點**的路徑。
    //   NestJS 用 MiddlewareConsumer 掛上來時會有自己的 router 掛載點，
    //   所以這裡的 path 不含 `/api/v1` 全域前綴 —— 用它比對
    //   `/api/v1/demo` 永遠不會成立。
    //
    //   `originalUrl` 則永遠是瀏覽器送出的完整路徑（含 query string），
    //   不受掛載點影響。切掉 `?` 之後就能安全比對。
    //
    //   ⚠️ 這個 bug 實測踩到了，而且後果正是下面註解警告的那件事：
    //      豁免失效 → 開啟 api-500 之後連「關掉故障」的請求也回 500
    //      → 被鎖死在故障狀態，只能重啟容器。
    const path = request.originalUrl.split('?')[0] ?? '';

    // ── 控制台本身永遠不能被故障影響 ★ ──────────────────────────
    //
    //   少了這個豁免，開啟「所有 API 回 500」之後，
    //   連「關掉這個故障」的請求也會 500 —— 使用者被鎖死在故障狀態，
    //   只能重啟服務。這是故障注入功能最經典的自殺方式。
    if (path.startsWith('/api/v1/demo')) {
      next();
      return;
    }

    // 健康檢查也豁免。它是給 Docker 看的 —— 讓它 500 會導致
    // 容器被判定不健康然後重啟，故障狀態跟著消失，什麼都演不了。
    if (path.startsWith('/api/v1/health')) {
      next();
      return;
    }

    // ── 逾時：不回應，時間到就把連線砍掉 ★ ──────────────────────
    //
    //   這個故障模擬的是「請求送出去了，但你不知道後端到底做了沒」。
    //
    //   關鍵在於**不能回錯誤**。回 500 的話前端知道「失敗了」，
    //   可以放心地告訴使用者「沒有成立」。但真實的逾時不是這樣 ——
    //   後端可能已經扣款成功，只是回應在路上不見了。
    //
    //   前端唯一正確的處理是顯示「狀態未知，請至明細確認」，
    //   而不是「下單失敗」。這個分支只有靠這種故障才測得到。
    if (this.demoState.hasFault('api-timeout')) {
      this.logger.debug(`注入逾時：${request.method} ${path}`);

      const timer = setTimeout(() => {
        // destroy() 直接砍掉 TCP 連線，不送任何回應。
        // 用 response.end() 的話前端會收到一個空的 200，那是另一回事。
        request.socket.destroy();
      }, TIMEOUT_ABORT_MS);

      // 使用者自己按了取消（或關掉分頁）時要清掉計時器，
      // 否則每個被放棄的請求都會留一個 8 秒後才觸發的 timer。
      response.on('close', () => clearTimeout(timer));
      return;
    }

    // ── 伺服器錯誤 ────────────────────────────────────────────
    if (this.demoState.hasFault('api-500')) {
      this.logger.debug(`注入 500：${request.method} ${path}`);
      this.respondWithError(response, 500, 'INTERNAL_ERROR');
      return;
    }

    // ── 下單被拒：只攔下單，其他 API 照常 ★ ─────────────────────
    //
    //   刻意只針對 `POST /orders`。如果連查詢都一起壞掉，
    //   演示的就變成「整個系統掛了」，而不是「這一筆委託被交易所拒絕」——
    //   後者才是要展示的東西：**單一操作失敗時，畫面的其他部分
    //   要正確地不受影響**（餘額不變、持倉不變、樂觀更新要回滾）。
    //
    //   `/preview` 要放行，否則使用者連確認頁都進不去，
    //   根本按不到那顆會被拒絕的送出鈕。
    if (
      this.demoState.hasFault('order-rejected') &&
      request.method === 'POST' &&
      path === '/api/v1/orders'
    ) {
      this.logger.debug('注入下單被拒');
      this.respondWithError(response, 422, 'ORDER_REJECTED');
      return;
    }

    // ── 慢速網路：延遲之後照常處理 ──────────────────────────────
    //
    //   注意是 `next()` 而不是回錯誤 —— 這個故障不製造失敗，
    //   只是把每件事拖慢。它要驗的是「等待中的畫面長什麼樣」：
    //   骨架屏有沒有出現、按鈕有沒有 disabled、有沒有出現
    //   「按兩次送出兩筆」的空窗。
    if (this.demoState.hasFault('slow-network')) {
      setTimeout(next, SLOW_NETWORK_DELAY_MS);
      return;
    }

    next();
  }

  /**
   * 用**與真實錯誤完全相同的格式**回應。
   *
   * ★ 這一點很重要：注入的錯誤如果長得不一樣（少了 traceId、
   *   code 拼法不同），前端就有機會分辨出「這是假的」。
   *   格式必須跟 AllExceptionsFilter 產生的一模一樣。
   */
  private respondWithError(
    response: Response,
    status: number,
    code: 'INTERNAL_ERROR' | 'ORDER_REJECTED',
  ): void {
    response.status(status).json({
      error: {
        code,
        message: ERROR_DEFAULT_MESSAGES[code],
        details: { injected: true },
        traceId: crypto.randomUUID(),
      },
    });
  }
}
