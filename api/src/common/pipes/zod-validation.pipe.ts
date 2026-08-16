/**
 * api/src/common/pipes/zod-validation.pipe.ts — zod 驗證管道
 *
 * 這個檔案是什麼：
 *   把 shared/ 的 zod schema 接上 NestJS 的參數驗證機制。
 *
 * ── Pipe 是什麼（NestJS，第一次出現）──────────────────────────────
 *
 * Pipe 在「請求抵達 Controller 之前」對參數做兩件事：
 *   1. **轉換**（transformation）—— 例如把 query string 的 "30" 轉成數字 30
 *   2. **驗證**（validation）—— 不符合規則就擋下來
 *
 * 它的位置很關鍵：**Controller 拿到的一定是已經驗證過的資料。**
 * 所以 Controller 裡不需要寫任何 `if (!body.email) return 400`，
 * 那些檢查全部前移到這一層。
 *
 * 對照 Spring Boot：≈ `@Valid` + `@RequestBody` 的驗證流程。
 *
 * ── 為什麼自己寫，而不是用 NestJS 官方的 ValidationPipe ───────────
 *
 * 官方的 ValidationPipe 搭配 class-validator，用裝飾器定義規則：
 *
 *     class LoginDto {
 *       @IsEmail() email: string;
 *       @MinLength(1) password: string;
 *     }
 *
 * 問題是**這套規則無法與前端共用** —— class-validator 依賴裝飾器與
 * reflect-metadata，前端沒有這個環境。於是同一份驗證規則要寫兩次，
 * 直接違反本專案「契約單一來源」的核心原則（ADR 0002）。
 *
 * 用 zod 的話，同一份 schema：
 *   後端  → 這個 Pipe 做執行期驗證
 *   前端  → react-hook-form 的 zodResolver 做表單驗證
 *   兩邊  → z.infer 推導出同一個 TypeScript 型別
 *
 * ── 驗證失敗會發生什麼 ────────────────────────────────────────────
 *
 * 這裡**直接讓 ZodError 往上拋**，不自己組錯誤回應 ——
 * AllExceptionsFilter 已經知道怎麼把 ZodError 翻譯成
 * `VALIDATION_FAILED` 加上欄位層級的錯誤細節。
 *
 * 每一層只做自己的事：Pipe 負責「驗」，Filter 負責「怎麼回報」。
 *
 * 在架構的哪一層：橫切關注點。
 */

import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * 用指定的 zod schema 驗證參數。
 *
 * 這個類別**不是**用 `@Injectable()` 單例注入的方式使用，
 * 而是在需要的地方 `new` 出來（因為每個端點的 schema 不同）：
 *
 * @example
 *   @Post('login')
 *   login(@Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest) {
 *     // body 的型別是 LoginRequest，而且保證已經驗證過
 *   }
 *
 * 為什麼還是加 `@Injectable()`：
 *   NestJS 的型別定義要求 Pipe 是可注入的類別，加上它才不會有型別警告。
 *   實際上我們是手動 new 的，框架不會去容器裡找它。
 */
@Injectable()
export class ZodValidationPipe<Output> implements PipeTransform<unknown, Output> {
  /**
   * ── 為什麼型別參數要寫得這麼囉唆 ──────────────────────────────
   *
   * `ZodType` 有三個型別參數：`<Output, Def, Input>`。
   *
   * 常見的簡寫 `ZodSchema<T>` 等同於 `ZodType<T, ZodTypeDef, T>` ——
   * 也就是**假設輸入與輸出型別相同**。
   *
   * 但我們的 schema 常常不是這樣：
   *
   *   limitSchema      輸入是 string（query 永遠是字串）
   *                    輸出是 number（coerce 之後）
   *
   *   .default(30)     輸入可以是 undefined
   *                    輸出保證是 number
   *
   *   .transform(...)  輸入是 'BUY,SELL' 字串
   *                    輸出是 TransactionType[] 陣列
   *
   * 用 `ZodSchema<T>` 會編譯失敗（TS2345），因為 zod 推導出來的
   * 輸入型別跟輸出型別對不上。把 Input 明確寫成 `unknown`
   * 就接受任何輸入型別的 schema —— 這正好符合這個 Pipe 的語意：
   * **它接受任何原始輸入，產出驗證過的型別。**
   */
  constructor(private readonly schema: ZodType<Output, ZodTypeDef, unknown>) {}

  /**
   * 驗證並轉換一個參數。
   *
   * @param value 原始值。可能是 request body、query、param
   * @param _metadata NestJS 提供的參數資訊（是 body 還是 query…）。
   *                  這裡用不到 —— schema 是建構時就指定好的，
   *                  不需要依參數位置改變行為
   * @returns 驗證並轉換後的值。型別是 schema 推導出來的 T
   * @throws {ZodError} 驗證失敗時。由 AllExceptionsFilter 接住
   */
  transform(value: unknown, _metadata: ArgumentMetadata): Output {
    // 用 parse 而不是 safeParse —— 我們**要**它拋錯，
    // 讓 Filter 統一處理。safeParse 回傳結果物件，那樣就得在這裡
    // 自己判斷成功失敗，等於把錯誤處理邏輯散到每一層。
    return this.schema.parse(value);
  }
}
