# ADR 0010 — 用原生 SQL ＋ `pg` 驅動，不用 ORM

**狀態**：已採納｜**日期**：2026-08-15

## 背景

`docs/00-architecture.md` 與 `docs/02-backend.md` 都詳細規範了 schema、索引與交易流程，但**沒有指定資料存取層要用什麼**。這個選擇必須在寫 schema 之前定案，因為之後每一個查詢與寫入都建立在它上面。

候選：Prisma、TypeORM、Drizzle、Kysely、原生 `pg`。

## 決策

**用原生 `pg` 驅動 ＋ 手寫參數化 SQL ＋ 純 `.sql` migration 檔。**

- migration：`api/src/database/migrations/*.sql`，由自製的 40 行 runner 依檔名順序套用
- 查詢：Repository 層直接寫 SQL，一律參數化（`$1`、`$2`），禁止字串拼接
- 交易：`DatabaseService.transaction()` 統一封裝 `BEGIN` / `COMMIT` / `ROLLBACK` / `release`

## 理由

**1. 本專案最核心的技術訊號，在 ORM 底下都要繞回原生 SQL。**

README §2 把「交易一致性」列為第一順位目標。而具體的實作手法是：

| 手法 | Prisma | TypeORM |
|---|---|---|
| `SELECT ... FOR UPDATE` 行鎖 | 需 `$queryRaw` | 需 `setLock()`，語法受限 |
| `(occurred_at, id) < ($1, $2)` 列比較 cursor 分頁 | 需 `$queryRaw` | 需 `QueryBuilder` 拼字串 |
| `INSERT ... ON CONFLICT` UPSERT 持倉 | 部分支援 | 需 `orUpdate()` |

三個最重要的地方都要跳出 ORM，那 ORM 剩下的價值只有 CRUD 樣板 —— 而本專案的 CRUD 部分不多。

**2. 契約已經有單一來源了，ORM 會變成第二套模型。**

`ADR 0002` 定調「zod schema 在 `shared/` 是前後端契約的唯一來源」。引入 ORM 之後會多出一套 entity/model 定義，於是同一個欄位存在兩個地方 —— zod 一份、ORM 一份 —— 改一邊忘了另一邊就是 bug。這直接稀釋本專案最強的架構訊號。

**3. 學習目標。**

ORM 會把 SQL 藏起來 —— 讀 ORM 的 API 文件看不出「為什麼要鎖這一列」。手寫 SQL 讓每一個決定都是明示的，也讓 code review 看得到真正送到資料庫的東西。

## 替代方案

| 方案 | 捨棄理由 |
|---|---|
| **Prisma** | 行鎖與列比較都要 `$queryRaw` 繞過；schema.prisma 是第三套 schema 定義（DB、zod、Prisma）；migration 產生的 SQL 不易審閱 |
| **TypeORM** | NestJS 生態的預設選擇，但 entity 裝飾器與 zod 契約重複；`FOR UPDATE` 支援有限；設定複雜度高 |
| **Drizzle** | 型別推導很好，`FOR UPDATE` 也支援。**是最接近的候選** —— 捨棄的理由只是「多一層 DSL 要學」，而本專案的目標之一就是把 SQL 本身學會。若目標是生產力而非學習，Drizzle 是好選擇 |
| **Kysely** | 同 Drizzle，query builder 的抽象在此不划算 |

## 後果

**正面**

- 交易一致性、cursor 分頁、行鎖的實作直接可讀，不必先理解一層抽象
- 相依極少（只有 `pg`），沒有 ORM 版本升級的維護負擔
- migration 是純 SQL，任何看得懂 SQL 的人都能審閱

**負面（要誠實寫進 README）**

- **沒有編譯期的欄位型別檢查。** SQL 裡打錯欄位名要等執行時才發現。緩解方式是 Repository 的回傳型別手動標註，並靠整合測試覆蓋
- **手寫的 row → 物件轉換樣板碼。** 資料庫是 `snake_case`、TypeScript 是 `camelCase`，每個 Repository 都要寫一次映射
- **沒有 rollback migration。** 刻意不做 —— 本專案資料全由 seed 產生，出錯直接 `docker compose down -v` 重建比維護 down migration 划算。有生產資料的系統完全不適用這個取捨

**這個決策的適用範圍很窄**：單人、本機、學習導向、且交易正確性是核心賣點。多人團隊的 CRUD 系統應該選 ORM。

## 相關

- [`0002`](0002-nestjs-over-spring-boot.md) — 前後端型別共用是核心訊號
- [`0005`](0005-money-as-bigint-cents.md) — 金額用 `BIGINT` 分
- [`0011`](0011-runtime-transpile-no-build.md) — 不做 build，執行期轉譯
