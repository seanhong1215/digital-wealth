/**
 * vitest.config.ts — 測試執行器設定（根目錄，涵蓋所有 workspace）
 *
 * 這個檔案是什麼：
 *   Vitest 是本專案的測試執行器。這個設定告訴它去哪裡找測試、
 *   哪些目錄要跳過。
 *
 * 為什麼放在根目錄而不是各 workspace 各一份：
 *   目前四個 workspace 的測試需求一致，一份設定就夠。
 *   等 web 需要瀏覽器環境（jsdom）而 api 需要 Node 環境時，
 *   再拆成 Vitest 的 projects 設定。現在拆是過早最佳化。
 *
 * 為什麼用 Vitest 而不是 Jest：
 *   Vitest 原生支援 TypeScript 與 ESM，不需要額外的 transform 設定。
 *   Jest 在 ESM 專案裡要處理一堆設定問題。且 web 端用 Vite，
 *   測試與建置共用同一套解析邏輯，行為比較一致。
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 測試檔的命名規則：任何 .test.ts 檔案。
    include: ['**/*.test.ts'],

    // 不要去這些目錄裡找測試。
    // dist 裡是編譯產物，掃了會重複執行同一批測試。
    exclude: ['**/node_modules/**', '**/dist/**'],

    // 測試環境用 Node。
    // 之後 web 的元件測試需要 DOM 時，會在該 workspace 另外指定 jsdom。
    environment: 'node',

    // 執行結果的顯示方式。verbose 會列出每一個測試案例的名稱，
    // 對學習階段比較友善 —— 你可以直接讀出「這支測試在驗證什麼」。
    reporters: ['verbose'],

    // 注意這個 server 是放在 test 裡面的（Vitest 的測試期模組處理設定），
    // 不是最外層那個 server（那是 Vite dev server 的 host/port/proxy）。
    // 寫在最外層會出現 TS2769: 'deps' does not exist in type 'ServerOptions'。
    server: {
      deps: {
        // 讓 Vitest 把 @digital-wealth/shared 當成專案內的原始碼處理，而不是
        // 當成外部套件（外部套件預設不會經過 TypeScript transform）。
        //
        // 需要這行的原因：shared 是透過 node_modules 的 symlink 被解析的，
        // Vite 預設會把 node_modules 底下的東西視為「已編譯好的依賴」而跳過轉譯。
        // 但我們的 shared 匯出的是未編譯的 .ts 原始碼，所以要明確要求轉譯它。
        inline: [/@digital-wealth\//],
      },
    },
  },
});
