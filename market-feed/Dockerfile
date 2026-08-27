# ==============================================================================
# market-feed/Dockerfile — 報價產生器的容器映像
#
# 結構與 api/Dockerfile 幾乎相同（同樣是執行期用 SWC 轉譯 .ts，
# 所以沒有多階段建置）。差別只有兩點：
#   · 不需要 EXPOSE —— 它只對外 publish 到 Redis，不接受任何連線
#   · 不需要 entrypoint 腳本 —— 沒有 migration 要跑
#
# ── 這個容器存在的意義 ★ ──────────────────────────────────────────
#
#   它可以被單獨關掉：
#
#     docker compose stop market-feed
#
#   五秒之內，前端會顯示「報價來源目前沒有更新」，價格轉為最後收到的
#   數值，而持倉、明細、下單通通照常運作。
#
#   這是 README 的 P2 完成判準，也是整個專案「降級是設計的一部分」
#   這個主張唯一能當場演示的證據。把報價邏輯塞進 api 就演不出來了。
# ==============================================================================

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY market-feed/package.json ./market-feed/

RUN npm ci

COPY tsconfig.base.json ./
COPY shared ./shared
COPY market-feed ./market-feed

WORKDIR /app/market-feed

# 直接 exec node，不要透過 npm ——
# npm 會多開一個子行程，SIGTERM 就送不到真正在跑的 node 上，
# 容器會等 10 秒逾時才被強制砍掉（詳見 api/docker-entrypoint.sh 的說明）。
# 而這個服務正是要用來演示「乾脆地關掉」，停得慢就很難看。
CMD ["node", "--import", "@swc-node/register/esm-register", "src/main.ts"]
