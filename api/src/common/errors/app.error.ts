/**
 * api/src/common/errors/app.error.ts — 應用層的錯誤型別
 *
 * 這個檔案是什麼：
 *   一個帶有「錯誤碼」的自訂 Error 類別，以及幾個常用錯誤的捷徑。
 *
 * 為什麼不直接用 NestJS 內建的 HttpException：
 *   內建的 `NotFoundException`、`UnauthorizedException` 只表達
 *   HTTP 狀態碼，但本專案的契約是**以 code 為準**（見 shared/errors.ts）：
 *
 *     HTTP 422 一個狀態碼要涵蓋餘額不足、持股不足、標的停止交易、
 *     下單被拒⋯⋯七種完全不同的業務錯誤。前端沒辦法只靠 422 決定
 *     要顯示哪個 UI。
 *
 *   所以我們自己定義一個帶 code 的錯誤，由 Exception Filter 統一
 *   翻譯成標準的錯誤回應形狀。
 *
 * 在架構的哪一層：
 *   橫切關注點。Service 層拋出它，Exception Filter 接住它。
 */

import { ERROR_DEFAULT_MESSAGES, type ErrorCode } from '@fintech/shared';

/**
 * 帶錯誤碼的應用層錯誤。
 *
 * Service 層遇到業務錯誤時拋出這個，不要自己組 HTTP 回應 ——
 * 「怎麼變成 HTTP 回應」是 Exception Filter 的職責。
 * 這個分工讓 Service 可以被非 HTTP 的場景重用（例如排程、CLI）。
 *
 * @example
 *   if (!account) {
 *     throw new AppError('NOT_FOUND', '找不到帳戶');
 *   }
 */
export class AppError extends Error {
  /**
   * @param code 錯誤碼。決定 HTTP 狀態碼與前端顯示哪個 UI
   * @param message 人類閱讀的訊息。省略時用 shared 的預設訊息。
   *                ⚠️ 這個字串不是契約，前端不可用它做判斷
   * @param details 選填的補充資訊。**絕不可放入敏感資料** ——
   *                它會原封不動出現在 API 回應裡
   */
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
  }
}

/**
 * 找不到資源。
 *
 * @param resource 資源名稱，會出現在錯誤訊息裡（例如「標的」）
 */
export function notFound(resource: string): AppError {
  return new AppError('NOT_FOUND', `找不到指定的${resource}`);
}

/**
 * 未通過認證。
 *
 * 用在 token 缺失、過期、簽章錯誤等所有「你是誰我不知道」的情況。
 *
 * ⚠️ **訊息刻意含糊，不區分「沒帶 token」與「token 過期」。**
 *    對前端來說兩者的處理完全一樣（導向登入頁），
 *    而給攻擊者更多資訊沒有任何好處。
 */
export function authRequired(): AppError {
  return new AppError('AUTH_REQUIRED');
}

/**
 * 帳號或密碼錯誤。
 *
 * ⚠️ **絕對不要區分「帳號不存在」與「密碼錯誤」。**
 *
 * 如果分開回報，攻擊者可以用它來**列舉出哪些 email 有註冊**
 * （輸入一堆 email，回「密碼錯誤」的就代表該帳號存在）。
 * 這叫 user enumeration，是很常見的資訊洩漏。
 *
 * 統一回同一個訊息，攻擊者就分不出來。
 */
export function invalidCredentials(): AppError {
  return new AppError('AUTH_INVALID_CREDENTIALS');
}
