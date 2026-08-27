/**
 * web/src/mocks/browser.ts — MSW 的瀏覽器啟動器
 *
 * 在架構的哪一層：正式程式碼之外。
 *
 * ── 為什麼是動態 import，不是頂層 import ★ ──────────────────────
 *
 *   `main.tsx` 只在 `VITE_MOCK_API === '1'` 時才 `await import()` 這個檔案。
 *
 *   如果寫成頂層 import 再用 if 判斷要不要啟動，MSW 與所有 handler
 *   （含 753 行的 seed factory）仍然會被打包進**正常版本**的 bundle ——
 *   Docker 版的使用者要下載一份永遠不會執行的假後端。
 *
 *   動態 import 讓 Vite 把它切成獨立的 chunk，只有靜態展示版
 *   會去載。正常版本的 bundle 完全不含 mock 的任何一個位元組。
 */

import { setupWorker } from 'msw/browser';

import { handlers } from './handlers';

export const worker = setupWorker(...handlers);
