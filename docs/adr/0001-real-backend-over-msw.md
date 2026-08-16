# ADR 0001 — 採用真實後端，而非 MSW mock

**狀態**：已採納｜**日期**：2026-08-13

## 背景

專案最初規劃為純前端作品集，以 MSW（Mock Service Worker）攔截網路層提供假資料，靜態部署至 Vercel。這個方案的優點是零維運成本、無到期風險。

但金融場域最有價值的技術難點 —— **交易一致性** —— 在 mock 環境裡是演不出來的。MSW 可以回傳「下單失敗」，但那是寫死的分支，不是真的因為餘額不足而在資料庫層被拒絕。

## 決策

改用真實後端：**NestJS + PostgreSQL + Redis + WebSocket**，以 Docker Compose 打包。

MSW **保留**，但角色改為**前端測試專用**。

## 替代方案

| 方案 | 捨棄理由 |
|---|---|
| 維持 MSW mock | 無法展示 DB transaction、行鎖、冪等等金融核心難點 |
| Serverless Functions（Vercel） | WebSocket 需要長連線，serverless 不支援 |
| BaaS（Supabase / Firebase） | 交易邏輯被封裝掉，反而看不出後端能力 |

## 後果

**正面**

- 下單的 `SELECT ... FOR UPDATE`、冪等鍵、餘額扣減都是真的，樂觀更新的失敗來源也是真的
- 「MSW 跑測試、真後端跑運行」證明前端未與後端耦合死，這本身是好架構訊號
- 作品集定位從前端升級為全端

**負面**

- 時程從 5 週延長至 12–16 週
- 推翻了原本的靜態部署策略（見 [ADR 0004](0004-local-only-no-cloud-deploy.md)）
- 認證從 Out of scope 移入 In scope —— 真後端裸奔說不過去

## 相關

- [ADR 0002](0002-nestjs-over-spring-boot.md) — 後端框架選型
- [ADR 0004](0004-local-only-no-cloud-deploy.md) — 部署策略
- `docs/02-backend.md` — 完整後端規格
