/**
 * shared/src/simulation/index.ts — 模擬層的進入點
 *
 * 這個目錄是什麼：
 *   **產生假資料的規則**。歷史成交怎麼生成、持倉怎麼從明細推導、
 *   價格怎麼隨機漫步 —— 全部是純函式，不碰資料庫也不碰網路。
 *
 * ── 為什麼從 api/ 與 market-feed/ 搬到 shared/ ★ ──────────────────
 *
 *   原本 factory.ts 住在 api（因為只有 seed 指令用得到），
 *   walker.ts 住在 market-feed。但現在有第三個使用者：
 *   **GitHub Pages 上的前端展示版**。
 *
 *   那個版本沒有後端（靜態託管），資料由瀏覽器裡的 MSW 提供。
 *   而它必須產生**跟真實後端一模一樣的資料** —— 否則線上 demo
 *   的數字跟本機跑出來的對不上，就會發現兩者是兩套東西。
 *
 *   三個使用者（api 的 seed、market-feed、瀏覽器 mock）共用同一份
 *   規則之後，「同一組（情境、種子）永遠產生一模一樣的資料」
 *   這句話才是真的 —— 不管在哪裡跑。
 *
 *   放在 shared 也是正確的歸屬：假資料的形狀是**領域規則**
 *   （持倉的平均成本必須等於歷史買入的加權平均），
 *   不是資料庫的細節。
 *
 * ── 為什麼是子路徑匯出，不併進主 barrel ─────────────────────────
 *
 *   `import { cents } from '@digital-wealth/shared'` 是每個檔案都會做的事。
 *   如果模擬層也在主 barrel 裡，那 753 行的 factory 就會被打包進
 *   **每一個** import 過 shared 的地方 —— 包含正式的後端服務，
 *   而它執行期根本用不到。
 *
 *   走 `@digital-wealth/shared/simulation` 讓它是 opt-in 的。
 */

export * from './factory.js';
export * from './instruments.js';
export * from './rng.js';
export * from './walker.js';
