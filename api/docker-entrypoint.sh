#!/bin/sh
# ==============================================================================
# api/docker-entrypoint.sh — 容器啟動流程
#
# 這個檔案是什麼：
#   api 容器啟動時實際執行的腳本。依序做三件事：
#     1. 套用資料庫 migration
#     2. 在資料庫是空的時候寫入 seed 資料
#     3. 啟動 API 服務
#
# 為什麼要有這支腳本（不能直接 CMD 啟動服務）：
#   PROJECT.md 的 P0 完成判準是「docker compose up 一行啟動，無任何手動步驟，
#   psql 看得到假資料」。如果使用者還要自己下 migrate 跟 seed，
#   那就不算一行啟動了。
#
# 為什麼 seed 帶 --if-empty：
#   容器每次重啟都會跑這支腳本。沒有這個旗標的話，demo 過程中重啟一次，
#   下過的單、切換過的情境就全部被洗掉了。
#   要強制重建資料時，執行：
#     docker compose exec api npm run seed
# ==============================================================================

# set -e：任何一個指令失敗就立刻結束整個腳本。
#
# 沒有這行的話，migration 失敗了腳本還是會繼續往下跑，
# 最後啟動一個連不上正確結構的服務 —— 症狀會是各種難以理解的 SQL 錯誤，
# 而真正的原因（migration 沒跑成功）已經被沖到日誌很上面看不到了。
set -e

echo "── 套用資料庫 migration ──────────────────────────────"
npm run migrate

echo ""
echo "── 檢查種子資料 ──────────────────────────────────────"
npm run seed -- --if-empty

echo ""
echo "── 啟動 API 服務 ─────────────────────────────────────"
# exec 讓後面的行程「取代」這支 shell，而不是變成它的子行程。
#
# 這件事很重要：Docker 送出的停止訊號（SIGTERM）只會送給容器內的
# 1 號行程。如果 node 是子行程，它收不到訊號，容器會等 10 秒逾時後
# 被強制砍掉 —— NestJS 的 onModuleDestroy 就沒有機會執行，
# 連線池與 Redis 連線都不會被好好關閉。
#
# ⚠️ 這裡刻意**不用** `exec npm run start`。
#    npm 會自己再開一個子行程來跑 node，所以 exec 之後 PID 1 是 npm、
#    node 仍然是子行程，訊號一樣傳不到。直接 exec node 才真的解決問題。
#    代價是這行指令與 package.json 的 start script 重複，改一邊要記得改另一邊。
exec node --env-file-if-exists=../.env --import @swc-node/register/esm-register src/main.ts
