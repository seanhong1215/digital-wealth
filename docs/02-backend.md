# 02 — 後端架構規格

> 情境 D 產出｜NestJS + PostgreSQL + Redis
> 版本 0.1｜2026-08-13｜維護者：Shawn Ben

**本文件分兩部分：**

- **Part 1 — 資料層**（本次產出）：ER 關係、Schema 定義、索引、金額型別、交易一致性
- **Part 2 — 介面層**（下次產出）：REST API 表、WebSocket 協定、統一錯誤碼、認證設計

---

# Part 1 — 資料層

## 需求確認

### 系統邊界

一個**虛構券商的帳務與交易核心**，負責四件事：

1. 保管帳戶餘額與持倉（權威資料）
2. 接受下單、扣款、更新持倉（**需要交易一致性**）
3. 提供查詢：總覽、持倉、交易明細
4. 廣播即時報價（透過 Redis，不落地資料庫）

### 已確認

| 項目 | 內容 |
|---|---|
| 資料規模 | 持倉 8–15 檔；交易明細 3,000 筆（`active`）／8,000 筆（`heavy-history`） |
| 使用者數 | **單一 demo 帳號**，不做註冊與多租戶 |
| API 風格 | REST（查詢與寫入）＋ WebSocket（報價推送） |
| 認證 | 最小 JWT，不做 OAuth |
| 即時需求 | 報價 tick 推送，預設 1000ms |
| 排程任務 | 每日資產快照（MVP 由 seed 預先產生，不做真排程） |

### 已定案的三個問題

| 問題 | 決定 | 理由 |
|---|---|---|
| 是否支援市價單 | **只做限價單** | 市價單的成交價要由撮合引擎決定，而本專案的撮合是模擬的 —— 憑空捏造一個市價反而降低可信度。限價單的成交價＝使用者填的價格，這個模擬是誠實的 |
| 是否允許部分成交 | **全部成交或全部拒絕** | 部分成交會讓狀態機複雜一倍。但 `orders` / `executions` 分表已為它預留空間，之後要加不必改資料模型 |
| 是否記錄股利 | **記錄** | 成本低（seed 多產生一種 transaction type），而明細裡有股利會真實得多 |

---

## 資料庫設計

### ER 圖說明

```
users (1) ──< (N) accounts
                   │
                   ├──< (N) positions >── (1) instruments
                   │
                   ├──< (N) orders ──< (N) executions
                   │         │
                   │         └── (1) instruments
                   │
                   ├──< (N) transactions          ← 帳務流水，明細頁的資料來源
                   │         │
                   │         ├── (0..1) orders    ← 買賣類異動才有
                   │         └── (0..1) instruments
                   │
                   └──< (N) portfolio_snapshots   ← 每日快照，走勢曲線的資料來源
```

**關係說明：**

- 一個 `user` 有多個 `account`（MVP 只有一個，但保留擴充）
- `positions` 是**當前狀態**（每檔標的一列，UNIQUE），由歷史成交推導而來
- `orders` 是**委託**（意圖），`executions` 是**成交**（結果）。分開的原因：一筆委託可能被拒絕、可能分批成交
- `transactions` 是**帳務流水帳**，明細頁直接讀這張表。買賣、手續費、稅、股利、入出金都在這裡
- `portfolio_snapshots` 是**每日資產快照**。走勢曲線不即時計算，直接讀快照

### 為什麼 `orders` 和 `executions` 要分開

新手最常見的做法是只用一張 `orders` 表，把成交價塞進去。這在下面兩個情況會壞掉：

1. **委託被拒絕** —— 這筆委託存在（要顯示在明細裡），但沒有成交價
2. **部分成交** —— 一筆 1000 股的委託分三次成交，成交價各不同

真實券商一定是分開的。MVP 雖然只做「全成或全拒」，但**表結構先做對，之後不用改 schema**。

### Schema 定義

#### `users`

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK, `DEFAULT gen_random_uuid()` |
| `email` | `VARCHAR(255)` | 登入帳號 | UNIQUE, NOT NULL |
| `password_hash` | `VARCHAR(255)` | bcrypt 雜湊 | NOT NULL |
| `display_name` | `VARCHAR(50)` | 顯示名稱 | NOT NULL |
| `created_at` | `TIMESTAMPTZ` | 建立時間 | NOT NULL, `DEFAULT now()` |

#### `accounts`

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK |
| `user_id` | `UUID` | 所屬使用者 | FK → `users.id`, NOT NULL |
| `account_no` | `VARCHAR(20)` | 顯示用帳號（`1234-5678`） | UNIQUE, NOT NULL |
| `cash_balance_cents` | `BIGINT` | **可用現金（單位：分）** | NOT NULL, `CHECK (>= 0)` |
| `currency` | `CHAR(3)` | 幣別 | NOT NULL, `DEFAULT 'TWD'` |
| `created_at` | `TIMESTAMPTZ` | | NOT NULL, `DEFAULT now()` |
| `updated_at` | `TIMESTAMPTZ` | | NOT NULL, `DEFAULT now()` |

> `CHECK (cash_balance_cents >= 0)` 是**最後一道防線**。應用層應該先擋下餘額不足，但如果程式有 bug，資料庫會直接拒絕寫入而不是讓餘額變成負數。金融系統一定要有這層。

