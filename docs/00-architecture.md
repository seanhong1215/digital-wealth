# 00 — 系統架構

> 版本 0.2｜2026-08-27

---

## 系統概觀

| 項目 | 內容 |
|---|---|
| 性質 | 技術示範。虛構金融品牌 **Shawn 財富** 的數位財富管理前台 ＋ 帳務交易核心 |
| 使用者 | 25–45 歲上班族散戶（手機為主）｜55 歲以上（字級與辨識） |
| 裝置 | **Mobile-first**，桌機為放大版 |
| 前端 | React 19 + Vite + TanStack Query + Tailwind v4 |
| 後端 | NestJS + PostgreSQL 16 + Redis 7 + 原生 WebSocket |
| 部署 | 後端本機 Docker Compose；前端另外靜態託管於 GitHub Pages（[ADR 0004](adr/0004-local-only-no-cloud-deploy.md)） |

### 兩種展示的界線

| | 內容 | 演不出來的 |
|---|---|---|
| **本機**（`docker compose up`） | 完整全端 | — |
| **GitHub Pages**（靜態） | 前端 UI，資料由瀏覽器的 MSW 提供 | **並行競態**（`SELECT … FOR UPDATE`）—— 瀏覽器 JS 單執行緒，不可能有兩個請求同時讀到舊餘額 |

靜態版的假資料由 `shared/simulation` 產生，與真實後端 seed 同一份規則、同一顆種子，
所以兩邊的數字完全一致。

---

## 架構建議

### 推薦架構：Monorepo + 多服務 Docker Compose（非微服務）

**四個應用 + 兩個基礎設施，共 5 個容器。**

```
┌─────────────┐   HTTP / WebSocket   ┌──────────────┐
│  web        │◄────────────────────►│  api         │
│  React 19   │                      │  NestJS      │
│  Vite       │                      │              │
└─────────────┘                      └──────┬───────┘
                                            │
                            ┌───────────────┴──────────────┐
                            ▼                              ▼
                     ┌────────────┐                 ┌────────────┐
                     │ postgres   │                 │  redis     │
                     │ 權威資料   │                 │ 快取/訊息  │
                     └────────────┘                 └─────┬──────┘
                                                          │ pub/sub
                                                    ┌─────┴──────┐
                                                    │ market-feed│
                                                    │ 報價產生器 │
                                                    └────────────┘
```

### 為什麼不用另一個方案

| 決策 | 選擇 | 替代方案與捨棄理由 |
|---|---|---|
| 服務切分 | **模組化單體 + 一個獨立 feed 服務** | 真微服務（每模組獨立部署）在單人專案是純負擔 —— 需要服務發現、分散式追蹤、跨服務交易。做了也答不出「為什麼要拆」 |
| `market-feed` 為何獨立 | **報價與業務邏輯的生命週期不同** | 併進 `api` 也能跑，但那樣 Redis pub/sub 就沒有存在理由，Redis 會退化成一個沒有職責的元件。拆開後「行情源 → 訊息匯流排 → 連線扇出」是真實交易系統的標準形狀 |
| 前後端關係 | **前後端分離**，契約放 `shared/` | SSR 整合（Next.js）在此屬過度工程 —— 沒有 SEO 需求，且會模糊「前端架構能力」這個訊號 |
| 儲存庫結構 | **Monorepo** | 多 repo 會讓 `shared/` 契約共用變成 npm 私有套件的維運問題，成本遠大於效益 |

### 這個架構要證明的三件事

1. **契約單一來源** —— zod schema 在 `shared/`，後端做執行期驗證、前端推導型別。改一個欄位，兩邊同時編譯失敗。
2. **寫入路徑的正確性** —— 下單走 DB transaction + 行鎖 + 冪等鍵，這是金融系統的真難點，mock 做不出來。
3. **故障是設計的一部分** —— 錯誤狀態不是補丁，是從第一天就有的分層（統一錯誤碼 → Exception Filter → 前端降級 UI）。

---

## 模組拆解

