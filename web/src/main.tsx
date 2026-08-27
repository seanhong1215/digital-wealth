/**
 * web/src/main.tsx — 應用程式進入點
 *
 * Provider 的巢狀順序有意義：
 *
 *   QueryClientProvider   最外層 —— 路由切換不該讓快取重建
 *     BrowserRouter
 *       App
 *
 * 反過來（Router 在外）的話，每次路由變動都可能重新建立
 * QueryClient，所有快取就沒了。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import './index.css';
import { queryClient } from './shared/lib/query-client';

/**
 * 啟動假後端（只有靜態展示版會走到這裡）★
 *
 * ── 為什麼要「等 worker 就緒才 render」 ──────────────────────────
 *
 *   Service Worker 的註冊是非同步的。如果先 render，React 會立刻
 *   發出第一批請求（/auth/me、/portfolio/summary），而那時 worker
 *   可能還沒接管 —— 那些請求會真的送到伺服器上，得到 404。
 *
 *   症狀是「重新整理有時候正常、有時候整頁錯誤」，而且在快的機器上
 *   幾乎不會發生，只有慢的手機才會 —— 是最難重現的那種 bug。
 *
 *   所以 await 它。代價是首屏多等幾十毫秒。
 */
async function startMockApi(): Promise<void> {
  if (import.meta.env.VITE_MOCK_API !== '1') return;

  const { worker } = await import('./mocks/browser');

  await worker.start({
    // Service Worker 的 scope 必須涵蓋整個站台。GitHub Pages 會把
    // 網站放在 /<repo>/ 底下，所以路徑要跟著 base 走。
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    // 沒有對應 handler 的請求就讓它照常送出去（例如 Google Fonts）。
    onUnhandledRequest: 'bypass',
  });
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root —— index.html 是不是被改壞了？');
}

await startMockApi();

createRoot(container).render(
  // StrictMode 在開發時會刻意把每個元件 render 兩次、effect 執行兩次，
  // 用來揪出「不純的 render」與「沒清乾淨的 effect」。
  // 正式建置不會有這個行為，所以看到 console 訊息重複兩次是正常的。
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/*
        basename 讓 React Router 知道網站不在網域根目錄。★

        GitHub Pages 把專案放在 /<repo>/ 底下。少了 basename：
          · Vite 的資源路徑對了（有 base），畫面畫得出來
          · 但 router 以為自己在根目錄 —— 點「交易明細」會導到
            /transactions 而不是 /<repo>/transactions
          · 那個網址在 Pages 上是 404，而且**重新整理才會發現**
            （前端導航不會真的送出請求）

        import.meta.env.BASE_URL 就是 vite.config.ts 裡設定的 base，
        兩者永遠一致，不會有各寫一份而分岔的問題。
      */}
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
