-- ============================================================================
-- 001_initial_schema.sql — 初始資料庫結構
--
-- 這個檔案是什麼：
--   建立本專案全部七張資料表。對應 docs/02-backend.md 的「Schema 定義」一節。
--
-- 為什麼是純 SQL 而不是 ORM 的 migration DSL：
--   見 docs/adr/0010-raw-sql-over-orm.md。簡短版：本專案最核心的
--   技術訊號是 SELECT ... FOR UPDATE 與 cursor 分頁，那些在 ORM 底下
--   都要繞回原生 SQL；既然如此，不如從一開始就直接寫 SQL。
--
-- 執行方式：
--   npm run migrate -w @fintech/api
--
-- ⚠️ **migration 一旦執行過就不要再改內容。**
--    需要調整結構時，新增 002_xxx.sql。改已執行過的檔案，
--    只會讓你的資料庫和別人的（以及未來的你）不一致。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 前置：UUID 產生函式
--
-- gen_random_uuid() 從 PostgreSQL 13 起是內建的，不需要額外的 extension。
-- 這裡明確寫出來是為了記錄「我們用的是哪一種 UUID」——
-- gen_random_uuid() 產生的是 UUID v4（純隨機）。
--
-- ⚠️ 隨機 UUID 當主鍵有個代價：新資料的索引位置是隨機的，
--    大量寫入時會造成 B-tree 頁面分裂（index fragmentation）。
--    真正高寫入量的系統會改用 UUID v7（時間有序）或 bigserial。
--    本專案資料量小（萬筆級），不值得為此增加複雜度。
-- ----------------------------------------------------------------------------


-- ============================================================================
-- users — 使用者
--
-- MVP 只有一個 demo 帳號，但表結構保留多使用者的形狀。
-- 理由：改結構的成本遠高於一開始就做對，而這裡「做對」幾乎沒有額外成本。
-- ============================================================================
CREATE TABLE users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 登入帳號。UNIQUE 讓資料庫層保證不會有兩個相同 email 的使用者，
  -- 不必依賴應用層的「先查再寫」（那在併發下會失效）。
  email         VARCHAR(255) NOT NULL UNIQUE,

  -- bcrypt 雜湊值。**絕不儲存明文密碼。**
  -- bcrypt 的輸出固定 60 字元，這裡開 255 是留給未來換演算法
  -- （例如 argon2 的輸出更長）的空間。
  password_hash VARCHAR(255) NOT NULL,

  display_name  VARCHAR(50)  NOT NULL,

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 為什麼所有時間欄位都用 TIMESTAMPTZ 而不是 TIMESTAMP：
--   TIMESTAMP 不帶時區，存進去是什麼就是什麼，跨時區時完全無法解讀。
--   TIMESTAMPTZ 內部一律以 UTC 儲存，讀出時依連線的時區設定轉換。
--   金融系統的「成交時間」如果時區搞錯，整份對帳單都是錯的。
COMMENT ON TABLE users IS '使用者。MVP 只有一個 demo 帳號';


-- ============================================================================
-- accounts — 帳戶
-- ============================================================================
CREATE TABLE accounts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE：刪除使用者時，其帳戶一併刪除。
  -- 對 demo 資料重建很方便（刪 user 就全清了），
  -- 真實系統的金融帳戶通常反而要禁止刪除（改用 is_closed 標記）。
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- 顯示用帳號，格式 1234-5678。與主鍵分開的理由：
  -- 主鍵是系統內部識別碼，帳號是給人看的，兩者的生命週期與格式需求不同。
  account_no         VARCHAR(20) NOT NULL UNIQUE,

  -- ★ 可用現金，單位為「分」。
  --
  -- BIGINT 而非 NUMERIC：見 docs/adr/0005。
  -- 簡短版：JS 沒有 NUMERIC 的原生對應型別，取出來是字串，每次都要轉；
  -- 而整數分已足夠精確（台股不處理利率複利）。
  cash_balance_cents BIGINT      NOT NULL CHECK (cash_balance_cents >= 0),

  currency           CHAR(3)     NOT NULL DEFAULT 'TWD',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ★ 這個約束是餘額的最後一道防線。