#### `instruments`

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK |
| `symbol` | `VARCHAR(10)` | 股票代號（`2330`） | UNIQUE, NOT NULL |
| `name` | `VARCHAR(50)` | 名稱（`台積電`） | NOT NULL |
| `market` | `VARCHAR(10)` | `TWSE` / `TPEX` | NOT NULL |
| `lot_size` | `INT` | 一張的股數 | NOT NULL, `DEFAULT 1000` |
| `prev_close_cents` | `BIGINT` | **昨日收盤價（分／股）** | NOT NULL |
| `is_active` | `BOOLEAN` | 是否可交易 | NOT NULL, `DEFAULT true` |

> **`prev_close_cents` 是漲跌計算的基準。** 漲跌幅 = (現價 − 昨收) / 昨收。這個欄位放在標的表而不是每次查詢時計算，是因為它一天只變一次。
>
> **台股的最小跳動單位（tick size）是分級的**：股價 <10 元跳 0.01、10–50 跳 0.05、50–100 跳 0.1、100–500 跳 0.5、500–1000 跳 1、>1000 跳 5。這個規則**用函式實作在 `shared/` 而不是存成欄位** —— 它是規則不是資料，且會隨股價變動。

#### `positions`

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK |
| `account_id` | `UUID` | 帳戶 | FK, NOT NULL |
| `instrument_id` | `UUID` | 標的 | FK, NOT NULL |
| `quantity` | `BIGINT` | **持有股數** | NOT NULL, `CHECK (>= 0)` |
| `avg_cost_cents` | `BIGINT` | **平均成本（分／股）** | NOT NULL |
| `updated_at` | `TIMESTAMPTZ` | | NOT NULL |
| | | | **UNIQUE (`account_id`, `instrument_id`)** |

> **關於 `quantity` 用 `BIGINT` 而非 `NUMERIC`：**
>
> 原本規劃「零股數量另以 decimal 字串處理」，但這對台股是**不必要的**——台股零股交易的最小單位是 **1 股（整數）**，不存在 0.5 股。用 `BIGINT` 就完全足夠。
>
> 需要 `NUMERIC` 的是**美股的碎股（fractional shares）**，可以買 0.137 股 AAPL。若未來要支援美股情境，這個欄位要改型別，而且 `shared/money.ts` 也要跟著加小數運算。
>
> 重點是**知道規則差異**，而不是無腦套用「金融就要用 decimal」。

#### `orders`（委託）

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK |
| `account_id` | `UUID` | 帳戶 | FK, NOT NULL |
| `instrument_id` | `UUID` | 標的 | FK, NOT NULL |
| `side` | `VARCHAR(4)` | `BUY` / `SELL` | NOT NULL |
| `order_type` | `VARCHAR(10)` | `LIMIT`（MVP 只做限價） | NOT NULL |
| `quantity` | `BIGINT` | 委託股數 | NOT NULL, `CHECK (> 0)` |
| `limit_price_cents` | `BIGINT` | 限價（分／股） | NOT NULL |
| `status` | `VARCHAR(12)` | `PENDING`／`FILLED`／`REJECTED` | NOT NULL |
| `reject_reason` | `VARCHAR(50)` | 拒絕原因代碼 | NULL |
| `idempotency_key` | `VARCHAR(64)` | **冪等鍵** | **UNIQUE**, NOT NULL |
| `created_at` | `TIMESTAMPTZ` | | NOT NULL |
| `updated_at` | `TIMESTAMPTZ` | | NOT NULL |

> **`idempotency_key` 的 UNIQUE 約束是雙保險。**
>
> 第一道防線是 Redis（`SET NX EX 300`），快但**不持久** —— Redis 重啟就沒了。
> 第二道防線是這個 UNIQUE 約束，慢但**絕對可靠** —— 重複插入會直接報錯。
>
> 兩道都要有：Redis 擋掉 99% 的重複請求（毫秒級），資料庫擋掉剩下的邊緣情況。

#### `executions`（成交）

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK |
| `order_id` | `UUID` | 所屬委託 | FK, NOT NULL |
| `filled_quantity` | `BIGINT` | 成交股數 | NOT NULL, `CHECK (> 0)` |
| `filled_price_cents` | `BIGINT` | 成交價（分／股） | NOT NULL |
| `fee_cents` | `BIGINT` | 手續費 | NOT NULL, `CHECK (>= 0)` |
| `tax_cents` | `BIGINT` | 證交稅 | NOT NULL, `CHECK (>= 0)` |
| `executed_at` | `TIMESTAMPTZ` | 成交時間 | NOT NULL |

> **台股的費用規則（值得如實實作，細節會讓 demo 可信度大幅提升）：**
>
> - **手續費**：成交金額 × 0.1425%，**最低 20 元**。買賣都收
> - **證交稅**：成交金額 × 0.3%，**只有賣出時收**
>
> 「最低 20 元」這個規則特別值得做 —— 買 1 股 20 元的股票，手續費也是 20 元。新手很容易漏掉這個下限，而它在小額交易時影響巨大。

#### `transactions`（帳務流水 ★ 明細頁的資料來源）

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK |
| `account_id` | `UUID` | 帳戶 | FK, NOT NULL |
| `type` | `VARCHAR(12)` | 見下方列舉 | NOT NULL |
| `instrument_id` | `UUID` | 標的（入出金時為 NULL） | FK, NULL |
| `quantity` | `BIGINT` | 股數（非交易類為 NULL） | NULL |
| `price_cents` | `BIGINT` | 單價（非交易類為 NULL） | NULL |
| `amount_cents` | `BIGINT` | **對餘額的影響：正為入、負為出** | NOT NULL |
| `balance_after_cents` | `BIGINT` | **異動後餘額** | NOT NULL |
| `order_id` | `UUID` | 關聯委託 | FK, NULL |
| `description` | `VARCHAR(100)` | 顯示文字 | NOT NULL |
| `occurred_at` | `TIMESTAMPTZ` | 發生時間 | NOT NULL |