```
digital-wealth/
│
├── shared/                    ★ 前後端共用契約，唯一的型別來源
│   ├── schemas/               zod schema：auth｜portfolio｜transaction｜order｜quote｜demo
│   ├── money.ts               金額運算的唯一入口（branded type Cents）
│   ├── market-rules.ts        台股規則：跳動單位、手續費、漲跌停
│   ├── errors.ts              錯誤碼列舉，前後端共用
│   └── simulation/            ★ 假資料規則。seed、market-feed、瀏覽器 mock 三邊共用
│       ├── factory.ts         種子資料：先產生明細，再推導持倉與快照
│       ├── walker.ts          價格隨機漫步（對齊跳動點、夾在漲跌停內）
│       ├── rng.ts             決定性亂數
│       └── instruments.ts     20 檔標的的基本資料
│
├── web/                       React 19 + Vite
│   ├── features/              ★ 依功能切，不依技術切
│   │   ├── auth/api/          登入、session
│   │   ├── portfolio/api/     總覽、快照、持倉
│   │   ├── transactions/      明細（api + 虛擬滾動元件）
│   │   ├── trading/api/       下單與試算
│   │   ├── quotes/            即時報價 store（WebSocket）與降級顯示
│   │   └── demo/              Demo 控制台面板
│   ├── routes/                頁面：登入｜總覽｜明細｜下單四步
│   ├── shared/{ui,lib}        無業務邏輯的元件、格式化、API 客戶端
│   └── mocks/                 MSW 假後端（只有測試與靜態版會載入）
│
├── api/                       NestJS
│   ├── modules/               ★ 一個業務領域一個 Module
│   │   ├── auth/              JWT 簽發與驗證
│   │   ├── accounts/          帳戶餘額
│   │   ├── instruments/       標的基本資料與搜尋
│   │   ├── portfolio/         總覽聚合、快照、持倉
│   │   ├── positions/         持倉列表（與 portfolio 共用 Service）
│   │   ├── transactions/      明細查詢、cursor 分頁
│   │   ├── orders/            ★ 下單：transaction + 行鎖 + 冪等
│   │   ├── quotes/            WebSocket Gateway、Redis 訂閱、依訂閱扇出
│   │   ├── demo/              情境切換與故障注入（動態模組，正式環境不註冊）
│   │   └── health/            健康檢查（給 Docker 用）
│   ├── common/                Exception Filter｜JWT Guard｜zod 驗證管道
│   ├── database/              連線池、交易封裝、migration、seed 寫入
│   └── redis/                 連線管理
│
├── market-feed/               報價產生器 → Redis publish（可單獨關掉以演示降級）
│
├── docs/                      本目錄
├── .github/workflows/         GitHub Pages 部署
└── docker-compose.yml         postgres｜redis｜api｜market-feed｜web
```

### 硬性分層規則

**這兩條寫進 README，是分層是否真實存在的證據。**

1. **前端**：`features/*/components` 不得直接呼叫 `fetch`，一律經由同 feature 的 `api/` 層。
2. **後端**：Controller 不得直接碰資料庫，一律經由 Service → Repository。Controller 只負責「解析請求、呼叫 Service、回傳」。

---

## 前後端分工：權威值 vs 衍生值

**這是全端專案最容易做錯的地方 —— 同一個數字在兩邊各算一次，然後兜不攏。**

| 資料 | 誰算 | 為什麼 |
|---|---|---|
| 帳戶餘額 | **後端**（權威） | 涉及金錢，必須有單一真相來源。前端只顯示 |
| 持倉成本、已實現損益 | **後端**（權威） | 由歷史成交計算，前端沒有完整資料 |
| 總市值、**未實現**損益 | **前端**（衍生） | 隨即時報價每秒變動。若由後端算，每個 tick 都要重算整個投組再推送，頻寬與運算都不划算 |
| 漲跌幅、漲跌色 | **前端**（衍生） | 純呈現邏輯 |
| 篩選、排序、分頁 | **後端** | 3,000 筆不可能全撈到前端再篩 |
| 所有格式化（千分位、小數、日期） | **前端** | 後端一律回原始值：金額回整數分、時間回 ISO 8601 |

**判準：涉及金錢正確性的用後端算；隨即時報價變動的用前端算。**

後端回傳的每個金額欄位一律是**整數分（cents）**，前端 `MoneyText` 元件負責轉成 `NT$ 1,234.56`。後端永遠不回傳格式化字串。

---

## 技術棧推薦

