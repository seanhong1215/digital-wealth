/**
 * shared/src/index.ts — 共用契約層的進入點
 *
 * 這個檔案是什麼：
 *   `@fintech/shared` 這個套件的公開介面。web 與 api 從這裡 import 東西：
 *
 *     import { APP_NAME, cents, calculateTradeCost } from '@fintech/shared';
 *
 * 為什麼存在：
 *   本專案最重要的架構訊號是「前後端契約只有一份」（見 docs/adr/0002）。
 *   zod schema、金額運算、錯誤碼都放在這一層，後端用它做執行期驗證、
 *   前端用它推導型別。改一個欄位，兩邊會同時編譯失敗 —— 這正是我們要的。
 *
 * 在架構的哪一層：
 *   最底層。shared 不依賴任何其他 workspace，反過來 web / api / market-feed
 *   都依賴它。因此 shared 裡面絕對不能出現瀏覽器 API 或 NestJS 的東西。
 *
 * ── 這個檔案的角色是「barrel（桶檔）」───────────────────────────────
 *
 *   它自己幾乎不寫邏輯，只負責把各個模組的公開 API 收攏成一個入口。
 *   好處是使用端不用記得「金額在 money、費用在 market-rules」，
 *   一律 `from '@fintech/shared'` 就好。
 *
 *   需要細分時仍可走子路徑（見 shared/package.json 的 exports）：
 *     import { cents } from '@fintech/shared/money';
 *
 * 目前內容：
 *   ✅ money.ts         金額型別與運算（單元 0.2b）
 *   ✅ market-rules.ts  台股規則：跳動單位、手續費、漲跌停（單元 0.2b）
 *   ✅ schemas/         zod 契約：認證、投組、明細（單元 1.1）
 *   ✅ errors.ts        錯誤碼列舉（單元 1.1，Phase 4 會補齊下單相關的碼）
 */

// ============================================================================
// 應用層級常數
// ============================================================================

/** 應用程式名稱。品牌名稱確定後會換掉這個值。 */
export const APP_NAME = 'FinTech';

/** 幣別代碼。本專案只處理新台幣。 */
export const CURRENCY = 'TWD' as const;

// ============================================================================
// 子模組再匯出
//
// `export *` 會把該模組所有具名匯出（含型別）都轉出來。
// 順序有意義：market-rules 依賴 money，所以 money 放前面比較好讀，
// 但實際上 ESM 會自行處理相依順序，不會因為寫反而壞掉。
// ============================================================================

export * from './money.js';
export * from './market-rules.js';
export * from './errors.js';
export * from './schemas/index.js';
