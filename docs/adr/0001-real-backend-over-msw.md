# ADR 0001 — 採用真實後端，而非 MSW mock

**狀態**：已採納（2026-08-27 補充 MSW 的第二個角色）｜**日期**：2026-08-13

## 背景

專案最初規劃為純前端示範，以 MSW（Mock Service Worker）攔截網路層提供假資料，靜態部署。這個方案的優點是零維運成本、無到期風險。

但金融場域最有價值的技術難點 —— **交易一致性** —— 在 mock 環境裡是演不出來的。MSW 可以回傳「下單失敗」，但那是寫死的分支，不是真的因為餘額不足而在資料庫層被拒絕。

## 決策

改用真實後端：**NestJS + PostgreSQL + Redis + WebSocket**，以 Docker Compose 打包。

MSW **保留**，角色改為**不負責「運行」，只負責「沒有後端的場合」**：

- 前端測試（`vitest`）
- GitHub Pages 的靜態展示版（見下方補充）

## 替代方案

| 方案 | 捨棄理由 |
|---|---|
| 維持 MSW mock | 無法展示 DB transaction、行鎖、冪等等金融核心難點 |
| Serverless Functions（Vercel） | WebSocket 需要長連線，serverless 不支援 |
| BaaS（Supabase / Firebase） | 交易邏輯被封裝掉，反而看不出後端能力 |

## 後果

**正面**

- 下單的 `SELECT ... FOR UPDATE`、冪等鍵、餘額扣減都是真的，樂觀更新的失敗來源也是真的
- 「MSW 跑測試、真後端跑運行」證明前端未與後端耦合死
- 專案定位從前端擴展為全端

**負面**

- 開發時程大幅拉長（多了一整個後端與基礎設施）
- 推翻了原本的靜態部署策略（見 [ADR 0004](0004-local-only-no-cloud-deploy.md)）
- 認證從 Out of scope 移入 In scope —— 真後端裸奔說不過去

---

## 2026-08-27 補充：MSW 的第二個角色

原決策把 MSW 降級為「測試專用」。實際落地時它多了一個用途：
**驅動 GitHub Pages 上的靜態展示版**（見 [ADR 0004](0004-local-only-no-cloud-deploy.md) 的修訂）。

這不牴觸原決策 —— MSW 仍然不負責「運行」，只是「沒有後端的場合」從
「跑測試時」擴大成「跑測試時，以及靜態託管時」。

有兩件事值得記下來：

1. **假資料改由 `shared/simulation` 產生**，跟真實後端 seed 用同一份規則、同一顆種子。
   否則線上版與本機版的數字會對不上，看的人會發現那是兩套東西。

2. **原決策的核心判斷仍然成立** —— 交易一致性在 mock 環境裡演不出來。
   瀏覽器的 JavaScript 是單執行緒，不可能有兩個請求同時讀到舊餘額，
   所以 `SELECT … FOR UPDATE` 要看本機版。這條界線寫在 README 第一屏。

## 相關

- [ADR 0002](0002-nestjs-over-spring-boot.md) — 後端框架選型
- [ADR 0004](0004-local-only-no-cloud-deploy.md) — 部署策略
- `docs/02-backend.md` — 完整後端規格