**`type` 列舉**：`BUY`／`SELL`／`FEE`／`TAX`／`DIVIDEND`／`DEPOSIT`／`WITHDRAWAL`

> **`balance_after_cents`（結餘）是真實帳務系統的標準欄位。**
>
> 它讓每一筆異動都可以獨立驗證：`前一筆的 balance_after + 這筆的 amount == 這筆的 balance_after`。對帳時不用把整個歷史重算一遍。
>
> **代價**：它必須在**同一個資料庫交易內**計算並寫入，否則併發下單會產生錯誤的結餘。這正是下單流程必須用行鎖的原因之一。
>
> 這個欄位的存在，是「資料要怎麼被稽核」而不只是「資料要怎麼被顯示」的結果。

#### `portfolio_snapshots`（每日資產快照）

| 欄位 | 型別 | 說明 | 約束 |
|---|---|---|---|
| `id` | `UUID` | 主鍵 | PK |
| `account_id` | `UUID` | 帳戶 | FK, NOT NULL |
| `snapshot_date` | `DATE` | 快照日期 | NOT NULL |
| `cash_cents` | `BIGINT` | 現金部位 | NOT NULL |
| `market_value_cents` | `BIGINT` | 持股市值 | NOT NULL |
| `total_value_cents` | `BIGINT` | 總資產 | NOT NULL |
| | | | **UNIQUE (`account_id`, `snapshot_date`)** |

> **為什麼走勢曲線不即時計算？**
>
> 要畫近 30 天的資產曲線，即時算的話得對每一天重建「當天持倉 × 當天收盤價」，等於把整個交易歷史重播 30 次。快照表用空間換時間，一天一列，30 天就是 30 列。
>
> 這是**預先計算（pre-aggregation）** 的典型應用場景。真實系統會用排程每日收盤後寫入；MVP 由 seed 直接產生。

---

## 索引建議

| 資料表 | 索引 | 用途 | 為什麼需要 |
|---|---|---|---|
| `transactions` | `(account_id, occurred_at DESC, id DESC)` | **明細頁 cursor 分頁** | 見下方專節 |
| `transactions` | `(account_id, type)` | 類型篩選 | 篩選「只看買進」時避免全表掃描 |
| `orders` | `(idempotency_key)` UNIQUE | 冪等保證 | 資料庫層的重複防線 |
| `orders` | `(account_id, created_at DESC)` | 委託查詢 | — |
| `positions` | `(account_id, instrument_id)` UNIQUE | 持倉唯一性 | 防止同一標的出現兩列 |
| `executions` | `(order_id)` | 查詢委託的成交 | 外鍵查詢 |
| `instruments` | `(symbol)` UNIQUE | 代號查詢 | 下單時以代號找標的 |
| `portfolio_snapshots` | `(account_id, snapshot_date)` UNIQUE | 走勢查詢 | 兼防重複寫入 |

### 明細分頁為什麼是複合索引 `(account_id, occurred_at DESC, id DESC)`

**先說為什麼不用 `OFFSET`：**

```sql
-- ❌ offset 分頁：翻到第 100 頁時，資料庫要先掃描並丟棄前 2970 筆
SELECT * FROM transactions WHERE account_id = $1
ORDER BY occurred_at DESC LIMIT 30 OFFSET 2970;
```

翻越後面越慢，而且**如果翻頁期間有新資料插入，會出現重複或遺漏的項目**。無限捲動的場景這問題特別明顯。

**cursor 分頁：**

```sql
-- ✅ cursor 分頁：直接從上次的位置往下取，永遠是同樣的成本
SELECT * FROM transactions
WHERE account_id = $1
  AND (occurred_at, id) < ($2, $3)   -- 上一頁最後一筆的位置
ORDER BY occurred_at DESC, id DESC
LIMIT 30;
```

**為什麼 cursor 要包含 `id`？**

因為 `occurred_at` **可能重複** —— 同一秒可能有多筆交易（尤其 seed 產生的資料）。只用 `occurred_at` 當游標的話，時間相同的那幾筆會排序不穩定，翻頁時可能跳過或重複。

`id` 在這裡是 **tie-breaker（決勝欄位）**，保證排序絕對唯一。索引的欄位順序必須和 `ORDER BY` 完全一致，資料庫才能直接沿著索引讀取，不需要額外排序。

---

## 資料庫選型建議

### 為什麼是 PostgreSQL

| 需求 | PostgreSQL 的支援 |
|---|---|
| 下單的原子性 | 完整 ACID 交易，`BEGIN`／`COMMIT`／`ROLLBACK` |
| 防止併發超買 | `SELECT ... FOR UPDATE` 行鎖 |
| 金額精度 | `BIGINT` 精確整數，或 `NUMERIC` 任意精度 |
| 餘額不可為負 | `CHECK` 約束，資料庫層強制 |
| 冪等保證 | UNIQUE 約束 |
| 複合索引與 cursor 分頁 | 多欄位索引、`ROW` 比較語法 |

### 為什麼不用另一個方案

