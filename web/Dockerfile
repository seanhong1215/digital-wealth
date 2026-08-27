# ==============================================================================
# web/Dockerfile — React 前端的容器映像
#
# 這個檔案是什麼：
#   把前端打包成靜態檔，交給 nginx 提供服務，並由 nginx 把 /api
#   轉給後端容器。
#
# ── 為什麼這裡有多階段建置，而 api/Dockerfile 沒有 ★ ──────────────
#
#   兩者的差異來自「執行期需要什麼」：
#
#     api   執行期需要 Node、需要 node_modules、需要原始碼
#           （SWC 在執行期轉譯）。所以沒得瘦身，一個階段就好。
#
#     web   ✅ 執行期**什麼都不需要**。Vite build 完就是一堆
#           .html / .js / .css 靜態檔，任何靜態伺服器都能提供。
#           Node 與 node_modules 只在 build 時需要。
#
#   所以這裡用兩階段：第一階段用 Node 建置，第二階段只把產物
#   複製進一個乾淨的 nginx 映像。最終映像約 50MB，
#   而且**不含任何 JavaScript 執行環境** —— 攻擊面小很多。
#
# ── build context 同樣是專案根目錄 ────────────────────────────────
#
#   前端 import 了 @digital-wealth/shared 的 .ts 原始碼（契約只有一份），
#   所以 build 時必須看得到 shared/。只複製 web/ 會直接失敗。
# ==============================================================================

# ------------------------------------------------------------------------------
# 第一階段：建置
# ------------------------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# 先相依、後原始碼 —— 同樣是 Docker layer 快取的考量
# （詳細說明見 api/Dockerfile）。
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY market-feed/package.json ./market-feed/

# npm ci 會安裝**所有** workspace 的相依。
#
# 只想裝 web 的話得用 --workspace=@digital-wealth/web，但那樣 npm 不會
# 建立 shared 的 symlink，前端就 import 不到契約層了。
# 多裝一些東西換來設定簡單，而且這一層有快取，只有 lockfile 變動才重跑。
RUN npm ci

COPY tsconfig.base.json ./
COPY shared ./shared
COPY web ./web

WORKDIR /app/web

# `npm run build` 會先跑 tsc --noEmit 再 vite build ——
# 型別錯誤會讓 **build 直接失敗**，而不是產生一個壞掉的映像。
# 這是刻意的：寧可在建置時爆掉，也不要部署一個跑起來才出錯的版本。
RUN npm run build

# ------------------------------------------------------------------------------
# 第二階段：提供服務
# ------------------------------------------------------------------------------
FROM nginx:1.27-alpine

# ⚠️ 【封版前記得回來 pin 死版本】改成 nginx:1.27.4-alpine 之類的確切版本。
#    理由同 api/Dockerfile —— README 的長期維護策略要求可重現的建置。

# 這裡可以放心用 Alpine：nginx 沒有原生 Node 模組的相容性問題
# （那正是 api 避開 Alpine 的原因）。

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 80

# nginx 官方映像的預設 CMD 已經是前景執行（daemon off），
# 而且它自己就是 PID 1，訊號處理正常，不需要額外的 entrypoint。
