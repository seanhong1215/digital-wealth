/**
 * shared/src/index.ts — 共用契約層的進入點
 *
 * 這個檔案是什麼：
 *   `@fintech/shared` 這個套件的公開介面。web 與 api 從這裡 import 東西：
 *
 *     import { APP_NAME } from '@fintech/shared';
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
 * 目前內容（單元 0.2a）：
 *   只有一個常數，作用是驗證 workspace 的連接有沒有真的通。
 *   後續單元會陸續加入：
 *     - money.ts    金額運算（單元 0.2b）
 *     - schemas/    zod 契約（單元 0.4 起）
 *     - errors.ts   錯誤碼列舉（單元 4.1）
 */

/** 應用程式名稱。品牌名稱確定後會換掉這個值。 */
export const APP_NAME = 'FinTech';

/** 幣別代碼。本專案只處理新台幣。 */
export const CURRENCY = 'TWD' as const;

/**
 * 一元等於幾分。
 *
 * 本專案所有金額一律以「分」為最小單位的整數儲存，絕不使用浮點數
 * （見 docs/adr/0005）。這個常數是元與分之間換算的唯一依據。
 */
export const CENTS_PER_UNIT = 100;
