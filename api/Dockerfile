# ==============================================================================
# api/Dockerfile — NestJS 後端的容器映像
#
# 這個檔案是什麼：
#   把 api 服務打包成一個 Docker 映像，讓 `docker compose up` 能一行啟動。
#
# ── 為什麼沒有 build 階段（沒有多階段建置）────────────────────────────
#
#   典型的 Node 服務 Dockerfile 會有兩階段：先 build 成 JS，再把產物複製到
#   一個乾淨的執行階段。這裡沒有，因為本專案**不做 build** ——
#   shared 直接匯出未編譯的 .ts，由 SWC 在執行期轉譯
#   （理由見 api/package.json 的「執行方式」說明）。
#
#   代價是映像裡含有開發相依（@swc/core），體積比較大。
#   接受這個代價的前提是「部署目標只有本機 Docker Compose」（adr/0004）——
#   沒有雲端頻寬成本，也沒有 cold start 的時間壓力。
#
# ── build context 是專案根目錄，不是 api/ ──────────────────────────
#
#   因為 npm workspaces 的相依關係在根目錄的 package.json 與 package-lock.json，
#   而 api 依賴 shared 的原始碼。只複製 api/ 的話裝不起來也跑不動。
#   對應的設定在 docker-compose.yml 的 `build.context: .`。
# ==============================================================================

# node:22-slim 是 Debian 基底（glibc），不是 Alpine（musl）。
#
# 為什麼避開 Alpine：@swc/core 是原生模組，musl 版的預編譯檔偶爾會缺，
# 缺了就要在容器裡從原始碼編譯 Rust，建置時間從幾十秒變成十幾分鐘。
# slim 版大約 80MB，對本機部署完全可以接受。
#
# ⚠️ 【封版前記得回來 pin 死版本】改成 node:22.14.0-slim 之類的確切版本。
#    PROJECT.md §11 的長期維護策略要求這麼做 —— `22-slim` 會隨時間變動，
#    半年後重新 build 可能行為就不一樣了。
FROM node:22-slim

WORKDIR /app

# ── 先只複製相依定義，再複製原始碼 ────────────────────────────────
#
# 這個順序是 Docker 的 layer 快取技巧：
#   Docker 會把每個指令的結果快取成一層，只有該層的輸入變了才重跑。
#
#   如果直接 `COPY . .` 再 `npm ci`，那麼**改任何一行程式碼**都會讓
#   COPY 那層失效，連帶讓 npm ci 重跑一次（要好幾十秒）。
#
#   先複製 package.json 與 lockfile 再安裝，只有相依真的變動時
#   才會重新安裝。改程式碼只會讓後面的 COPY 失效，rebuild 只要幾秒。
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/

# npm ci 而不是 npm install：
#   ci 嚴格依照 package-lock.json 安裝，不會更新 lockfile，
#   保證每次 build 裝到的版本完全一樣（可重現的建置）。
#   install 則會在必要時修改 lockfile —— 在容器裡改了也帶不回去。
RUN npm ci

# 原始碼與型別設定
COPY tsconfig.base.json ./
COPY shared ./shared
COPY api ./api

WORKDIR /app/api

# 啟動腳本：跑 migration → 視情況 seed → 啟動服務
COPY api/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

# 用 ENTRYPOINT 而不是 CMD，這樣 `docker compose run api <指令>` 傳進來的
# 參數會被當成 ENTRYPOINT 的參數，而不是整個取代掉啟動流程。
ENTRYPOINT ["docker-entrypoint.sh"]
