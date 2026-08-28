# 07 — 程式碼閱讀指南

> 給「不知道從哪裡開始讀」的自己
> 版本 0.2｜2026-08-27｜對應進度：P0–P3 完成（僅剩 P4 的 Demo 控制台與影片）

---

## 先講最重要的一件事

**先讀地基，再讀業務邏輯。**

打開一個陌生專案時，直覺是去找「下單怎麼運作」。但這個專案的下單流程之所以那樣寫，
理由全部藏在更底層的三個檔案裡 —— 不先看那三個，`orders.service.ts` 會看起來
莫名其妙（為什麼金額要乘 100？為什麼檢查餘額要在交易裡面？）。

| 先讀（地基：在防什麼問題） | 再讀（業務：怎麼用地基） |
|---|---|
| `shared/money.ts` — 浮點誤差 | `orders.service.ts` — 下單的 11 個步驟 |
| `shared/market-rules.ts` — 台股規則只寫一次 | `portfolio.repository.ts` — 聚合查詢 |
| `database/database.service.ts` — 交易邊界 | `transactions/cursor.ts` — 為什麼不用 OFFSET |
| `common/errors/` — 錯誤契約 | `quotes/quotes.gateway.ts` — 訂閱扇出 |

下面每一節都會先講「問題是什麼」，再講「檔案怎麼解決它」。

> **完整功能清單與已知限制見 [根目錄 README](../README.md) 的「目前完成度」。**

---

## 這個專案的分層

由下往上，箭頭是「依賴方向」：

```
┌──────────────────────────────────────────────────────┐
│  web/src/routes             頁面                       │
│  web/src/features/*         功能（api 層 ＋ 元件）      │
│  web/src/shared/{ui,lib}    無業務邏輯的元件與工具      │
├──────────────────────────────────────────────────────┤
│  api/src/modules/*          業務模組（下單、報價、查詢）│
├──────────────────────────────────────────────────────┤
│  api/src/database           連線池、交易、migration     │
│  api/src/redis              Redis 連線                 │
│  api/src/config             環境變數                   │
├──────────────────────────────────────────────────────┤
│  shared/src                 契約、金額、台股規則        │
│  shared/src/simulation      假資料與價格模擬            │
│                             ★ 三個程序共用，最底層      │
└──────────────────────────────────────────────────────┘

market-feed 只依賴 shared，不依賴 api —— 兩者的唯一關係是
「一個 publish 到 Redis、一個 subscribe」。
```

**規則：箭頭只能往下。** `shared` 不准依賴 `api`，`database` 不准依賴 `modules`。這條規則讓你可以**從下往上讀**，讀到任何一層時，它依賴的東西你都已經讀過了。

---

## 建議閱讀順序

### 第一站：金額為什麼要這樣搞（30 分鐘）

**問題**：JavaScript 裡 `0.1 + 0.2 !== 0.3`。金額用浮點數存，帳遲早會對不起來。

| 順序 | 檔案 | 讀完你該能回答 |
|---|---|---|
| 1 | `shared/src/money.ts` 的檔頭註解 | 為什麼不用浮點數？ |
| 2 | `shared/src/money.test.ts` 的「★ 把帶兩位小數的元換算成分」 | 4.35 元 × 100 為什麼不等於 435？ |
| 3 | `shared/src/money.ts` 的 `Cents` 型別定義 | branded type 在防什麼？它有執行期成本嗎？ |
| 4 | `shared/src/money.ts` 的 `weightedAverageCost()` | 為什麼賣出不改變平均成本？ |

> **先讀測試再讀實作。** `money.test.ts` 的每個測試名稱都是一句完整的規格描述，讀 63 個測試名稱等於讀一份需求文件。實作看不懂時，回頭看測試在驗什麼。

**這一站的核心概念**：branded type。它讓 `pay(500)` 編譯不過 —— 因為編譯器不知道 500 是元還是分。

---

### 第二站：台股的規則（20 分鐘）

**問題**：金融 demo 最容易露餡的地方，是那些「只有懂的人才知道」的規則。

| 順序 | 檔案 | 讀完你該能回答 |
|---|---|---|
| 1 | `shared/src/market-rules.ts` 的 `TICK_SIZE_TABLE` | 1086 元為什麼不能掛單？ |
| 2 | `shared/src/market-rules.ts` 的 `calculateTradeCost()` | 買 1 股 20 元的股票，手續費是多少？ |
| 3 | `shared/src/market-rules.ts` 的 `priceLimits()` | 漲停價為什麼要「捨去」而不是四捨五入？ |

