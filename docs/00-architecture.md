# 00 — 系統架構

> 情境 A（內部開發需求分析）產出｜全端作品集總綱
> 版本 0.1｜2026-08-13｜維護者：Shawn Ben

---

## 需求確認

### 已確認

| 項目 | 內容 |
|---|---|
| 專案性質 | **全端作品集**，虛構金融品牌 `<BRAND>` 的數位財富管理前台 |
| 使用者 | 25–45 歲上班族散戶（手機為主）｜55+（字級與辨識）｜**技術主管（真正的評估者）** |
| 裝置 | **Mobile-first**，桌機為放大版 |
| 後端 | **真實後端**（NestJS + PostgreSQL + Redis + WebSocket） |
| 部署 | **僅本機 Docker Compose**，不做雲端部署 |
| 時程 | MVP 為主，保留學習時間；分 31 個單元逐一確認 |
| 學習模式 | 每個單元做完即停、導讀、確認理解才前進 |

### 仍需釐清

| 疑問 | 影響 | 何時要決定 |
|---|---|---|
| 品牌名稱 | 全站文案與 README。`Tidal Wealth` 撞名高知名度音樂串流品牌，建議更換 | 單元 1.3（Design token）前 |
| 下單流程的 URL 策略 | step 走路由 vs 全存記憶體 | 單元 3.4 前 |
| 是否保留配置圓餅圖 | 走勢曲線已展示圖表能力，圓餅屬重複訊號 | 單元 1.7 時 |

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
| `market-feed` 為何獨立 | **報價與業務邏輯的生命週期不同** | 併進 `api` 也能跑，但那樣 Redis pub/sub 就沒有存在理由，Redis 會退化成「為了寫在履歷上」。拆開後「行情源 → 訊息匯流排 → 連線扇出」是真實交易系統的標準形狀 |
| 前後端關係 | **前後端分離**，契約放 `shared/` | SSR 整合（Next.js）在此屬過度工程 —— 沒有 SEO 需求，且會模糊「前端架構能力」這個訊號 |
| 儲存庫結構 | **Monorepo** | 多 repo 會讓 `shared/` 契約共用變成 npm 私有套件的維運問題，成本遠大於效益 |

### 這個架構要證明的三件事

1. **契約單一來源** —— zod schema 在 `shared/`，後端做執行期驗證、前端推導型別。改一個欄位，兩邊同時編譯失敗。
2. **寫入路徑的正確性** —— 下單走 DB transaction + 行鎖 + 冪等鍵，這是金融系統的真難點，mock 做不出來。
3. **故障是設計的一部分** —— 錯誤狀態不是補丁，是從第一天就有的分層（統一錯誤碼 → Exception Filter → 前端降級 UI）。

---

## 模組拆解

