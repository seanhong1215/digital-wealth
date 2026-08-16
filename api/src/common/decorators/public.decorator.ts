/**
 * api/src/common/decorators/public.decorator.ts — 標記公開端點
 *
 * 這個檔案是什麼：
 *   `@Public()` 裝飾器，用來標記「這個端點不需要登入」。
 *
 * ── 為什麼是「預設需要認證，例外才標記公開」──────────────────────
 *
 * 有兩種做法，方向完全相反：
 *
 *   A. 預設公開，需要認證的加 @UseGuards(JwtAuthGuard)
 *   B. 預設認證，公開的加 @Public()          ← 本專案採用
 *
 * 差別在**忘記標記時會發生什麼**：
 *
 *   A 忘記加 Guard  → API 裸奔，任何人都能讀別人的帳戶。
 *                     而且不會有任何錯誤訊息，你**永遠不會發現**，
 *                     直到有人告訴你（或資料已經外流）
 *
 *   B 忘記加 Public → 登入頁打不開，回 401。
 *                     你在第一次測試時就會立刻發現
 *
 * **安全設計的通則：讓失誤往「拒絕」的方向倒，而不是往「放行」。**
 * 這叫 fail-safe 或 secure by default。
 *
 * ── 這是怎麼運作的 ────────────────────────────────────────────────
 *
 * `SetMetadata` 把一個鍵值對附加到方法（或類別）上，
 * 這些資料存在 reflect-metadata 裡。JwtAuthGuard 執行時會用
 * `Reflector` 把它讀出來，讀到 true 就直接放行。
 *
 * 這套機制叫 **custom metadata**，是 NestJS 實作「宣告式」設定的基礎 ——
 * 角色權限（@Roles('admin')）、快取時間（@CacheTTL(60)）都是同樣的模式。
 *
 * 在架構的哪一層：橫切關注點。
 */

import { SetMetadata } from '@nestjs/common';

/**
 * metadata 的鍵。
 *
 * 用具名常數而不是在兩個檔案各寫一次字串 'isPublic' ——
 * 打錯字的話 Guard 會永遠讀不到，而且不會報錯，
 * 結果是 @Public() 靜默失效、登入頁打不開。
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 標記此端點不需要認證。
 *
 * 可以加在方法上（單一端點）或類別上（整個 Controller）。
 *
 * ⚠️ **加這個裝飾器前先想清楚**：這個端點回傳的資料，
 *    是不是真的可以讓任何人看到？
 *
 * 目前用在：
 *   POST /auth/login   —— 還沒登入當然不能要求登入
 *   GET  /health       —— 監控用，且不含任何業務資料
 *
 * @example
 *   @Public()
 *   @Post('login')
 *   login(@Body() body: LoginRequest) { ... }
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
