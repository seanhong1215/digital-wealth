# ADR 0011 — api 不做 build，改用 SWC 在執行期轉譯

**狀態**：已採納｜**日期**：2026-08-15

## 背景

`shared/package.json` 的 `exports` 直接指向未編譯的 TypeScript 原始碼（`./src/index.ts`），而不是編譯後的 `dist`。這是單元 0.2a 的既有決策，好處是改了 `shared` 的程式碼，`web` 與 `api` 立刻就看得到，不需要先 build 一次。

單元 0.6 要建立 NestJS 骨架時，這個決策撞上了三個限制：

1. **`nest build`（底層是 `tsc`）不會編譯 `rootDir` 之外的檔案。** `shared` 在 `node_modules/@fintech/shared` 的 symlink 底下，編譯直接失敗。
2. **NestJS 的依賴注入依賴 `emitDecoratorMetadata`。** 它靠編譯器寫入的 constructor 參數型別資訊，才知道要注入哪個 provider。
3. **esbuild（也就是 `tsx`）不支援 `emitDecoratorMetadata`。** 用 `tsx` 跑 NestJS 會在啟動時噴 `Nest can't resolve dependencies`。

## 決策

**api 不產生建置產物，一律用 SWC 在執行期轉譯 TypeScript。**

```
node --import @swc-node/register/esm-register src/main.ts
```

設定在 `api/.swcrc`：`legacyDecorators: true`、`decoratorMetadata: true`。

`api/tsconfig.json` 只用於 `npm run typecheck` 的型別檢查，不產生輸出。

## 替代方案

| 方案 | 捨棄理由 |
|---|---|
| **`nest build` + shared 也編譯成 dist** | 要改 `shared` 的 exports 指向 `dist`，等於推翻單元 0.2a 的決策，並讓改 shared 後必須先 build 才看得到效果 |
| **`tsx`** | 不支援 `emitDecoratorMetadata`，NestJS 的 DI 會壞掉。除非每個注入點都手寫 `@Inject(TOKEN)` —— 那是把框架的優點丟掉 |
| **`ts-node`** | 可行，但比 SWC 慢一個量級（`ts-node` 走完整 tsc 型別檢查），watch 模式的重啟延遲很有感 |
| **shared 用條件式 exports**（開發指 `src`、正式指 `dist`） | 技術上可行，但等於維護兩條路徑，且「開發跟正式跑的不是同一份程式碼」正是 Docker 化想避免的問題 |

## 後果

**正面**

- `shared` 維持「改了立刻生效」的體驗，前後端都是
- 開發與容器內跑的是**完全相同的路徑**，沒有「build 出來才壞掉」這種問題
- 少一個 build 步驟，Dockerfile 更短、CI 更快

**負面**

- **每次啟動要付轉譯成本**（本專案約 1–2 秒）。可接受的前提是不做雲端部署（`ADR 0004`），沒有 cold start 的壓力
- **容器映像含開發相依**（`@swc/core` 約 40MB）。本機部署沒有頻寬成本
- **`.swcrc` 與 `tsconfig.json` 的設定要手動保持一致。** 兩者語意不同步時，型別檢查過了但執行期壞掉。緩解：兩個檔案都寫了註解互相指涉
- **`docker-entrypoint.sh` 的啟動指令與 `package.json` 的 `start` script 重複。** 因為要 `exec node` 而非 `exec npm`（訊號傳遞），無法共用

**若日後要部署到雲端**，這個決策要重新評估 —— 屆時 cold start 時間與映像體積都會變成真實成本。

## 相關

- [`0004`](0004-local-only-no-cloud-deploy.md) — 只做本機 Docker Compose
- [`0010`](0010-raw-sql-over-orm.md) — 原生 SQL，不用 ORM