```
<BRAND>/
│
├── shared/                    ★ 前後端共用契約，唯一的型別來源
│   ├── schemas/               zod schema（帳戶、持倉、委託、報價⋯）
│   ├── money.ts               金額運算的唯一入口
│   └── errors.ts              錯誤碼列舉，前後端共用
│
├── web/                       React 19 + Vite
│   ├── features/              ★ 依功能切，不依技術切
│   │   ├── auth/              登入、token 保存
│   │   ├── portfolio/         總覽卡片 + 走勢曲線 + 持倉列表
│   │   │   ├── api/           ← 唯一與後端對話的層
│   │   │   ├── components/
│   │   │   └── types.ts
│   │   ├── transactions/      明細、篩選、虛擬滾動
│   │   ├── trading/           多步驟下單、樂觀更新、回滾
│   │   └── demo/              Demo 控制台側邊抽屜
│   └── shared/
│       ├── ui/                無業務邏輯的元件
│       ├── lib/               格式化、hooks
│       └── tokens/            Design token
│
├── api/                       NestJS
│   ├── modules/               ★ 一個業務領域一個 Module
│   │   ├── auth/              JWT 簽發與驗證
│   │   ├── accounts/          帳戶、餘額
│   │   ├── instruments/       標的基本資料
│   │   ├── positions/         持倉、成本、未實現損益
│   │   ├── transactions/      明細查詢、cursor 分頁
│   │   ├── orders/            ★ 下單：transaction + 行鎖 + 冪等
│   │   ├── quotes/            WebSocket Gateway、Redis 訂閱、扇出
│   │   └── demo/              故障注入端點與 middleware
│   └── common/
│       ├── filters/           Exception Filter（統一錯誤格式）
│       ├── guards/            JWT Guard
│       ├── interceptors/      日誌、回應包裝
│       └── database/          連線、migration、seed
│
├── market-feed/               報價產生器 → Redis publish
│
├── docs/                      本目錄
└── docker-compose.yml
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
| 前端框架 | React 19 + TypeScript `strict` | 求職主力技術 |
| 前端建置 | Vite | 不需 SSR，Next.js 屬過度工程 |
| Server state | TanStack Query | 快取、重試、樂觀更新皆內建。自己用 `useEffect` 寫等於重造一個不完整的輪子 |
| Client state | Zustand | 僅用於 UI 與 Demo 控制台。**不與 server state 混用** —— 混用是 Redux 時代最大的痛 |
| 長列表 | TanStack Virtual | 3,000 筆全渲染會讓手機卡死 |
| 圖表 | Recharts | 需求是資產曲線，非專業 K 線。用 D3 是殺雞用牛刀 |
| 樣式 | Tailwind + CVA | Token 驅動、變體集中管理。CSS-in-JS 有執行期成本 |
| **後端框架** | **NestJS + TypeScript** | 見下方專節 |
| 資料庫 | PostgreSQL | 下單需要 ACID 交易與行鎖。MongoDB 在金額場景的交易保證不足 |
| 快取／訊息 | Redis | 兩個真工作，見下方專節 |
| 即時通訊 | WebSocket | SSE 是單向的，未來要送下單回報就不夠；輪詢在報價場景延遲不可接受 |
| 契約／驗證 | zod（放 `shared/`） | 型別與執行期驗證單一來源。用 class-validator 就無法與前端共用 |
| 表單 | react-hook-form + zodResolver | 多步驟下單需要 field-level 控制 |
| 打包 | Docker Compose | 一行啟動全套；無雲端成本、無到期風險 |
| 測試 | Vitest + Testing Library；MSW 供前端測試 | 「MSW 跑測試、真後端跑運行」證明前端未與後端耦合死 |

### 為什麼是 NestJS 而不是 Spring Boot / Express

1. **型別共用是全端定位的核心訊號。** zod schema 在 `shared/`，兩邊都從它推導。用 Java 做不到這件事，作品集會退化成「兩個獨立專案放同一個 repo」。
2. **架構觀念與 Spring Boot 一對一。** DI 容器、Module、Guard（≈ Filter）、Pipe（≈ 參數驗證）、Interceptor、Exception Filter。學 NestJS 等於同時累積 Spring 心智模型。
3. **不用 Express** —— Express 什麼都要自己拼，學不到「框架為什麼這樣分層」。NestJS 的結構夠明確，值得逐層讀懂。

**唯一該改用 Java + Spring Boot 的條件**：求職目標明確為傳統金融機構本體（銀行／券商 IT 部門）。

### Redis 的兩個工作

| 用途 | 做法 | 為什麼是真需求 |
|---|---|---|
| 報價 pub/sub 扇出 | `market-feed` publish → `api` 訂閱 → 廣播給所有 WS 連線 | 真實交易系統的標準做法；讓多分頁看到同一份報價 |
| 下單冪等鍵 | `SET idem:{key} NX EX 300` | 使用者連點兩次「確認下單」必須擋掉。券商系統一定要處理 |

**沒有這兩個理由就該砍掉 Redis。** 面試官問「為什麼需要 Redis」時答不出來，比不用還扣分。

---

## 開發優先順序

對應 31 個實作單元（詳見計畫檔的單元清單）。

| 優先級 | 功能 | 說明 | 複雜度 | 單元 |
|---|---|---|---|---|
| **P0** | 專案地基 | Docker Compose、schema、migration、seed、金額型別 | 中 | 0.1–0.6 |
| **P0** | 讀取路徑 | 帳戶／持倉／明細 API + 總覽頁 + 虛擬滾動 | 中 | 1.1–1.10 |
| **P0** | 寫入路徑 | 下單：transaction + 行鎖 + 冪等 + 樂觀更新回滾 | **高** | 3.1–3.6 |
| **P0** | 錯誤契約 | 統一錯誤碼、Exception Filter、前端降級 UI | 中 | 4.1–4.2 |
| **P1** | 即時路徑 | market-feed、Redis pub/sub、WS Gateway、重連降級 | **高** | 2.1–2.5 |
| **P1** | 最小認證 | 單一 demo 帳號 + JWT + Guard | 低 | 併入 1.1 |
| **P1** | Demo 控制台 | 後端故障注入 middleware + 前端抽屜 | 中 | 4.3 |
| **P2** | 交付物 | README、demo 影片、截圖、docs 落檔 | 低 | 4.4 |
| **P2** | 資產走勢曲線 | Recharts + 快照表 | 低 | 1.7 |
| **P2** | 配置圓餅圖 | **可砍** —— 與走勢曲線屬重複訊號 | 低 | — |

**砍功能時由 P2 往上砍，且每砍一項都要在 README 寫明理由。** 砍掉的東西也是作品的一部分。

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

   > **修正（2026-08-15，單元 0.3）**：本項原寫「零股數量用 `NUMERIC(18,4)`」，
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

- `PROJECT.md` — 專案定位與目標排序（總綱）
- `docs/01-proposal.md` — 提案與 Sitemap
- `docs/02-backend.md` — 資料庫 schema、API 契約、WebSocket 協定
- `docs/03-presentation.md` — 資料呈現層規範
- `docs/04-design-system.md` — Design Token 與元件庫
- `docs/adr/` — 決策紀錄