| 替代方案 | 捨棄理由 |
|---|---|
| **MongoDB** | 交易保證較弱、跨文件交易成本高。金額扣減與持倉更新必須原子完成，這是關聯式資料庫的主場 |
| **MySQL** | 也可以做，但 PostgreSQL 的 `CHECK` 約束、`NUMERIC`、`ROW` 比較語法更完整，且業界在新專案的採用趨勢偏 PostgreSQL |
| **SQLite** | 單檔案很適合 demo，但無法展示連線池、行鎖競爭等真實情境。且 Docker Compose 的價值就在於「跑真的服務」 |

---

## 金額型別決策 ★

### 決定：`BIGINT`，單位為「分」

| 方案 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| **`BIGINT`（分）** | 精確、運算快、與 JS `number` 安全整數範圍相容 | 需在邊界做單位轉換 | ✅ **採用** |
| `NUMERIC(20,4)` | 精確、可存小數 | 運算較慢；JS 沒有原生對應型別，取出來是字串，每次都要轉 | ❌ |
| `DOUBLE PRECISION` | 直覺 | **浮點誤差**。`0.1 + 0.2 !== 0.3` | ❌ **絕對不可** |

### 範圍檢查

`BIGINT` 上限約 9.2 × 10¹⁸ 分 = 9.2 × 10¹⁶ 元。遠超任何需求。

但要注意 **JavaScript 的 `Number.MAX_SAFE_INTEGER` 是 9,007,199,254,740,991（約 9 × 10¹⁵）**，換算約 90 兆元。本專案的資料量級（帳戶餘額百萬級）完全安全，但如果未來要處理超大金額，就得改用 `BigInt`。

**這個上限值得在 `shared/money.ts` 裡寫成註解與執行期檢查** —— 展示你知道邊界在哪，而不是假設永遠不會到。

### 與前端的對接

```
資料庫 BIGINT (分)  →  API JSON number (分)  →  前端 Cents 型別  →  MoneyText 元件顯示 "NT$ 1,234.56"
```

**後端永遠不回傳格式化字串。** 千分位、幣別符號、小數位數都是前端的事。

---

## 交易一致性設計 ★ 本專案最高價值的部分

### 下單的完整流程

```
[交易外] 1. Redis 冪等檢查：SET idem:{key} NX EX 300
            → 已存在則直接回傳「重複請求」

BEGIN;
         2. 鎖住帳戶：SELECT cash_balance_cents FROM accounts
                      WHERE id = $1 FOR UPDATE;
         3. 計算所需金額（股款 + 手續費 + 稅）
         4. 檢查餘額是否足夠 → 不足則 ROLLBACK 並回傳錯誤
         5. INSERT orders (status = 'PENDING')
         6. 模擬撮合 → INSERT executions
         7. UPDATE accounts SET cash_balance_cents = ...
         8. UPSERT positions（更新股數與平均成本）
         9. INSERT transactions（含 balance_after_cents）
        10. UPDATE orders SET status = 'FILLED'
COMMIT;
```

### 為什麼一定要 `SELECT ... FOR UPDATE`

**不加會發生什麼（經典的 lost update）：**

```
時間  請求 A                        請求 B
 t1   讀取餘額 = 10,000 元
 t2                                 讀取餘額 = 10,000 元
 t3   檢查：買 8,000 元 → 夠
 t4                                 檢查：買 8,000 元 → 夠
 t5   寫入餘額 = 2,000 元
 t6                                 寫入餘額 = 2,000 元   ← A 的扣款被覆蓋掉了

結果：花了 16,000 元，但餘額只扣了 8,000 元
```

這叫 **TOCTOU（Time-of-check to time-of-use）**問題 —— 檢查的時間點和使用的時間點之間，狀態被別人改了。

`FOR UPDATE` 會**鎖住那一列**，請求 B 的 `SELECT` 會卡住等待，直到 A 的交易 `COMMIT` 或 `ROLLBACK`。B 醒來後讀到的是 2,000 元，檢查就會正確地失敗。

### 隔離等級的選擇

| 選項 | 做法 | 取捨 |
|---|---|---|
| **`READ COMMITTED` + 顯式 `FOR UPDATE`** | PostgreSQL 預設等級，手動鎖住要保護的列 | ✅ **採用**。鎖的範圍明確、效能好、行為容易推理 |
| `SERIALIZABLE` | 資料庫自動偵測衝突 | 不用手動鎖，但**衝突時交易會失敗**，應用層必須實作重試邏輯。且在高併發下效能損失明顯 |

選 `READ COMMITTED` + `FOR UPDATE` 的另一個理由：**它強迫你想清楚「要鎖什麼」**，這個思考過程本身就是要展示的能力。

### 冪等鍵的 TTL 為什麼是 5 分鐘

- **太短（如 5 秒）**：使用者網路卡頓後重送，可能已超過視窗，變成重複下單
- **太長（如永久）**：Redis 記憶體無限增長，且合法的「稍後再下一筆一樣的單」會被誤擋
- **5 分鐘**：涵蓋所有合理的網路重試與使用者連點情境，且記憶體可控

真正的保證是資料庫的 UNIQUE 約束（永久有效）；Redis 只是**快速路徑**，讓 99% 的重複請求不需要走到資料庫。

---

## 種子資料設計

### 情境（`AccountScenario`）