--
-- 應用層應該先擋下餘額不足（在 SELECT ... FOR UPDATE 之後檢查），
-- 但如果程式有 bug，資料庫會直接拒絕寫入而不是讓餘額變成負數。
--
-- 為什麼一定要有這層：應用層的檢查可能因為併發、重構、或單純的
-- 邏輯錯誤而失效，而且失效時是**靜默**的 —— 餘額變成 -50000 元，
-- 沒有任何錯誤訊息。資料庫層的約束會讓這種 bug 在第一次發生時就爆炸。
COMMENT ON COLUMN accounts.cash_balance_cents IS '可用現金（分）。CHECK >= 0 是餘額的最後防線';

CREATE INDEX idx_accounts_user_id ON accounts(user_id);


-- ============================================================================
-- instruments — 交易標的
-- ============================================================================
CREATE TABLE instruments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 股票代號，例如 2330。
  symbol            VARCHAR(10) NOT NULL UNIQUE,

  name              VARCHAR(50) NOT NULL,

  -- TWSE（上市）/ TPEX（上櫃）。
  market            VARCHAR(10) NOT NULL CHECK (market IN ('TWSE', 'TPEX')),

  -- 一張的股數。台股整股交易一張 = 1000 股，零股則以 1 股為單位。
  lot_size          INT         NOT NULL DEFAULT 1000 CHECK (lot_size > 0),

  -- ★ 昨日收盤價（分／股）。
  --
  -- 漲跌幅 =（現價 − 昨收）/ 昨收，漲跌停也由它推算。
  -- 放在標的表而不是每次查詢時計算，是因為它**一天只變一次**——
  -- 這是典型的「低頻變動資料適合預先存好」。
  prev_close_cents  BIGINT      NOT NULL CHECK (prev_close_cents > 0),

  is_active         BOOLEAN     NOT NULL DEFAULT true,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ⚠️ 這裡**沒有** tick_size 欄位，是刻意的。
--
-- 台股的最小跳動單位隨股價分級（未滿 10 元跳 0.01、1000 元以上跳 5）。
-- 它是**規則**不是**資料** —— 同一檔股票漲過 100 元之後級距就變了，
-- 存成欄位反而要處理同步問題。
--
-- 所以實作成函式，放在 shared/market-rules.ts，前後端共用同一份。
COMMENT ON TABLE instruments IS '交易標的。tick size 是規則不是資料，實作於 shared/market-rules.ts';


-- ============================================================================
-- positions — 持倉（當前狀態）
--
-- ⚠️ 這張表是**衍生資料** —— 理論上可以由 transactions 完整重算出來。
--    存下來是為了查詢效率（總覽頁不該每次都重播三千筆交易）。
--
--    代價是「兩份真相」的風險：如果下單時只更新 transactions 而漏了
--    positions，兩者就對不上了。這正是為什麼下單流程**必須**把
--    兩者的更新放在同一個資料庫交易內。
-- ============================================================================
CREATE TABLE positions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument_id  UUID        NOT NULL REFERENCES instruments(id),

  -- ★ 持有股數，用 BIGINT 而非 NUMERIC。
  --
  -- 台股零股交易的最小單位是 1 股（整數），不存在 0.5 股。
  -- 需要小數的是美股碎股（可以買 0.137 股 AAPL），本專案不做。
  --
  -- 注意 docs/00-architecture.md 舊版寫「零股用 NUMERIC(18,4)」，
  -- 那份說法已被 docs/adr/0005 推翻，以 ADR 為準。
  quantity       BIGINT      NOT NULL CHECK (quantity >= 0),

  -- ★ 平均成本（分／股）。由歷史買入加權平均而來。
  --
  -- 賣出**不改變**這個值 —— 賣掉的部分變成已實現損益，
  -- 留下的部分取得成本不變。這是會計上的標準處理。
  avg_cost_cents BIGINT      NOT NULL CHECK (avg_cost_cents >= 0),

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 一個帳戶對一檔標的只能有一列。
  -- 沒有這個約束的話，併發下單可能插出兩列同標的的持倉，
  -- 之後每次查詢都要 GROUP BY 才對 —— 而且舊資料已經錯了無法補救。
  UNIQUE (account_id, instrument_id)
);


