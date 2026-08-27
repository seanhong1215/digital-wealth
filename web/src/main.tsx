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

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root —— index.html 是不是被改壞了？');
}

createRoot(container).render(
  // StrictMode 在開發時會刻意把每個元件 render 兩次、effect 執行兩次，
  // 用來揪出「不純的 render」與「沒清乾淨的 effect」。
  // 正式建置不會有這個行為，所以看到 console 訊息重複兩次是正常的。
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
