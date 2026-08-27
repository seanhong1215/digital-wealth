/**
 * web/vite.config.ts — 前端建置設定
 *
 * ── `/api` 代理是這份設定裡最重要的一段 ★ ──────────────────────────
 *
 *   後端把 JWT 放在 httpOnly cookie（見 docs/02-backend.md 的認證設計）。
 *   httpOnly 的意思是 JavaScript 讀不到它 —— 這正是防 XSS 的重點，
 *   但也代表前端無法「手動把 token 加進 Authorization header」。
 *   cookie 必須由瀏覽器自動帶上，而瀏覽器只會把 cookie 帶給**同源**的請求。
 *
 *   開發時前端在 :5173、後端在 :3000，是不同源。有兩條路：
 *
 *     A. 後端開 CORS + credentials，前端每個 fetch 加 credentials: 'include'
 *        → 要處理 preflight、SameSite、Secure 一堆設定，而且正式環境
 *          根本不會這樣部署（那時是同一個網域）
 *
 *     B. ✅ Vite 代理：前端打 /api/v1/...，Vite 幫忙轉給 :3000
 *        → 瀏覽器眼中一切都是 :5173 的同源請求，cookie 自然帶上
 *        → 而且開發環境的行為和正式環境（同網域）一致
 *
 *   選 B。代價是後端網址寫死在這裡，但那本來就是開發設定該做的事。
 */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