| 領域 | 選擇 | 為什麼不用替代方案 |
|---|---|---|
| 前端框架 | React 19 + TypeScript `strict` | 生態成熟，型別能與後端共用 |
| 前端建置 | Vite | 不需 SSR，Next.js 屬過度工程 |
| Server state | TanStack Query | 快取、重試、失效皆內建。自己用 `useEffect` 寫等於重造一個不完整的輪子 |
| 即時報價狀態 | 外部 store + `useSyncExternalStore` | 報價是伺服器主動推送，塞進 Query 只是借用它的儲存空間；放 Context 則每筆報價都會讓整棵樹重繪 |
| 長列表 | TanStack Virtual | 8,000 筆全渲染約 8 萬個 DOM 節點，首次渲染會卡住主執行緒 |
| 圖表 | Recharts | 需求是資產曲線，非專業 K 線。用 D3 是殺雞用牛刀 |
| 樣式 | Tailwind v4 `@theme` | token 的定義與使用在同一個語言裡。CSS-in-JS 有執行期成本 |
| **後端框架** | **NestJS + TypeScript** | 見下方專節 |
| 資料庫 | PostgreSQL | 下單需要 ACID 交易與行鎖。MongoDB 在金額場景的交易保證不足 |
| 資料存取 | 原生 SQL | 行鎖與 cursor 分頁在 ORM 底下都要繞回原生 SQL（[ADR 0010](adr/0010-raw-sql-over-orm.md)） |
| 快取／訊息 | Redis | 兩個真工作，見下方專節 |
| 即時通訊 | 原生 WebSocket（`ws`） | SSE 是單向的，無法讓前端說「我在看哪幾檔」；socket.io 不是標準 WS，瀏覽器連不上，前端得多裝一個 client |
| 契約／驗證 | zod（放 `shared/`） | 型別與執行期驗證單一來源。用 class-validator 就無法與前端共用 |
| 打包 | Docker Compose | 一行啟動全套；無雲端成本、無到期風險 |
| 測試 | Vitest | 覆蓋核心規則的不變式（金額、台股規則、種子資料自洽性、價格漫步） |
| Mock | MSW | 跑前端測試，也驅動 GitHub Pages 的靜態展示版 |

> **沒有採用 Zustand 與 react-hook-form。** 原規劃兩者都要用，實作時發現用不上：
> 全域 UI 狀態只有 Demo 控制台的開合（一個 `useState` 就夠），
> 而下單表單只有兩個欄位，`useState` 加上 `shared/market-rules` 的驗證比引入表單函式庫更短。
> 需求沒出現就不預先引入。

### 為什麼是 NestJS 而不是 Spring Boot / Express

1. **型別共用。** zod schema 在 `shared/`，兩邊都從它推導 —— 改一個欄位，前後端同時編譯失敗。用 Java 做不到這件事，契約會變成兩份。
2. **架構觀念與 Spring Boot 一對一。** DI 容器、Module、Guard（≈ Filter）、Pipe（≈ 參數驗證）、Interceptor、Exception Filter。學 NestJS 等於同時累積 Spring 心智模型。
3. **不用 Express** —— Express 什麼都要自己拼，學不到「框架為什麼這樣分層」。NestJS 的結構夠明確，值得逐層讀懂。

**該改用 Java + Spring Boot 的條件**：團隊既有技術棧是 Java（多數傳統金融機構的 IT 部門）。與既有系統一致的價值，壓過型別共用的優勢。

### Redis 的兩個工作

| 用途 | 做法 | 為什麼是真需求 |
|---|---|---|
| 報價 pub/sub 扇出 | `market-feed` publish → `api` 訂閱 → 廣播給所有 WS 連線 | 真實交易系統的標準做法；讓多分頁看到同一份報價 |
| 下單冪等鍵 | `SET idem:{key} NX EX 300` | 使用者連點兩次「確認下單」必須擋掉。券商系統一定要處理 |

**沒有這兩個理由就該砍掉 Redis。** 引入一個沒有明確職責的元件，換來的只是多一份維運成本。

---

## 實作狀態

| 區塊 | 內容 | 狀態 |
|---|---|---|
| 專案地基 | Docker Compose、schema（7 張表）、migration、seed、金額型別 | ✅ |
| 讀取路徑 | 帳戶／持倉／明細／標的 API、總覽頁、明細頁、虛擬滾動 | ✅ |
| 寫入路徑 | 下單：transaction + 行鎖 + 冪等鍵 | ✅ |
| 即時路徑 | market-feed、Redis pub/sub、WS Gateway、重連與降級 | ✅ |
| 錯誤契約 | 統一錯誤碼、Exception Filter、前端降級 UI | ✅ |
| 最小認證 | 單一 demo 帳號 + JWT + Guard | ✅ |
| Demo 控制台 | 後端故障注入 middleware + 前端浮動面板 | ✅ |
| 交付物 | README、demo 影片、截圖、GitHub Pages 部署 | ✅ |

### 刻意沒做的

| 項目 | 理由 |
|---|---|
| 配置圓餅圖 | 與資產走勢曲線屬重複訊號，兩個圖表講同一件事 |
| 樂觀更新與回滾 | 下單走**悲觀更新** —— 它有一整排合理的失敗理由，而「顯示成交了、兩秒後改口」在金融場景會讓人失去信任。詳見 `web/src/features/trading/api/queries.ts` |
| 前端 code splitting | bundle 約 770KB（gzip 231KB），Recharts 佔大宗。以本機與靜態託管的情境，還沒到需要優化的量級 |