| 情境 | 內容 | 用途 |
|---|---|---|
| `new-user` | 現金 100 萬，無持倉、無明細 | 測空狀態 |
| `active` | 8–15 檔持倉、3,000 筆明細、混合損益 | **預設情境** |
| `insufficient` | 現金 500 元 | 測下單餘額不足 |
| `heavy-history` | 8,000 筆明細 | 壓測虛擬滾動 |

### 兩條硬性規則

**1. 一律使用相對時間，絕不寫死日期**

```ts
// ❌ 半年後打開，明細停在去年，可信度歸零
occurredAt: new Date('2026-08-13')

// ✅ 永遠都是「最近 30 天」
occurredAt: subDays(new Date(), randomInt(0, 30))
```

**2. 固定亂數種子（`seed`），確保情境可重現**

同一個 `seed` + 同一個 `scenario`，每次產生的資料必須完全一致。否則重整一次數字就全變了，看的人會困惑。

實作上用一個可帶種子的偽亂數產生器（如 `mulberry32`），而不是 `Math.random()`。

### Factory 簽章

```ts
makeAccount(seed: number, scenario: AccountScenario): AccountSeed
makePositions(seed: number, scenario: AccountScenario): PositionSeed[]
makeTransactions(seed: number, scenario: AccountScenario): TransactionSeed[]
makeSnapshots(seed: number, scenario: AccountScenario): SnapshotSeed[]
```

**產生順序有依賴**：先有 `transactions`（歷史成交），才能推導出 `positions`（當前持倉）與 `snapshots`（每日快照）。這樣產出的資料才是**自洽的** —— 持倉的平均成本真的等於歷史買入的加權平均，而不是隨便給一個數字。

> 資料自洽性是 demo 可信度的關鍵。如果有人心算發現「持倉成本跟明細對不上」，整個 demo 的可信度就崩了。

---

## 替代方案與不選的理由（Part 1 總表）

| 我們的選擇 | 沒選的方案 | 捨棄理由 |
|---|---|---|
| PostgreSQL | MongoDB | 下單需要 ACID 與行鎖，文件資料庫的交易保證不足 |
| `BIGINT`（分） | `NUMERIC` | JS 無原生對應型別，每次取值都要字串轉換 |
| `BIGINT`（分） | `DOUBLE PRECISION` | 浮點誤差在金融系統不可接受 |
| `quantity` 用 `BIGINT` | `NUMERIC` | 台股零股最小單位是 1 股（整數），不需要小數 |
| `orders` / `executions` 分表 | 單張 `orders` 表 | 委託被拒與部分成交的情況無法表達 |
| cursor 分頁 | `OFFSET` 分頁 | 深頁查詢慢，且翻頁期間插入資料會重複或遺漏 |
| `READ COMMITTED` + `FOR UPDATE` | `SERIALIZABLE` | 需要實作重試邏輯，且鎖的範圍不明確 |
| 快照表存資產曲線 | 即時重算歷史 | 重算等於把交易歷史重播 30 次 |
| Redis + DB UNIQUE 雙層冪等 | 只用其中一層 | Redis 不持久、DB 較慢，兩層互補 |

---

# Part 2 — 介面層

## API 設計

所有端點前綴 `/api/v1`。所有金額欄位單位皆為**分（cents）**，型別為 JSON number。

### 認證

| Method | Path | 說明 | Request | Response |
|---|---|---|---|---|
| `POST` | `/auth/login` | 登入，簽發 JWT | `{ email, password }` | `{ user, account }` ＋ Set-Cookie |
| `POST` | `/auth/logout` | 登出，清除 cookie | — | `204` |
| `GET` | `/auth/me` | 取得當前使用者 | — | `{ user, account }` |

### 帳戶與投組

| Method | Path | 說明 | Request | Response |
|---|---|---|---|---|
| `GET` | `/accounts/me` | 帳戶餘額 | — | `{ id, accountNo, cashBalanceCents, currency }` |
| `GET` | `/portfolio/summary` | 總覽聚合 | — | `{ cashCents, marketValueCents, totalValueCents, realizedPnlCents, todayPnlCents }` |
| `GET` | `/portfolio/snapshots` | 資產走勢 | `?days=30` | `[{ date, totalValueCents, cashCents, marketValueCents }]` |
| `GET` | `/positions` | 持倉列表 | — | `[{ instrument, quantity, avgCostCents, prevCloseCents }]` |

> **`/portfolio/summary` 不含「未實現損益」。** 未實現損益需要即時報價，由前端用 WebSocket 收到的最新價自行計算（見 `00-architecture.md` 的「權威值 vs 衍生值」）。後端只回傳**已實現損益**與成本基礎。

### 標的與明細

| Method | Path | 說明 | Request | Response |
|---|---|---|---|---|
| `GET` | `/instruments` | 搜尋標的 | `?q=2330&limit=20` | `[{ id, symbol, name, market, lotSize, prevCloseCents }]` |
| `GET` | `/instruments/:symbol` | 單一標的 | — | `{ ... }` |
| `GET` | `/transactions` | **明細（cursor 分頁）** | 見下 | `{ items: [...], nextCursor: string \| null }` |

**`/transactions` 查詢參數：**

| 參數 | 型別 | 說明 |
|---|---|---|
| `cursor` | `string?` | 上一頁回傳的 `nextCursor`，格式為 `base64(occurredAt,id)` |
| `limit` | `number` | 每頁筆數，預設 30，上限 100 |
| `type` | `string?` | 篩選類型，可多值（`BUY,SELL`） |
| `from` / `to` | `string?` | 日期區間（ISO 8601） |