-- ============================================================================
-- orders — 委託（意圖）
--
-- 為什麼 orders 和 executions 要分兩張表：
--   新手常見做法是只用一張 orders 表、把成交價塞進去。這在兩種情況會壞：
--     1. 委託被拒絕 —— 這筆委託存在（要顯示在明細裡），但沒有成交價
--     2. 部分成交   —— 一筆 1000 股的委託分三次成交，成交價各不同
--   真實券商一定是分開的。MVP 雖然只做「全成或全拒」，
--   但表結構先做對，之後不用改 schema。
-- ============================================================================
CREATE TABLE orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  account_id        UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  instrument_id     UUID        NOT NULL REFERENCES instruments(id),

  side              VARCHAR(4)  NOT NULL CHECK (side IN ('BUY', 'SELL')),

  -- MVP 只做限價單。市價單需要模擬撮合深度，複雜度高但技術訊號不多。
  order_type        VARCHAR(10) NOT NULL DEFAULT 'LIMIT' CHECK (order_type IN ('LIMIT')),

  quantity          BIGINT      NOT NULL CHECK (quantity > 0),
  limit_price_cents BIGINT      NOT NULL CHECK (limit_price_cents > 0),

  status            VARCHAR(12) NOT NULL CHECK (status IN ('PENDING', 'FILLED', 'REJECTED')),

  -- 拒絕原因，對應 shared/errors.ts 的錯誤碼（單元 4.1 建立）。
  -- 存代碼而不是訊息文字：文字會改，代碼是契約。
  reject_reason     VARCHAR(50),

  -- ★ 冪等鍵。UNIQUE 約束是防重複下單的**第二道防線**。
  --
  -- 第一道是 Redis（SET idem:{key} NX EX 300）—— 快，但不持久，
  --   Redis 重啟就沒了。
  -- 第二道是這個 UNIQUE  —— 慢，但絕對可靠，重複插入直接報錯。
  --
  -- 兩道都要：Redis 擋掉 99% 的重複請求（毫秒級、不碰資料庫），
  -- UNIQUE 擋掉剩下的邊緣情況（Redis 剛好重啟、TTL 剛好過期）。
  idempotency_key   VARCHAR(64) NOT NULL UNIQUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 業務規則：被拒絕的委託必須有原因，其他狀態不該有。
  -- 寫成 CHECK 而不是靠應用層自律，是因為「狀態與原因不一致」的資料
  -- 一旦寫進去，後面每個讀取的地方都要處理這個不可能的情況。
  CONSTRAINT orders_reject_reason_consistency CHECK (
    (status = 'REJECTED' AND reject_reason IS NOT NULL) OR
    (status <> 'REJECTED' AND reject_reason IS NULL)
  )
);

CREATE INDEX idx_orders_account_created ON orders(account_id, created_at DESC);


-- ============================================================================
-- executions — 成交（結果）
-- ============================================================================
CREATE TABLE executions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  order_id           UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  filled_quantity    BIGINT      NOT NULL CHECK (filled_quantity > 0),
  filled_price_cents BIGINT      NOT NULL CHECK (filled_price_cents > 0),

  -- ★ 台股費用規則（如實實作，細節讓 demo 可信度大幅提升）：
  --
  --   手續費 = 成交金額 × 0.1425%，**最低 20 元**。買賣都收
  --   證交稅 = 成交金額 × 0.3%，**只有賣出時收**
  --
  -- 「最低 20 元」特別值得做 —— 買 1 股 20 元的股票，手續費也是 20 元
  -- （本金的 100%）。新手很容易漏掉這個下限。
  --
  -- 計算邏輯在 shared/market-rules.ts 的 calculateTradeCost()，前後端共用。
  fee_cents          BIGINT      NOT NULL CHECK (fee_cents >= 0),
  tax_cents          BIGINT      NOT NULL CHECK (tax_cents >= 0),

  executed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_executions_order_id ON executions(order_id);


