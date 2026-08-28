/**
 * shared/src/index.ts — 共用契約層的進入點
 *
 * 這個檔案是什麼：
 *   `@digital-wealth/shared` 這個套件的公開介面。web 與 api 從這裡 import 東西：
 *
 *     import { APP_NAME, cents, calculateTradeCost } from '@digital-wealth/shared';
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
 *   一律 `from '@digital-wealth/shared'` 就好。
 *
 *   需要細分時仍可走子路徑（見 shared/package.json 的 exports）：
 *     import { cents } from '@digital-wealth/shared/money';
 *
 * 目前內容：
 *   ✅ money.ts         金額型別與運算（單元 0.2b）
 *   ✅ market-rules.ts  台股規則：跳動單位、手續費、漲跌停（單元 0.2b）
 *   ✅ schemas/         zod 契約：認證、投組、明細（單元 1.1）
 *   ✅ errors.ts        錯誤碼列舉（含下單業務規則）
 */

// ============================================================================
// 應用層級常數
// ============================================================================

/**
 * 品牌名稱。**全站唯一來源** —— UI 上任何顯示品牌的地方都從這裡取，
 * 不寫死字串。要改名只改這一行。
 *
 * 這是**虛構品牌**。使用真實金融機構的名稱、Logo、主色或字體，
 * 在一個公開 repo 裡等同商標使用 ——
 * 這是不必要的法律風險。
 *
 * 註：npm 的 workspace 命名（`@digital-wealth/*`）與這個品牌字串是
 *     **兩件不同的事**，改一個不必然要改另一個：
 *
 *       APP_NAME              使用者看得到的名字，可以隨時改
 *       @digital-wealth/*     開發者看得到的模組路徑，改動會波及
 *                             56 個檔案的 import
 *
 *     兩者目前剛好都對應「數位財富管理」這個主題，但 UI 一律讀
 *     APP_NAME、絕不寫死字串，所以品牌改名仍然只需要動這一行。
 */
export const APP_NAME = 'Shawn';

/** 品牌全名。用於頁面標題、README 等需要完整稱呼的地方。 */
export const APP_FULL_NAME = 'Shawn 財富';

/** 品牌英文名。 */
export const APP_NAME_EN = 'Shawn Wealth';

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
