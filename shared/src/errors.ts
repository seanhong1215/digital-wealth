/**
 * shared/src/errors.ts — 統一錯誤碼
 *
 * 這個檔案是什麼：
 *   所有 API 錯誤的代碼列舉，以及錯誤回應的形狀定義。
 *
 * 為什麼放在 shared/：
 *   **code 是契約，message 不是。**
 *
 *   後端拋出 `INSUFFICIENT_FUNDS`，前端拿到之後決定顯示哪個 UI。
 *   如果前端改用 message 的字串內容來判斷（例如
 *   `if (error.message === '可用餘額不足')`），那麼哪天有人把文案
 *   改成「餘額不足」，前端就整個壞掉 —— 而且是靜默壞掉，
 *   TypeScript 一點忙都幫不上。
 *
 *   把 code 定義成列舉放在 shared/，前後端引用同一份，
 *   打錯字會編譯失敗。
 *
 * 在架構的哪一層：
 *   契約層。後端的 Exception Filter 用它產生回應，
 *   前端的錯誤處理用它決定 UI。
 *
 * 目前狀態（單元 1.1）：
 *   只放這個階段用得到的錯誤碼。下單相關的（ORDER_REJECTED、
 *   DUPLICATE_REQUEST…）等 Phase 3 實作下單時再補。
 *   完整清單見 docs/02-backend.md 的錯誤碼表。
 */

import { z } from 'zod';

// ============================================================================
// 錯誤碼
// ============================================================================

/**
 * 錯誤碼列舉。
 *
 * 用 `as const` 物件而不是 TypeScript 的 `enum`，理由有二：
 *   1. `enum` 會產生執行期的物件，而且它的型別行為有不少陷阱
 *      （數字 enum 可以被任意數字指派）
 *   2. `as const` 物件搭配下面的 union 型別，效果一樣但更單純，
 *      而且可以直接被 zod 吃進去做執行期驗證
 *
 * 每個 code 後面註明對應的 HTTP 狀態碼與前端該顯示什麼。
 */
export const ERROR_CODES = {
  // ── 認證 ─────────────────────────────────────────────────────
  /** 401｜未登入或 token 過期 → 前端導向登入頁 */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  /** 401｜帳號或密碼錯誤 → 表單錯誤訊息 */
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',

  // ── 請求 ─────────────────────────────────────────────────────
  /** 400｜請求格式錯誤（zod 驗證失敗）→ 表單 field-level 錯誤 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** 404｜資源不存在 → 空狀態頁 */
  NOT_FOUND: 'NOT_FOUND',

  // ── 系統 ─────────────────────────────────────────────────────
  /** 503｜下游服務異常（資料庫、Redis）→ 全頁錯誤 ＋ 重試按鈕 */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** 500｜未預期錯誤 → 全頁錯誤 ＋ 回報 traceId */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/**
 * 錯誤碼的型別。
 *
 * `(typeof ERROR_CODES)[keyof typeof ERROR_CODES]` 這串的意思是
 * 「ERROR_CODES 這個物件所有值的聯集」，也就是：
 *
 *   'AUTH_REQUIRED' | 'AUTH_INVALID_CREDENTIALS' | ... | 'INTERNAL_ERROR'
 *
 * 好處是**新增一個錯誤碼時，型別會自動跟著長**，不用維護兩份清單。
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ============================================================================
// 錯誤回應的形狀
// ============================================================================

/**
 * 所有錯誤回應的統一格式，由後端的 Exception Filter 產生。
 *
 * ```jsonc
 * {
 *   "error": {
 *     "code": "AUTH_REQUIRED",       // 機器判讀 —— 前端用它決定顯示哪個 UI
 *     "message": "請先登入",          // 人類閱讀的預設訊息（不是契約！）
 *     "details": { ... },            // 選填，結構依 code 而定
 *     "traceId": "01J8X..."          // 對應後端日誌，除錯用
 *   }
 * }
 * ```
 *
 * 為什麼要包一層 `error` 而不是直接放頂層：
 *   讓「成功回應」與「錯誤回應」在形狀上絕對不可能混淆。
 *   前端只要檢查 `'error' in body` 就知道是哪一種。
 */
export const errorResponseSchema = z.object({
  error: z.object({
    /** 機器判讀的錯誤碼。**這是契約** */
    code: z.enum(
      Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
    ),
    /** 人類閱讀的預設訊息。**前端不可用它做判斷** */
    message: z.string(),
    /** 選填的補充資訊，結構依 code 而定 */
    details: z.record(z.unknown()).optional(),
    /** 對應後端日誌的追蹤碼，回報問題時附上它 */
    traceId: z.string(),
  }),
});

/** 錯誤回應的 TypeScript 型別，由 zod schema 推導而來。 */
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * 每個錯誤碼對應的 HTTP 狀態碼。
 *
 * 為什麼需要這張表：
 *   HTTP 狀態碼太粗糙 —— 422 一個碼要涵蓋餘額不足、持股不足、
 *   標的停止交易、下單被拒等七種完全不同的業務錯誤。
 *   所以我們用 `code` 表達「發生什麼事」，用 HTTP 狀態碼表達
 *   「這一類錯誤該怎麼處理」（能不能重試、要不要導向登入）。
 *
 *   這張表就是兩者之間的對照，放在 shared/ 讓後端的 Exception Filter
 *   直接查表，不用每個地方各寫一次。
 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/**
 * 每個錯誤碼的預設中文訊息。
 *
 * ⚠️ 再強調一次：**這些字串不是契約，隨時可能改。**
 *    前端要顯示自己的文案時，應該依 `code` 自己決定要顯示什麼，
 *    而不是直接把 `message` 印在畫面上。
 *
 *    這裡提供預設訊息是為了讓 API 在被 curl 或 Postman 直接呼叫時
 *    也能看懂發生什麼事。
 */
export const ERROR_DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  AUTH_REQUIRED: '請先登入',
  AUTH_INVALID_CREDENTIALS: '帳號或密碼錯誤',
  VALIDATION_FAILED: '請求格式不正確',
  NOT_FOUND: '找不到指定的資料',
  SERVICE_UNAVAILABLE: '服務暫時無法使用，請稍後再試',
  INTERNAL_ERROR: '系統發生未預期的錯誤',
};