-- ============================================================================
-- transactions — 帳務流水帳 ★ 明細頁的資料來源
-- ============================================================================
CREATE TABLE transactions (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  account_id           UUID         NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- 異動類型。買賣、費用、稅、股利、入出金都在這張表。
  type                 VARCHAR(12)  NOT NULL CHECK (
                         type IN ('BUY', 'SELL', 'FEE', 'TAX', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL')
                       ),

  -- 標的。入出金類異動沒有標的，所以允許 NULL。
  instrument_id        UUID         REFERENCES instruments(id),

  -- 股數與單價。非交易類（費用、入出金）為 NULL。
  -- 用 NULL 而不是 0 是有意義的：0 代表「數量是零」，
  -- NULL 代表「這個概念不適用」。前端顯示時兩者的處理方式不同
  -- （見 docs/03-presentation.md 的邊界條件）。
  quantity             BIGINT,
  price_cents          BIGINT,

  -- ★ 對餘額的影響：正為入帳，負為出帳。
  --
  -- 用單一帶號欄位而不是「借方／貸方」兩欄，是因為本專案只有一個
  -- 現金帳戶，不需要複式簿記。加總這個欄位就是餘額變化總和。
  amount_cents         BIGINT       NOT NULL,

  -- ★ 異動後餘額（結餘）。真實帳務系統的標準欄位。
  --
  -- 它讓每一筆異動都能**獨立驗證**：
  --   前一筆的 balance_after + 這筆的 amount == 這筆的 balance_after
  -- 對帳時不用把整個歷史重算一遍。
  --
  -- ⚠️ **代價**：它必須在同一個資料庫交易內計算並寫入，
  --    否則併發下單會產生錯誤的結餘 —— 兩筆同時讀到相同的舊餘額，
  --    各自加上自己的異動，寫出兩個都是錯的結餘。
  --    這正是下單流程必須用 SELECT ... FOR UPDATE 行鎖的原因之一。
  balance_after_cents  BIGINT       NOT NULL CHECK (balance_after_cents >= 0),

  -- 關聯的委託。只有買賣與其衍生的費用／稅才有。
  order_id             UUID         REFERENCES orders(id) ON DELETE SET NULL,

  description          VARCHAR(100) NOT NULL,

  -- 發生時間。**不是** created_at —— seed 產生的歷史資料，
  -- 發生時間是過去，建立時間是現在，兩者必須分開。
  occurred_at          TIMESTAMPTZ  NOT NULL,

  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ★ 明細頁 cursor 分頁的索引。欄位順序必須與 ORDER BY 完全一致。
--
-- ── 為什麼不用 OFFSET 分頁 ─────────────────────────────────────────
--
--   SELECT * FROM transactions WHERE account_id = $1
--   ORDER BY occurred_at DESC LIMIT 30 OFFSET 2970;
--
--   翻到第 100 頁時，資料庫要先掃描並「丟棄」前 2970 筆才開始取資料 ——
--   越翻越慢。更糟的是，翻頁期間若有新資料插入，
--   整個結果會往後位移，使用者會看到重複或遺漏的項目。
--   無限捲動的場景這問題特別明顯。
--
-- ── cursor 分頁 ────────────────────────────────────────────────────
--
--   SELECT * FROM transactions
--   WHERE account_id = $1 AND (occurred_at, id) < ($2, $3)
--   ORDER BY occurred_at DESC, id DESC LIMIT 30;
--
--   直接從上次的位置往下取，成本恆定，且不受插入影響。
--
-- ── 為什麼 cursor 要包含 id ────────────────────────────────────────
--
--   因為 occurred_at **可能重複**（同一秒可能有多筆交易，
--   seed 產生的資料尤其如此）。只用 occurred_at 當游標的話，
--   時間相同的那幾筆排序不穩定，翻頁時會跳過或重複。
--   id 在這裡是 tie-breaker（決勝欄位），保證排序絕對唯一。
CREATE INDEX idx_transactions_cursor
  ON transactions(account_id, occurred_at DESC, id DESC);

-- 類型篩選用。使用者勾選「只看買進」時避免全表掃描。
CREATE INDEX idx_transactions_account_type ON transactions(account_id, type);


-- ============================================================================
-- portfolio_snapshots — 每日資產快照
--
-- 為什麼走勢曲線不即時計算：
--   要畫近 30 天的資產曲線，即時算的話得對每一天重建
--   「當天持倉 × 當天收盤價」，等於把整個交易歷史重播 30 次。
--   快照表用空間換時間，一天一列，30 天就是 30 列。
--
--   這是「預先計算（pre-aggregation）」的典型應用。
--   真實系統會用排程每日收盤後寫入；MVP 由 seed 直接產生。
-- ============================================================================
CREATE TABLE portfolio_snapshots (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  account_id         UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- 用 DATE 而不是 TIMESTAMPTZ：快照的粒度就是「一天」，
  -- 存時間點會讓「同一天是否已有快照」的判斷變得模糊。
  snapshot_date      DATE        NOT NULL,

  cash_cents         BIGINT      NOT NULL,
  market_value_cents BIGINT      NOT NULL,
  total_value_cents  BIGINT      NOT NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 一個帳戶一天只能有一列。兼具兩個作用：
  --   1. 走勢查詢的索引
  --   2. 防止重複寫入（排程重跑時 ON CONFLICT 就有依據）
  UNIQUE (account_id, snapshot_date)
);