**這一站的核心概念**：規則放 `shared/` 是因為**前後端都要用**。後端算費用扣款，前端在確認頁顯示預估費用 —— 兩邊用同一份程式碼，就不可能兜不攏。

---

### 第三站：資料庫長什麼樣（40 分鐘）★ 最值得花時間

**問題**：schema 設計錯了，後面每一層都要繞路。

只讀一個檔案：**`api/src/database/migrations/001_initial_schema.sql`**

它有七張表，但只有四個地方需要真的停下來想：

| 位置 | 問題 | 為什麼重要 |
|---|---|---|
| `accounts.cash_balance_cents` 的 `CHECK (>= 0)` | 應用層已經檢查過餘額了，為什麼還要在資料庫再擋一次？ | 應用層的檢查會因為 bug 而**靜默**失效 |
| `orders` 與 `executions` 為什麼分兩張表 | 只用一張表會在哪兩種情況壞掉？ | 委託被拒、部分成交 |
| `transactions.balance_after_cents` | 這個欄位可以由前面的資料算出來，為什麼還要存？ | 讓每一筆異動能**獨立驗證**，不用重算整個歷史 |
| `idx_transactions_cursor` 這個索引 | 為什麼 cursor 要包含 `id`？ | `occurred_at` 可能重複，`id` 是決勝欄位 |

搭配 `docs/02-backend.md` 的「交易一致性設計」一節一起讀 —— 那裡有 `SELECT ... FOR UPDATE` 的時序圖，解釋為什麼不加行鎖會導致「花了 16,000 元但只扣了 8,000 元」。

---

### 第四站：假資料為什麼難（30 分鐘）

**問題**：沒有真實市場資料的金融 demo，九成垮在假資料上。

垮的方式很具體：持倉頁顯示「台積電均價 1050 元」，點進明細卻看到歷史買入都是 1200 上下 —— 對不起來，整個 demo 的可信度歸零。

| 順序 | 檔案 | 讀完你該能回答 |
|---|---|---|
| 1 | `api/src/database/seeds/factory.test.ts` | 「資料自洽」具體是指哪四條關係？ |
| 2 | `api/src/database/seeds/rng.ts` | 為什麼不能用 `Math.random()`？ |
| 3 | `api/src/database/seeds/factory.ts` 的檔頭 | 為什麼是「先產生歷史，再推導現況」？ |
| 4 | `api/src/database/seeds/factory.ts` 的 `buildPriceSeries()` | 為什麼股價要用乘法而不是加法來模擬？ |

**這一站的核心概念**：`factory.ts` 是**純函式**（不碰資料庫），所以可以直接測試「持倉成本真的等於歷史加權平均」。`seed.ts` 才負責寫入。**算什麼 / 寫到哪** 分開 —— 這個模式在業務模組裡會再出現一次（Service 算、Repository 寫）。

---

### 第五站：NestJS 怎麼組起來（30 分鐘）

**問題**：NestJS 的檔案很多，看起來每個都在「宣告一些東西」，不知道實際流程在哪。

**照這個順序讀，就是服務啟動的實際順序**：

| 順序 | 檔案 | 它在做什麼 |
|---|---|---|
| 1 | `api/src/main.ts` | 程式進入點。建立 app、設定全域前綴與 CORS、開始監聽 |
| 2 | `api/src/app.module.ts` | 功能清單。`imports` 陣列就是「這個服務有哪些功能」 |
| 3 | `api/src/database/database.module.ts` | `@Module()` 與 `@Global()` 的完整說明 |
| 4 | `api/src/database/database.service.ts` | `@Injectable()`、生命週期鉤子、交易封裝 |
| 5 | `api/src/modules/health/health.controller.ts` | `@Controller()`、依賴注入實際長什麼樣 |

**NestJS 的四個核心概念**（每個都在上面的檔案裡有完整註解）：

| 概念 | 一句話 | Spring Boot 對照 |
|---|---|---|
| `@Injectable()` | 這個類別可以被注入，框架負責建立實例 | `@Component` / `@Service` |
| `@Module()` | 一組相關的東西，`exports` 決定分享什麼出去 | `@Configuration` |
| `@Controller()` | 處理 HTTP 請求，只做「解析 → 呼叫 Service → 回傳」 | `@RestController` |
| 依賴注入 | 你宣告「我需要 X」，框架把 X 傳進來 | 一模一樣 |