---

## 程式碼註解規範 ★ 硬性規範

**本專案的讀者假設是「新手工程師」。所有程式碼一律遵守。**

| 位置 | 要求 |
|---|---|
| 檔案頂部 | 這個檔案是什麼、為什麼存在、在架構的哪一層 |
| 每個函式／類別 | 做什麼、參數意義、回傳什麼、什麼情況會失敗 |
| 非顯而易見的邏輯 | 逐行說明。判準：三個月後看不懂就要註解 |
| 框架特有寫法 | `@Injectable()`、`@Module()`、Guard、Pipe 等**第一次出現時完整說明** |
| 金融／資料庫概念 | `SELECT ... FOR UPDATE`、`SET NX EX`、branded type、cursor 分頁**必須附原理** |
| 型別定義 | 每個欄位標註單位與範圍 |

**語言：繁體中文。** 技術名詞與識別字保留原文。

**註解寫「為什麼」，不只是「做什麼」：**

```ts
// ❌ 不好：重複了程式碼本身
// 把 amount 乘以 100
const cents = amount * 100;

// ✅ 好：解釋原因
// 前端傳來的是「元」，資料庫一律存「分」的整數。
// 用整數是為了避免浮點誤差 —— 0.1 + 0.2 !== 0.3 在金融系統不能接受。
const cents = toCents(amount);
```

---

## 金額處理原則

**所有金額相關程式碼的最高原則，違反即為 bug。**

1. **一律以最小單位整數儲存**（新台幣以「分」為單位），**絕不使用浮點數**
2. **所有金額運算集中於 `shared/money.ts`**，禁止在元件或 Service 中直接做金額算術
3. **型別以 branded type 標記**，避免與一般 number 混用：

```ts
/** 金額的最小單位（分）。1 元 = 100 分。
 *  用 branded type 讓 TypeScript 阻止「把元當成分」的錯誤。 */
type Cents = number & { readonly __brand: 'Cents' };
```

4. **資料庫欄位型別**：金額用 `BIGINT`（分）；**股數也用 `BIGINT`**

   > **修正（2026-08-15）**：本項原寫「零股數量用 `NUMERIC(18,4)`」，
   > 已被 [`adr/0005`](adr/0005-money-as-bigint-cents.md) 與
   > [`02-backend.md`](02-backend.md) 的 `positions` 表推翻。
   > 理由：**台股零股交易的最小單位是 1 股（整數），不存在 0.5 股。**
   > 需要 `NUMERIC` 的是美股碎股（可買 0.137 股），本專案不做。
   > 實作以 ADR 為準。
5. **顯示層才轉為字串**，由前端 `MoneyText` 元件負責

---

## 替代方案與不選的理由（總表）

| 我們的選擇 | 沒選的方案 | 捨棄理由 |
|---|---|---|
| 模組化單體 | 微服務 | 單人專案沒有拆分的組織理由，只會增加維運複雜度 |
| NestJS | Spring Boot | 失去前後端型別共用 —— 全端定位最重要的訊號 |
| NestJS | Express / Fastify 裸寫 | 學不到框架分層的設計意圖 |
| PostgreSQL | MongoDB | 下單需要 ACID 與行鎖，文件資料庫的交易保證不足 |
| WebSocket | SSE | 單向，未來送下單回報不夠用 |
| WebSocket | HTTP 輪詢 | 報價場景延遲不可接受，且浪費頻寬 |
| 整數分制 | 浮點數 | 浮點誤差在金融系統不可接受 |
| 整數分制 | Decimal 函式庫 | 需要額外依賴，且整數已足夠（不處理利率複利） |
| 本機 Docker Compose | 雲端部署 | 免費方案六個月後會休眠或刪庫；本機部署無到期風險 |
| Zustand | Redux Toolkit | 只用於 UI 狀態，Redux 的樣板碼不划算 |
| Zustand | Context API | 報價高頻更新下，Context 會造成大範圍重繪 |

---

## 相關文件

- [根目錄 README](../README.md) — 專案定位、技術決策、功能範圍
- `docs/01-proposal.md` — 提案與 Sitemap
- `docs/02-backend.md` — 資料庫 schema、API 契約、WebSocket 協定
- `docs/03-presentation.md` — 資料呈現層規範
- `docs/04-design-system.md` — Design Token 與元件庫
- `docs/adr/` — 決策紀錄
