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
 * 涵蓋範圍：
 *   認證、請求、系統、下單業務規則四組。
 *
 *   刻意沒有 RATE_LIMITED —— 本專案只有一個 demo 帳號、只在本機執行，
 *   沒有可被濫用的對象。加上頻率限制之後，唯一會被擋到的是自己在測
 *   連點行為的時候。理由與「真要做該怎麼做」見 docs/02-backend.md。
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

  // ── 下單業務規則 ─────────────────────────────────────────────
  //
  // 這一組全部是 422（Unprocessable Entity）而不是 400。
  // 差別在於：400 是「你的請求我看不懂」，422 是「請求我看懂了，
  // 格式也對，但業務規則不允許」。餘額不足的請求格式完全正確，
  // 回 400 會誤導前端往「表單填錯」的方向處理。
  //
  /**
   * 409｜冪等鍵重複 → **靜默忽略，顯示原本的成功結果**
   *
   * 這個碼的前端處理最違反直覺：不該顯示錯誤。使用者連點兩次，
   * 從他的角度看只是點了兩下，第一次已經成功了。
   */
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  /** 422｜買進時可用餘額不足 → 紅色提示 ＋ 顯示差額 */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  /** 422｜賣出時持股不足 → 同上 */
  INSUFFICIENT_POSITION: 'INSUFFICIENT_POSITION',
  /** 422｜標的已停止交易 → 下單按鈕停用 ＋ 說明 */
  INSTRUMENT_NOT_TRADABLE: 'INSTRUMENT_NOT_TRADABLE',
  /** 422｜限價超出當日漲跌停 → 價格欄位錯誤 */
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE',
  /** 422｜委託被拒（模擬撮合失敗）→ 結果頁失敗分支 ＋ 樂觀更新回滾 */
  ORDER_REJECTED: 'ORDER_REJECTED',

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
  DUPLICATE_REQUEST: 409,
  INSUFFICIENT_FUNDS: 422,
  INSUFFICIENT_POSITION: 422,
  INSTRUMENT_NOT_TRADABLE: 422,
  PRICE_OUT_OF_RANGE: 422,
  ORDER_REJECTED: 422,
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
  DUPLICATE_REQUEST: '這筆委託已經送出過了',
  INSUFFICIENT_FUNDS: '可用餘額不足',
  INSUFFICIENT_POSITION: '可賣出的股數不足',
  INSTRUMENT_NOT_TRADABLE: '這檔標的目前停止交易',
  PRICE_OUT_OF_RANGE: '委託價格超出今日漲跌停範圍',
  ORDER_REJECTED: '委託遭拒絕',
  SERVICE_UNAVAILABLE: '服務暫時無法使用，請稍後再試',
  INTERNAL_ERROR: '系統發生未預期的錯誤',
};