> **`nextCursor` 用 base64 編碼而不是直接暴露 `occurredAt` 與 `id`**，是為了讓 cursor 成為**不透明字串（opaque token）**。前端不該解析它、也不該自己組。這樣未來改變排序欄位時，前端不用改。

### 下單

| Method | Path | 說明 | Request | Response |
|---|---|---|---|---|
| `POST` | `/orders` | **送出委託** | 見下 | `{ order, execution, account }` |
| `GET` | `/orders/:id` | 查詢委託 | — | `{ order, executions }` |
| `POST` | `/orders/preview` | **試算**（費用、總金額） | 同下單 | `{ grossCents, feeCents, taxCents, netCents }` |

**`POST /orders` Request：**

```jsonc
{
  "idempotencyKey": "uuid-v4",   // 前端在進入確認頁時產生，整個流程共用同一把
  "symbol": "2330",
  "side": "BUY",                 // BUY | SELL
  "orderType": "LIMIT",
  "quantity": 1000,              // 股數（整數）
  "limitPriceCents": 108500      // 每股 1085.00 元
}
```

> **`idempotencyKey` 由前端產生，時機是「進入確認頁時」而不是「按下送出時」。**
>
> 如果在送出時才產生，使用者連點兩次會產生兩把不同的 key，冪等就失效了。在進入確認頁時產生並存在該步驟的狀態裡，連點多少次都是同一把。

> **`/orders/preview` 存在的理由**：確認頁要顯示「股款 1,085,000 元 + 手續費 1,546 元 = 總計 1,086,546 元」。這個計算必須由**後端算**，因為費率規則（0.1425%、最低 20 元、賣出加 0.3% 稅）是業務規則，前後端各算一次就會有兜不攏的風險。
>
> **修正（2026-08-15）**：本段原寫「股款 108,500 元 + 手續費 154 元 = 總計 108,654 元」，是算術錯誤 —— 上面 request 範例的 `limitPriceCents: 108500`（每股 1085 元）× `quantity: 1000` 股 = **1,085,000 元**，不是 108,500 元。手續費與總計也跟著少一位。正確值已寫成 `shared/src/market-rules.test.ts` 的測試案例。

### Demo 控制台

| Method | Path | 說明 | Request |
|---|---|---|---|
| `GET` | `/demo/state` | 取得當前情境與故障設定 | — |
| `POST` | `/demo/scenario` | 切換帳戶情境（會重建 seed 資料） | `{ scenario, seed? }` |
| `POST` | `/demo/faults` | 設定故障注入 | `{ faults: string[] }` |
| `POST` | `/demo/reset` | 回到 `active` 並清除所有故障 | — |

> 這組端點僅在 `NODE_ENV !== 'production'` 或 `ENABLE_DEMO=1` 時掛載。以 NestJS 的**動態模組**（`DemoModule.forRoot({ enabled })`）實作，關閉時整個模組不註冊，路由不存在（回 404），而不是掛上去再擋。

### 系統

| Method | Path | 說明 |
|---|---|---|
| `GET` | `/health` | 健康檢查：回報 DB 與 Redis 連線狀態 |

---

## WebSocket 協定

**端點**：`ws://localhost:3000/api/ws/quotes`

> **路徑修正（實作時發現）**：原訂 `/ws/quotes`，但存放 JWT 的 cookie 設了 `path=/api`（刻意收斂，見認證設計）。cookie 的 path 限制由**瀏覽器**執行 —— WebSocket 不在 `/api` 底下的話，握手請求完全不帶 cookie，後端只會看到匿名連線。放寬 cookie path 是退步，所以改為把 WS 端點移進 `/api`。
**認證**：連線時帶上 cookie（與 REST 相同），Gateway 在 `handleConnection` 驗證

### 訊息格式

所有訊息都是 JSON，都有 `type` 欄位。

**Client → Server：**

```jsonc
{ "type": "subscribe",   "symbols": ["2330", "2454"] }
{ "type": "unsubscribe", "symbols": ["2454"] }
{ "type": "ping" }
```

**Server → Client：**

```jsonc
// 報價更新（最頻繁）
{
  "type": "quote",
  "data": {
    "symbol": "2330",
    "priceCents": 108500,
    "prevCloseCents": 107000,
    "volume": 12345,
    "at": "2026-08-13T01:23:45.678Z"
  }
}

{ "type": "pong" }
{ "type": "error", "code": "SUBSCRIPTION_LIMIT", "message": "..." }
```

### 訂閱模型

前端只訂閱**畫面上看得到的標的**。持倉頁訂閱持倉清單，下單頁訂閱當前標的。

NestJS Gateway 內部維護 `Map<symbol, Set<clientId>>`，收到 Redis 訊息後只推給有訂閱的連線。**不做全域廣播** —— 8 檔持倉的使用者不該收到 500 檔標的的報價。

### 心跳與重連

| 機制 | 設定 | 說明 |
|---|---|---|
| 心跳 | Client 每 **20s** 送 `ping`，Server 回 `pong` | 偵測半開連線（TCP 沒斷但實際不通） |
| 逾時判定 | **45s** 未收到任何訊息即視為斷線 | 容許兩次心跳遺失 |
| 重連 | **指數退避**：1s → 2s → 4s → 8s → 16s → 30s（上限） | 每次加上 0–1000ms 的 **jitter（隨機抖動）** |
| 重連後 | **重新訂閱**當前畫面的標的 | Server 不保存訂閱狀態 |