> **卡住時的判準**：如果你看著 `constructor(private readonly db: DatabaseService) {}` 想不通「這東西哪來的」——答案是 `DatabaseModule` 的 `providers` 建立了它、`exports` 分享了它、`@Global()` 讓它全域可見。這條鏈路值得追一次。

---

## 「有點雜」的部分：哪些檔案可以先跳過

這些檔案現在讀不會有收穫，等用到再回來：

| 檔案 | 什麼時候再讀 |
|---|---|
| `api/src/config/env.ts` | 設定出問題時 |
| `api/src/redis/redis.service.ts` | 要理解 pub/sub 為什麼要另開連線時 |
| `api/src/database/migrate.ts` | 要新增 migration 時 |
| `api/src/database/seeds/seed.ts` | 要改 seed 寫入邏輯時 |
| `api/Dockerfile`、`web/nginx.conf`、`docker-entrypoint.sh` | 容器啟動出問題時 |
| `web/src/mocks/*` | 要改 GitHub Pages 展示版的假資料時 |
| `vitest.config.ts`、各 `tsconfig.json` | 建置出問題時 |

---

## 動手驗證（比讀程式碼有效）

```bash
# 1. 啟動全部服務（第一次會 build，約 2–3 分鐘）
docker compose up -d

# 2. 看 api 的啟動流程：migration → seed → 服務啟動
docker compose logs -f api

# 3. 健康檢查 —— 這一條通了，代表整條鏈路都通了
curl -s http://localhost:3000/api/v1/health | jq

# 4. ★ 直接看假資料，這是最快理解 schema 的方式
npm run db
```

進到 `psql` 之後，這四條查詢對應上面第三、四站的內容：

```sql
-- 持倉：均價真的是歷史加權平均嗎？
SELECT i.symbol, i.name, p.quantity, p.avg_cost_cents / 100.0 AS 均價
FROM positions p JOIN instruments i ON i.id = p.instrument_id
ORDER BY p.quantity * p.avg_cost_cents DESC;

-- 明細：結餘欄位真的連續嗎？（每筆的 balance_after = 前一筆 + amount）
SELECT occurred_at, type, description,
       amount_cents / 100.0 AS 金額,
       balance_after_cents / 100.0 AS 結餘
FROM transactions ORDER BY occurred_at DESC, id DESC LIMIT 20;

-- 手續費最低 20 元的規則，在小額交易上真的生效了嗎？
SELECT description, amount_cents / 100.0 AS 手續費
FROM transactions WHERE type = 'FEE'
ORDER BY amount_cents DESC LIMIT 10;

-- 資產走勢：總資產真的等於現金 + 市值嗎？
SELECT snapshot_date, cash_cents / 100.0 AS 現金,
       market_value_cents / 100.0 AS 市值,
       total_value_cents / 100.0 AS 總資產
FROM portfolio_snapshots ORDER BY snapshot_date DESC LIMIT 10;
```

**如果第二條查詢的結餘不連續，或第四條的總資產對不上 —— 那就是 bug，不是你看錯。** 這兩條關係有測試保護（`factory.test.ts`），理論上不會壞。

---

## 學習檢查點

讀完地基那幾站之後，用這七題自我檢查 —— **答不出來就回頭讀對應的那一站**：

1. 為什麼金額不能用 `number` 直接存？branded type 解決了什麼 `number` 解決不了的問題？（第一站）
2. 買 1 股 20 元的股票，手續費是多少？為什麼？（第二站）
3. `accounts` 已經在應用層檢查過餘額了，為什麼還要有 `CHECK (cash_balance_cents >= 0)`？（第三站）
4. `orders` 和 `executions` 為什麼要分兩張表？只用一張會在什麼情況壞掉？（第三站）
5. 明細分頁為什麼不用 `OFFSET`？cursor 為什麼要包含 `id`？（第三站）
6. seed 為什麼一定要「先產生 transactions，再推導 positions」？反過來會怎樣？（第四站）
7. `@Module()` 的 `exports` 沒寫的話會怎樣？`@Global()` 為什麼要節制使用？（第五站）

---

## 相關文件

- [`00-architecture.md`](00-architecture.md) — 系統架構總綱，動工前必讀
- [`02-backend.md`](02-backend.md) — schema、API 契約、交易一致性設計
- [`adr/`](adr/) — 每個技術決策的「為什麼不用另一個方案」
