/**
 * api/src/common/filters/all-exceptions.filter.ts — 統一錯誤回應
 *
 * 這個檔案是什麼：
 *   攔截整個應用拋出的**所有**錯誤，翻譯成統一的 JSON 形狀。
 *
 * ── `@Catch()` / Exception Filter 是什麼（NestJS，第一次出現）─────
 *
 * Exception Filter 是 NestJS 的錯誤處理層。當 Controller 或 Service
 * 拋出任何未被接住的錯誤，NestJS 會把它交給 Filter 處理。
 *
 * `@Catch()` 不帶參數 = 接住**所有**錯誤（包含非 Error 的東西，
 * 例如有人 `throw 'oops'` 丟一個字串）。
 *
 * 對照 Spring Boot：≈ `@ControllerAdvice` + `@ExceptionHandler`。
 *
 * ── 為什麼需要它 ──────────────────────────────────────────────────
 *
 * 沒有它的話，錯誤回應的形狀會有三四種：
 *   - NestJS 內建例外   → { statusCode, message, error }
 *   - 未捕捉的 Error    → 500 加上一整串 stack trace
 *   - 資料庫錯誤        → pg 套件自己的格式
 *
 * 前端要為每一種各寫一套解析，而且新的錯誤來源出現時會漏掉。
 *
 * 有了 Filter，**所有錯誤都是同一個形狀**：
 *
 *   { error: { code, message, details?, traceId } }
 *
 * 前端只要檢查 `error.code` 就好。
 *
 * ── 這裡的安全考量 ────────────────────────────────────────────────
 *
 * 未預期的錯誤（500）**絕不把 stack trace 或原始訊息回傳給前端**。
 * 那些內容可能洩漏檔案路徑、SQL 語句、套件版本 —— 都是攻擊者想要的。
 *
 * 取而代之的是回傳一個 `traceId`，同時把完整錯誤寫進伺服器日誌。
 * 使用者回報問題時附上 traceId，你就能在日誌裡找到對應的那一筆。
 *
 * 在架構的哪一層：橫切關注點，全域註冊於 main.ts。
 */

import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  ERROR_DEFAULT_MESSAGES,
  ERROR_HTTP_STATUS,
  type ErrorCode,
  type ErrorResponse,
} from '@fintech/shared';

import { AppError } from '../errors/app.error.js';

/** 翻譯結果：錯誤碼 ＋ 訊息 ＋ 選填的細節。 */
interface TranslatedError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  /** 是否要把完整錯誤寫進日誌（未預期的錯誤才要） */
  readonly shouldLogStack: boolean;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  /**
   * 處理一個被攔截的錯誤。
   *
   * @param exception 拋出的東西。型別是 unknown 而不是 Error，
   *                  因為 JavaScript 允許 throw 任何值
   * @param host 執行環境。透過它取得 Express 的 request / response 物件
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 每個錯誤都給一個唯一識別碼。
    // 前端拿到它、日誌裡也有它，兩邊就對得起來。
    const traceId = randomUUID();

    const translated = this.translate(exception);
    const status = ERROR_HTTP_STATUS[translated.code];

    if (translated.shouldLogStack) {
      // 未預期的錯誤：記錄完整內容（含 stack trace）供除錯。
      // 這些內容**只進日誌，不進回應**。
      this.logger.error(
        `[${traceId}] ${request.method} ${request.url} — 未預期的錯誤`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      // 預期內的錯誤（找不到、未登入…）：只記一行，不需要 stack。
      // 用 warn 而非 error，這樣日誌裡真正需要注意的東西不會被淹沒。
      this.logger.warn(
        `[${traceId}] ${request.method} ${request.url} — ${translated.code}: ${translated.message}`,
      );
    }

    const body: ErrorResponse = {
      error: {
        code: translated.code,
        message: translated.message,
        ...(translated.details ? { details: translated.details } : {}),
        traceId,
      },
    };

    response.status(status).json(body);
  }

  /**
   * 把任何拋出的東西翻譯成統一的錯誤碼與訊息。
   *
   * 判斷順序有意義：從最具體的類型開始比對，
   * 最後才落到「不認識的東西」那一支。
   *
   * @param exception 拋出的東西
   * @returns 翻譯後的錯誤碼、訊息與是否需要記錄 stack
   */
  private translate(exception: unknown): TranslatedError {
    // ── 1. 我們自己拋的業務錯誤 ────────────────────────────────
    // 這是最常見的情況，也是唯一「錯誤碼由拋出者決定」的路徑。
    if (exception instanceof AppError) {
      return {
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
        shouldLogStack: false,
      };
    }

    // ── 2. zod 驗證失敗 ────────────────────────────────────────
    // 把 zod 的 issue 陣列整理成「欄位 → 錯誤訊息」的對照表，
    // 前端可以直接拿去做 field-level 的表單錯誤提示。
    if (exception instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of exception.issues) {
        // issue.path 是陣列（巢狀欄位會有多層），用點串起來變成
        // 'user.email' 這種前端好認的形式。
        const field = issue.path.join('.') || '(root)';
        fieldErrors[field] ??= issue.message;
      }

      return {
        code: 'VALIDATION_FAILED',
        message: ERROR_DEFAULT_MESSAGES.VALIDATION_FAILED,
        details: { fields: fieldErrors },
        shouldLogStack: false,
      };
    }

    // ── 3. NestJS 內建的例外 ───────────────────────────────────
    // 例如路由不存在時框架自己拋的 NotFoundException。
    // 我們把它映射到自己的錯誤碼，讓回應形狀一致。
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === 401 ? 'AUTH_REQUIRED' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR';

      return {
        code,
        message: status === 404 ? '找不到指定的路徑' : exception.message,
        shouldLogStack: status >= 500,
      };
    }

    // ── 4. 其他所有東西 ────────────────────────────────────────
    // 資料庫連線失敗、程式 bug、有人 throw 了一個字串⋯⋯
    //
    // ⚠️ 這裡**刻意不把原始訊息傳給前端**。
    //    原始訊息可能包含 SQL 語句、檔案路徑、連線字串 ——
    //    全都是攻擊者想知道的東西。
    return {
      code: 'INTERNAL_ERROR',
      message: ERROR_DEFAULT_MESSAGES.INTERNAL_ERROR,
      shouldLogStack: true,
    };
  }
}