> **為什麼要 jitter？** 如果後端重啟，所有客戶端會在完全相同的時間點重連，形成尖峰（thundering herd）。加上隨機抖動可以把重連請求打散。

> **重連期間累積的報價要補推還是丟棄？**
>
> **丟棄。** 報價是**即時快照**不是事件流 —— 使用者關心的是「現在多少錢」，不是「剛才漏掉的 30 個 tick」。補推只會讓畫面瘋狂跳動然後停在最新值，體驗更差。
>
> 這個判斷對「訂單成交回報」則完全相反（那是事件，不能漏），但 MVP 不做即時回報。

### 報價新鮮度狀態機

前端維護，不由後端推送：

```
live  ──── 超過 5 秒未收到該標的報價 ────► stale     （數字轉灰、顯示「延遲」）
  ▲                                          │
  │                                     WS 連線中斷
  └──── 收到新報價 ─────────────────► disconnected  （顯示「報價中斷」橫幅、
                                                      數字保留最後值但標示為舊資料）
```

**降級原則：報價斷了，其他功能仍要能用。** 持倉、明細、下單都不依賴 WebSocket。

---

## 統一錯誤碼

### 回應格式

**所有錯誤一律是這個形狀**，由 NestJS 的 Exception Filter 統一包裝：

```jsonc
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",       // 機器判讀，前端用它決定顯示哪個 UI
    "message": "可用餘額不足",            // 人類閱讀的預設訊息
    "details": {                         // 選填，結構依 code 而定
      "requiredCents": 10865400,
      "availableCents": 5000000
    },
    "traceId": "01J8X..."                // 對應後端日誌，除錯用
  }
}
```

> **`code` 是契約，`message` 不是。** 前端絕對不可以用 `message` 的字串內容做判斷 —— 那會在改文案時整個壞掉。`code` 定義在 `shared/errors.ts`，前後端共用同一份列舉。

### 錯誤碼表

| Code | HTTP | 說明 | 前端對應 UI |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | 未登入或 token 過期 | 導向登入頁 |
| `AUTH_INVALID_CREDENTIALS` | 401 | 帳密錯誤 | 表單錯誤訊息 |
| `VALIDATION_FAILED` | 400 | 請求格式錯誤 | 表單 field-level 錯誤 |
| `NOT_FOUND` | 404 | 資源不存在 | 空狀態頁 |
| `DUPLICATE_REQUEST` | 409 | **冪等鍵重複** | 靜默忽略，顯示原本的成功結果 |
| `INSUFFICIENT_FUNDS` | 422 | **餘額不足** | 下單頁紅色提示 ＋ 顯示差額 |
| `INSUFFICIENT_POSITION` | 422 | 持股不足（賣出時） | 同上 |
| `INSTRUMENT_NOT_TRADABLE` | 422 | 標的停止交易 | 下單按鈕停用 ＋ 說明 |
| `ORDER_REJECTED` | 422 | **下單被拒**（模擬撮合失敗） | 結果頁失敗分支 ＋ 樂觀更新回滾 |
| `PRICE_OUT_OF_RANGE` | 422 | 限價超出漲跌停 | 價格欄位錯誤 |
| `SERVICE_UNAVAILABLE` | 503 | 下游服務異常 | 全頁錯誤 ＋ 重試按鈕 |
| `INTERNAL_ERROR` | 500 | 未預期錯誤 | 全頁錯誤 ＋ 回報 traceId |

> **`DUPLICATE_REQUEST` 的處理特別重要。** 使用者連點兩次，第二次收到 409。這時**不該顯示錯誤** —— 從使用者角度看他只是點了兩下，第一次已經成功了。前端應該靜默處理，顯示成功結果。
>
> 「技術上的錯誤」不等於「該讓使用者看到的錯誤」，這個區分值得寫進 README。

### 錯誤分類與前端策略

| 類別 | HTTP | 該重試嗎 | 前端策略 |
|---|---|---|---|
| 使用者輸入錯誤 | 4xx | ❌ | 顯示在對應欄位，不重試 |
| 業務規則拒絕 | 422 | ❌ | 明確說明原因與可行動作 |
| 暫時性故障 | 429 / 503 | ✅ | TanStack Query 自動重試（指數退避，最多 3 次） |
| 未預期錯誤 | 500 | ⚠️ | 重試 1 次，仍失敗則顯示 traceId |

---

## 認證設計

### 決定：JWT 存 httpOnly Cookie

| 方案 | XSS 風險 | CSRF 風險 | 結論 |
|---|---|---|---|
| **httpOnly Cookie + SameSite=Lax** | ✅ JS 讀不到 token | 需防護，但 `SameSite=Lax` 已擋掉大部分 | ✅ **採用** |
| `localStorage` | ❌ **任何 XSS 都能偷走 token** | 無 | ❌ |
| 記憶體變數 | ✅ 安全 | 無 | 重整就登出，體驗差 |

**設定：**

```
Set-Cookie: access_token=<jwt>;
            HttpOnly;              // JS 無法讀取，防 XSS
            SameSite=Lax;          // 跨站請求不帶 cookie，防 CSRF
            Path=/api;
            Max-Age=86400          // 24 小時
```

