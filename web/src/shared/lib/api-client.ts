/**
 * web/src/shared/lib/api-client.ts — 唯一與後端對話的地方
 *
 * 這個檔案是什麼：
 *   包在 fetch 外面的一層薄殼。負責組網址、送 cookie、
 *   把後端的錯誤格式翻譯成一個前端好處理的例外類別。
 *
 * 在架構的哪一層：
 *   前端最底層。上面是各 feature 的 `api/` 目錄（TanStack Query hooks），
 *   再上面才是元件。
 *
 * ── PROJECT.md 的硬性規則之一 ★ ─────────────────────────────────
 *
 *     features 底下的 components 不得直接呼叫 fetch，
 *     一律經由同 feature 的 api 層。
 *
 *   （這句在 PROJECT.md 裡寫成 `features/<星號>/components`。這裡刻意
 *     不用星號寫路徑 —— 星號後面接斜線會提早關閉這個區塊註解，
 *     整個檔案就從這一行開始被當成程式碼解析。）
 *
 *   為什麼這條規則值得寫成硬性規範：元件直接 fetch 的專案，
 *   到後期會出現「同一個端點在五個元件裡被打五次、各自有不同的
 *   錯誤處理、快取完全沒共用」。而且元件一旦綁死 fetch，
 *   就沒辦法單獨測試 —— 這也是為什麼測試環境用 MSW 攔截
 *   （見 PROJECT.md：MSW 跑測試、真後端跑運行）。
 *
 * ── 為什麼不用 axios ──────────────────────────────────────────────
 *
 *   axios 的賣點是攔截器、自動 JSON、舊瀏覽器相容。前兩項這裡
 *   三十行就寫完了（而且看得懂），第三項本專案不需要。
 *   多一個相依只為了少寫三十行，不划算。
 */

import { type ErrorCode } from '@digital-wealth/shared';

/** API 前綴。走 Vite 代理，所以是相對路徑（理由見 vite.config.ts）。 */
const API_BASE = '/api/v1';

/**
 * 後端回傳的錯誤，翻譯成 JS 例外。
 *
 * ── `code` 是契約，`message` 不是 ★ ───────────────────────────────
 *
 *   前端**絕對不可以**用 message 的內容做判斷：
 *
 *     ❌ if (error.message === '可用餘額不足') { ... }
 *        → 後端改文案就靜默壞掉，TypeScript 一點忙都幫不上
 *
 *     ✅ if (error.code === 'INSUFFICIENT_FUNDS') { ... }
 *        → code 是 shared/errors.ts 的列舉，打錯字編譯就失敗
 *
 *   message 只有一個用途：直接顯示給使用者看。
 */
export class ApiError extends Error {
  constructor(
    /** 機器判讀用。定義在 shared/errors.ts，前後端共用同一份 */
    readonly code: ErrorCode,
    /** 給人看的預設訊息。不可用於邏輯判斷 */
    override readonly message: string,
    /** HTTP 狀態碼 */
    readonly status: number,
    /** 結構依 code 而定。例如 INSUFFICIENT_FUNDS 會帶 shortfallCents */
    readonly details?: Record<string, unknown>,
    /** 對應後端日誌，回報問題時附上這個 */
    readonly traceId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * 這個錯誤該不該自動重試。
   *
   *   4xx 使用者輸入 / 業務規則 → 不重試（重試幾次結果都一樣）
   *   429 / 503 暫時性故障      → 重試（指數退避）
   *   500 未預期                → 重試一次
   *
   * TanStack Query 的 retry 設定會呼叫這個（見 query-client.ts）。
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503 || this.status >= 500;
  }
}

/** 後端錯誤回應的形狀。與 shared/errors.ts 的 errorResponseSchema 對應。 */
interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    traceId?: string;
  };
}

/**
 * 發送 API 請求。
 *
 * @param path 端點路徑，不含 `/api/v1` 前綴（例如 `/portfolio/summary`）
 * @param init 標準的 fetch options
 * @throws {ApiError} 任何非 2xx 的回應
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
      // ── 為什麼要寫 same-origin 而不是靠預設值 ─────────────────
      //
      // fetch 的預設就是 same-origin，寫出來是為了讓讀程式碼的人
      // 知道「這裡有 cookie 在流動」。JWT 在 httpOnly cookie 裡，
      // 前端讀不到也送不了 —— 完全靠瀏覽器自動帶上。
      credentials: 'same-origin',
    });
  } catch {
    // fetch 只在「網路層失敗」時 reject（斷網、DNS 失敗、CORS 被擋）。
    // HTTP 500 對 fetch 來說是**成功**的請求，不會走到這裡 ——
    // 這是 fetch 最反直覺的地方，也是最常見的錯誤處理漏洞。
    throw new ApiError('SERVICE_UNAVAILABLE', '無法連線到伺服器，請確認網路狀態', 0);
  }

  // 204 No Content（登出）沒有 body，直接解析會爆。
  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = payload as ErrorEnvelope | null;

    if (envelope?.error?.code) {
      throw new ApiError(
        envelope.error.code,
        envelope.error.message,
        response.status,
        envelope.error.details,
        envelope.error.traceId,
      );
    }

    // 後端沒照統一格式回（例如被反向代理擋掉、或 NestJS 還沒進到
    // Exception Filter 就爆了）。這時只能給一個泛用錯誤。
    throw new ApiError('INTERNAL_ERROR', `伺服器回應異常（HTTP ${response.status}）`, response.status);
  }

  return payload as T;
}

/** GET 的捷徑。 */
export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

/** POST 的捷徑。body 自動轉 JSON。 */
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