> **為什麼不用 `localStorage`？** 只要頁面上有任何 XSS 漏洞（例如渲染了未逃逸的使用者輸入），攻擊者一行 `localStorage.getItem('token')` 就把身分偷走了。`httpOnly` cookie 從瀏覽器層級阻止 JS 讀取。
>
> **本機部署為什麼還在乎這個？** 因為認證的設計方式會被整個專案的其他部分模仿。這裡走捷徑，之後每一個需要身分的功能都會跟著走捷徑。

### 不做 Refresh Token

MVP 只有一個 demo 帳號、單一裝置、24 小時有效期。Refresh token 機制（輪替、撤銷清單、竊取偵測）的複雜度遠超過它在本專案帶來的價值。

**README 要寫明這是刻意的取捨**，而不是不知道有這東西。

### Guard 實作

以 NestJS 的 `@UseGuards(JwtAuthGuard)` 套用在需要認證的 Controller。少數公開端點（`/auth/login`、`/health`）用 `@Public()` 自訂裝飾器標記排除。

> **預設全部需要認證，例外才標記公開** —— 這比反過來安全。忘記加 Guard 的後果是 API 裸奔；忘記加 `@Public()` 的後果只是登入頁打不開，立刻會發現。

---

## Rate Limiting — 只做了 WebSocket 訂閱上限

| 保護 | 狀態 | 說明 |
|---|---|---|
| WebSocket 訂閱上限 | ✅ 已實作 | 單一連線最多 100 檔標的。防止有人送一萬檔把 Gateway 的記憶體吃光 |
| `POST /orders` 的頻率限制 | ❌ 沒做 | 見下方 |
| `POST /auth/login` 的頻率限制 | ❌ 沒做 | 見下方 |
| 一般 GET 的頻率限制 | ❌ 沒做 | 見下方 |

**為什麼 HTTP 的頻率限制沒做**：本專案只有一個 demo 帳號、只在本機執行，
沒有可被濫用的對象。加上去之後，唯一會被擋到的是自己在測連點行為的時候。

真的要做的話，用 Redis 的滑動視窗（`INCR` + `EXPIRE`）套在寫入端點上，
超過時回 `429` 並帶 `Retry-After` 標頭。錯誤碼要一併加進 `shared/errors.ts`。

> **Rate limiting 與冪等鍵是不同的東西，容易混淆：**
>
> - **冪等鍵**回答「這是不是同一個請求？」→ 是的話回傳原結果，**不算失敗**
> - **Rate limit** 回答「這個人是不是送太快？」→ 是的話拒絕，**算失敗**
>
> 使用者連點兩次確認鈕，應該被**冪等鍵**擋下（靜默成功），而不是被 rate limit 擋下（顯示錯誤）。
> 這也是為什麼冪等鍵有做、rate limit 沒做 —— 前者解決的是**正確性**問題，後者是**濫用**問題。

---

## 安全性考量（總表）

| 面向 | 做法 |
|---|---|
| 認證 | JWT + httpOnly Cookie + SameSite=Lax |
| 授權 | 所有查詢一律帶 `account_id` 條件，**絕不信任前端傳來的 accountId** |
| 輸入驗證 | zod schema（`shared/`）＋ NestJS `ZodValidationPipe`，在 Controller 前擋下 |
| SQL Injection | 一律使用參數化查詢，禁止字串拼接 SQL |
| 密碼儲存 | bcrypt，cost factor 12 |
| 敏感資料 | 日誌不記錄 password、token、cookie 內容 |
| CORS | 僅允許 `web` 服務的來源，`credentials: true` |
| 錯誤訊息 | 500 錯誤不回傳 stack trace 給前端，只回 `traceId` |
| 金額防線 | 資料庫 `CHECK (cash_balance_cents >= 0)` 作為最後保險 |

> **「絕不信任前端傳來的 accountId」是最容易犯的授權漏洞。**
>
> 如果 API 寫成 `GET /accounts/:id`，攻擊者只要改網址就能看別人的帳戶（這叫 **IDOR，不安全的直接物件參考**）。正確做法是從 JWT 取出使用者身分，在後端查出他的 `account_id`，前端根本不需要傳。
>
> 這也是為什麼端點設計成 `/accounts/me` 而不是 `/accounts/:id`。

---

## 替代方案與不選的理由（Part 2 總表）

| 我們的選擇 | 沒選的方案 | 捨棄理由 |
|---|---|---|
| REST + WebSocket | GraphQL | 本專案查詢形狀固定，GraphQL 的彈性用不到，卻要付 N+1 與快取複雜度的代價 |
| REST + WebSocket | gRPC | 瀏覽器支援需要 grpc-web 代理，徒增一層 |
| WebSocket | SSE | 單向，未來要送下單回報就不夠 |
| httpOnly Cookie | `localStorage` | 任何 XSS 都能偷走 token |
| 不做 Refresh Token | 完整 refresh 機制 | 輪替、撤銷、竊取偵測的複雜度遠超本專案價值 |
| 不透明 cursor（base64） | 直接傳 `occurredAt` + `id` | 前端會依賴內部排序欄位，改排序時前端要跟著改 |
| `/accounts/me` | `/accounts/:id` | 避免 IDOR；帳戶身分只該來自 token |
| 錯誤碼列舉 | 用 HTTP 狀態碼區分 | 422 涵蓋七種業務錯誤，狀態碼不夠用 |
| 前端算未實現損益 | 後端每個 tick 重算推送 | 頻寬與運算成本高，且推送延遲讓數字卡頓 |
| 報價斷線後丟棄 | 補推遺漏的 tick | 報價是快照不是事件流，補推只會讓畫面亂跳 |
