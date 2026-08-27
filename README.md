# Shawn 財富 — 數位財富管理

> 台股情境的全端交易系統示範。**虛構品牌，與任何真實金融機構無關；所有資料由程式產生，不構成任何投資建議。**
>
> React 19 · NestJS 11 · PostgreSQL 16 · Redis 7 · TypeScript strict · Docker Compose
>
> `Last verified: 2026-08`

---

## 這個專案要展示什麼

不是 CRUD。是金融場域裡三個**真的會讓錢出錯**的問題，以及各自的解法。

| 問題 | 會發生什麼 | 解法 | 程式碼 |
|---|---|---|---|
| **並行競態**<br>（lost update） | 兩個請求同時讀到舊餘額，扣款互相覆蓋 —— 花了 16,000 元，餘額只少 8,000 | `SELECT … FOR UPDATE` 行鎖，`READ COMMITTED` 隔離等級 | [`orders.repository.ts`](api/src/modules/orders/orders.repository.ts) |
| **部分失敗** | 扣了款但沒寫持倉，錢憑空蒸發 | 11 個步驟包在同一個 `BEGIN/COMMIT` | [`orders.service.ts`](api/src/modules/orders/orders.service.ts) |
| **重複請求** | 使用者連點兩次，成立兩筆委託 | 冪等鍵雙層防護：Redis `SET NX EX`（快速路徑）＋ DB `UNIQUE`（永久防線） | [`orders.service.ts`](api/src/modules/orders/orders.service.ts) |

**實測**：5 筆並行下單只成立 1 筆，餘額精確為 `126,103,517 − 88,926,500 = 37,177,017`。

其餘三個支撐性的決策：

- **金額一律用整數「分」＋ branded type** —— `type Cents = number & { __brand: 'Cents' }`。浮點誤差在金融系統不可接受，而 branded type 讓「元」和「分」混用在編譯期就爆掉。見 [`adr/0005`](docs/adr/0005-money-as-bigint-cents.md)
- **前後端契約只有一份** —— zod schema、金額運算、台股規則、錯誤碼全住在 `shared/`，被 web / api / market-feed 三個程序共用。改一個欄位，三邊同時編譯失敗。這是選 NestJS 而不是 Spring Boot 的實際理由，見 [`adr/0002`](docs/adr/0002-nestjs-over-spring-boot.md)
- **降級是設計的一部分** —— 報價斷了，持倉、明細、下單全都還能用。可以當場演示（見下方）

---

## 兩種展示，界線很清楚

| | 看什麼 | 怎麼跑 |
|---|---|---|
| **線上版**（GitHub Pages） | **前端 UI** —— 版面、互動、狀態處理、設計系統 | 點連結就好 |
| **本機版**（Docker Compose） | **全端架構** —— DB 行鎖、Redis pub/sub、真實 WebSocket | `docker compose up -d` |

線上版沒有後端。資料由瀏覽器裡的 [MSW](https://mswjs.io/) 提供，
而那份假資料是用 `shared/simulation` 產生的 —— 跟真實後端 seed **同一份規則、同一顆種子**，
所以兩邊的數字完全一致，不是另外編的一套。

**線上版演不出來的**：並行競態（`SELECT … FOR UPDATE`）。瀏覽器的 JavaScript 是單執行緒，
不可能有兩個請求同時讀到舊餘額 —— 而那正是這個專案技術密度最高的地方。
要看那個，得跑本機版。

> **為什麼不把後端也部署上去**：免費方案撐不住。Render 的免費 PostgreSQL
> [30 天就過期](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90)、
> 再 14 天寬限後刪庫；免費 Web Service 閒置 15 分鐘休眠；
> market-feed 是背景常駐程序，免費方案根本不提供 Background Worker。
>
> 而作品集最常見的死法就是「六個月後點進去畫面全白」—— 30 天比六個月還糟。
> 靜態託管沒有伺服器，也就沒有到期問題。決策紀錄見 [`adr/0004`](docs/adr/0004-local-only-no-cloud-deploy.md)。

### 前端能跑在假後端上，本身就是一個架構證明

元件不直接呼叫 `fetch`（一律經由 feature 的 `api` 層），而 `api` 層只認得 HTTP 契約。
抽掉後端、換一個講同樣契約的東西，整個前端**一行都不用改** —— 這是分層有沒有真的存在的檢驗。

---

## 一行啟動（本機全端版）

```bash
cp .env.example .env          # 填入 JWT_SECRET：openssl rand -base64 32
docker compose up -d
```

開 **http://localhost:8090** — demo 帳號 `demo@digital-wealth.local` / `demo1234`（登入頁有「一鍵填入」）。

Migration 與 seed 全自動，無任何手動步驟。實測從 `docker compose down -v` 的全空狀態起算：

```
17 秒  postgres / redis / api / market-feed / web 五個服務就緒
       └ 自動建 7 張表、寫入 3,001 筆明細、11 檔持倉、262 天快照
```

需要 Docker Desktop 或 Docker Engine，約 1.5GB 磁碟空間。

---

## 60 秒 demo

![完整流程](docs/media/demo.gif)

登入 → 投資總覽（報價即時跳動）→ 交易明細（虛擬滾動 3,001 筆）→ 下單被拒（餘額不足）
→ 下單成交 → 關掉 market-feed 觀察降級。

> 原始畫質版本：[`docs/media/demo.mp4`](docs/media/demo.mp4)（74 秒，未加速）。
> GIF 為 2.6 倍速，方便在 README 裡直接看完。

---

## 畫面

| 投資總覽（即時報價） | 下單確認 |
|---|---|
| ![投資總覽](docs/screenshots/01-portfolio.png) | ![下單確認](docs/screenshots/02-order-confirm.png) |
| 市值、未實現損益由前端用 WebSocket 推來的價格即時計算 | 費用由**後端**試算 —— 權威來源只有一個 |

| 下單被拒 | 報價中斷（降級） |
|---|---|
| ![下單被拒](docs/screenshots/03-order-rejected.png) | ![報價中斷](docs/screenshots/04-quote-degraded.png) |
| 玫瑰紅（非漲色紅）＋ 後端算好的差額 ＋ 可追蹤的 traceId | 橫幅說明、價格保留最後值，其他功能不受影響 |

---

## 三十秒演示：降級

```bash
docker compose stop market-feed
```

0.3 秒內橫幅出現、「持股市值」的來源標示從「即時報價」變成「最後收到的報價」，
而**持倉、明細、下單完全照常**。`docker compose start market-feed` 即可恢復。

這是 market-feed 被拆成獨立服務的唯一理由 —— 報價邏輯如果住在 api 裡，
要演這一段就得把整個後端關掉，那什麼都不能用了，證明不了任何事。

---

## 目前完成度

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 | Docker Compose、schema、migration、seed、金額型別 | ✅ |
| P1 | 查詢 API、總覽頁、交易明細、虛擬滾動 | ✅ |
| P2 | market-feed、Redis pub/sub、WebSocket、重連與降級 | ✅ |
| P3 | 下單：DB transaction、行鎖、冪等鍵 | ✅ |
| P4 | Demo 控制台（後端故障注入）、60 秒 demo 影片 | ✅ |
| 交付 | GitHub Pages 前端展示版（MSW 假後端） | ✅ |

**明確不做**（理由見 [`README` 第 7 節](#7-功能範圍)）：註冊與 OAuth、多使用者、線上部署、i18n、深色模式（token 已預留）、微服務、K 線圖、PWA。

### 已知限制

- **模擬撮合是同步的、限價全額成交** —— 不模擬部分成交或排隊。憑空捏造的撮合邏輯會降低可信度，而 `orders` / `executions` 分表已為真實撮合預留空間
- **只有一個 demo 帳號** —— 認證做到最小可用的 JWT ＋ httpOnly cookie，不做註冊流程
- **`ORDER_REJECTED` 錯誤碼已定義但尚無觸發路徑** —— 它屬於 P4 的故障注入
- **前端 bundle 約 770KB（gzip 231KB）** —— Recharts 佔大宗，尚未做 code splitting
- **線上版無法演示並行競態** —— 瀏覽器單執行緒，`FOR UPDATE` 要看本機版
- **線上版的資料只存在記憶體** —— 重新整理就回到初始情境（這是刻意的：每個訪客都從乾淨狀態開始）

---

## 專案結構

```
shared/          ★ 前後端共用契約 —— zod schema、money.ts、market-rules.ts、errors.ts
  └ 被 web / api / market-feed 三個程序 import 同一份原始碼

api/             NestJS。Controller → Service → Repository 三層
  modules/
    orders/      ★ 下單：transaction + 行鎖 + 冪等（本專案技術密度最高處）
    quotes/      WebSocket Gateway，Redis 訂閱 → 依訂閱扇出
  database/      連線池、交易封裝、migration、seed factory

web/             React 19 + Vite。依「功能」切，不依「技術」切
  features/*/api/          ★ 唯一與後端對話的層
  features/*/components/
  shared/{ui,lib}

market-feed/     報價產生器 → Redis publish。可單獨關掉以演示降級
```

**兩條硬性規則**（分層是否真實存在的證據）：

1. 前端：`features` 底下的 `components` 不得直接呼叫 `fetch`，一律經由同 feature 的 `api` 層
2. 後端：Controller 不得直接碰資料庫，一律經由 Service → Repository

---

## 從哪裡開始讀

想在十分鐘內看懂這個專案，照這個順序：

1. [`shared/src/money.ts`](shared/src/money.ts) — 為什麼金額不能用 float，branded type 怎麼防呆
2. [`api/src/modules/orders/orders.service.ts`](api/src/modules/orders/orders.service.ts) — **★ 整個專案最值得讀的檔案**。下單的 11 個步驟，以及每一步為什麼在交易內／外
3. [`web/src/features/quotes/api/quote-store.ts`](web/src/features/quotes/api/quote-store.ts) — 為什麼報價不放 TanStack Query，`useSyncExternalStore` 解決了什麼
4. [`docs/07-reading-guide.md`](docs/07-reading-guide.md) — 完整的程式碼閱讀路線圖

決策紀錄在 [`docs/adr/`](docs/adr/)，每則一頁，格式是「背景 → 決策 → 替代方案 → 後果」。

---

## 開發指令

```bash
npm run dev:api      # 後端（:3000，watch 模式）
npm run dev:web      # 前端（:5173，5173 被佔用時自動退到 5174）
npm run dev:feed     # 報價產生器
npm run dev:mock     # 前端 + 瀏覽器假後端（不需要 api / DB / Redis）
npm test             # 108 個測試
npm run typecheck    # 全 workspace 型別檢查
npm run db           # psql 進資料庫
npm run build:pages  # 建置 GitHub Pages 版本到 web/dist
```

容器版與本機開發版**不能同時跑** —— 兩者都要綁 :3000。

`dev:mock` 是線上展示版的本機預覽：不用起任何後端服務，
`web/src/mocks` 底下的 MSW 會攔截所有請求。適合只改 UI 的時候。

---
---

<!--
  以下為專案規劃文件（原 PROJECT.md）。
  上方是給第一次看到這個 repo 的人；下方是完整的範圍決策與理由。
-->

# 專案規劃


> 全端作品集專案｜React 19 + NestJS + PostgreSQL + Redis
> 版本 0.2｜2026-08-13｜維護者：Shawn Ben

> **v0.2 變更**：後端從 MSW mock 改為真實後端；定位從前端作品集改為全端作品集；部署從靜態託管改為本機 Docker Compose；時程從 5 週封版改為 5 階段 31 單元。變更理由見 `docs/adr/0001`–`0004`。

---

## 1. 專案定位

一個虛構金融品牌的**數位財富管理系統**，前台對應台灣金控 App 中的「投資／理財」分頁，後端是完整的帳務與交易核心。

這不是一個要上線營運的產品，也不是視覺設計作品。它的唯一目的是：**讓技術主管在 30 秒內看出全端架構能力，並在後續面試中有具體的技術問題可以問。**

因此所有範圍決策的判準只有一條 —— 這件事做完，能不能在面試中撐起 5 分鐘的技術討論？不能的話就砍掉。

### 為什麼選這個題目

| 考量 | 說明 |
|---|---|
| 經歷對接 | 過往金融交易平台、第三方支付經驗可直接呼應，細節講得出來 |
| 技術密度 | 即時報價串流、大量明細、多步驟下單、金額精度、**交易一致性**、樂觀更新與回滾 —— 難點集中 |
| 稀缺性 | 市面上作品集多為電商／後台 CRUD，金融場域的正確處理相對少見 |

---

## 2. 目標排序

依重要性排列。時間不夠時，從下往上砍。

1. **金融場域的真實難點** — 交易一致性、金額精度、即時性、錯誤與失敗狀態
2. **可維護的全端架構** — 分層清楚、型別邊界明確、前後端契約單一來源
3. **產品判斷力** — 說得出為什麼砍掉這些功能、MVP 邊界怎麼畫
4. **視覺一致性** — 有 design token 和一致元件即可，不做動畫雕琢

### 驗收標準

- README 第一屏即呈現架構決策說明（不是安裝步驟）
- **附 60 秒 demo 影片或 GIF**（本機部署下這是必要交付，不是選配）
- `docker compose up` 一行啟動，無任何手動步驟
- 任何一個「技術決策」段落，都能回答「為什麼不用另一個方案」

---

## 3. 使用者

### 主要使用者
25–45 歲上班族散戶。手機為主，通勤或睡前快速查看部位。

→ **Mobile-first。桌機是放大版，不是主版型。**

### 次要使用者
55 歲以上。字級小、金額看不清是主要抱怨來源。

→ 最小字級 16px、金額不使用細字重、關鍵操作二次確認。

### 隱藏使用者（實際決定成敗）
技術主管。桌機開啟，30 秒掃過 repo 結構與 README。

→ **專案結構本身就是作品的一部分。** 目錄命名、型別檔案位置、commit message 都在被評估。

---

## 4. 參考對象

抄結構，不抄視覺。

| 對象 | 學什麼 |
|---|---|
| CUBE App | 資產總覽卡片的資訊分層 |
| Home Bank | 多步驟確認流程的節奏 |
| Robinhood | 圖表與數字的留白處理 |
| 富果 Fugle | 台股情境下的高資料密度排版 |

**明確避開**

- 傳統券商舊版下單頁：資訊密度爆炸、無元件系統、桌機思維硬塞手機
- 動畫過重的 fintech 行銷頁：本專案做的是產品內頁，不是 landing page

---

## 5. 品牌識別

### 合規紅線

**不使用任何真實金融機構的名稱、Logo、主色、字體或 UI 截圖。**

公開 repo 加上履歷連結，等同商標使用；面試官若看到，扣的是判斷力的分數。

**延伸紅線**：介面**只陳述事實，不提供任何投資建議**。投資建議涉及金管會的投顧特許業務。詳見 `docs/03-presentation.md`。

### 虛構品牌設定

- **名稱**：**Shawn 財富**（虛構品牌）
- **主色**：中性深藍 `#16243A`，50–950 共 11 階色階
- **強調色**：**靛藍 `#6E6DE4`**（原琥珀 `#B45309` 與台股漲色紅撞色，已降級為警告色）
- **字體**：Noto Sans TC；數字一律 `font-variant-numeric: tabular-nums`

### 台股漲跌色（容易做錯）

台股為 **紅漲綠跌**，與美股相反。漲跌色抽為語意 token：

```
--color-price-up    → 紅 #DC2626
--color-price-down  → 綠 #15803D   ← 標準綠對比度不足，須調深
--color-price-flat  → 灰 #64748B
```

Token 命名用 `up/down` 而非 `red/green`，未來支援美股只需改 token 對應。

**額外發現的衝突**：綠色在 UI 慣例是「成功」，在台股是「跌」；紅色是「錯誤」也是「漲」。解法是成功狀態改用靛藍、錯誤改用玫瑰紅。詳見 `docs/adr/0006`。

---

## 6. 技術決策

每一項都要能回答「為什麼不用替代方案」。完整版見 `docs/00-architecture.md`。

### 前端

| 領域 | 選擇 | 理由 / 替代方案 |
|---|---|---|
| 框架 | React 19 + TypeScript `strict` | 求職主力技術 |
| 建置 | Vite | 不需要 SSR，Next.js 在此屬過度工程 |
| Server state | TanStack Query | 快取、重試、樂觀更新皆為內建 |
| Client state | Zustand | 僅用於 UI 與 Demo 控制台；不與 server state 混用 |
| 表單 | react-hook-form + zodResolver | 多步驟下單需要 field-level 控制 |
| 長列表 | TanStack Virtual | 交易明細 3,000+ 筆 |
| 圖表 | Recharts | 需求為資產曲線，非專業 K 線 |
| 樣式 | Tailwind + CVA | Token 驅動、變體集中管理 |

### 後端

| 領域 | 選擇 | 理由 / 替代方案 |
|---|---|---|
| 框架 | **NestJS + TypeScript** | 型別與前端共用；架構觀念與 Spring Boot 一對一。見 `adr/0002` |
| 資料庫 | **PostgreSQL** | 下單需要 ACID 交易與行鎖 |
| 快取／訊息 | **Redis** | 兩個職責：報價 pub/sub 扇出、下單冪等鍵。見 `adr/0003` |
| 即時 | **WebSocket** | SSE 單向不足；輪詢延遲不可接受 |
| 認證 | **JWT + httpOnly Cookie** | `localStorage` 有 XSS 風險 |

### 共用

| 領域 | 選擇 | 理由 |
|---|---|---|
| Schema / 驗證 | **Zod（放 `shared/`）** | **前後端共用單一來源** —— 全端定位最強訊號 |
| Mock | MSW（**測試專用**） | 「MSW 跑測試、真後端跑運行」證明前端未與後端耦合死 |
| 打包 | **Docker Compose** | 一行啟動；無雲端成本與到期風險 |
| 測試 | Vitest + Testing Library；Playwright 冒煙測試 | 覆蓋核心流程即可，不追覆蓋率數字 |

### 分層原則

```
shared/            # zod 契約 + money.ts，前後端共用
web/
  features/        # 依功能切，不依技術切
    portfolio/
      api/         # query hooks，唯一與 API 對話的層
      components/
      types.ts
  shared/{ui,lib,tokens}
api/
  modules/         # 一個業務領域一個 Module
    orders/        # 下單：transaction + 行鎖 + 冪等
  common/{filters,guards,interceptors,database}
market-feed/       # 報價產生器 → Redis publish
```

**兩條硬性規則**（寫進 README，是分層是否真實存在的證據）：

1. **前端**：`features/*/components` 不得直接呼叫 `fetch`，一律經由同 feature 的 `api/` 層
2. **後端**：Controller 不得直接碰資料庫，一律經由 Service → Repository

### 金額處理

- 一律以**最小單位整數**儲存（新台幣以「分」為單位），絕不使用 float
- 資料庫欄位型別 `BIGINT`；**股數也用 `BIGINT`**（台股零股最小單位是 1 股，不需要 decimal）
- 所有運算集中於 `shared/money.ts`，禁止在元件或 Service 中做金額算術
- 型別以 branded type 標記：`type Cents = number & { readonly __brand: 'Cents' }`
- 顯示層才轉為字串格式化；**後端永遠不回傳格式化字串**

詳見 `docs/adr/0005`。

---

## 7. 功能範圍

### In scope

| 模組 | 內容 | 技術訊號 |
|---|---|---|
| 資產總覽 ＋ 持倉 | **合併單頁**：總市值、損益、走勢曲線、即時報價 | 資料聚合、圖表、骨架屏、選擇性重繪 |
| 交易明細 | 3,000+ 筆、篩選、日期區間、無限捲動 | 虛擬滾動、cursor 分頁、URL 狀態同步 |
| 下單流程 | 選標的 → 填數量 → 確認 → 結果 | **DB transaction、行鎖、冪等鍵**、樂觀更新、失敗回滾 |
| 即時報價 | WebSocket 推送、重連、新鮮度降級 | Redis pub/sub、連線管理、指數退避 |
| 錯誤狀態 | 網路失敗、餘額不足、下單被拒、報價中斷、**逾時** | 統一錯誤碼、Exception Filter、error boundary、降級顯示 |
| **最小認證** | 單一 demo 帳號 + JWT | Guard、httpOnly Cookie、IDOR 防護 |
| Demo 控制台 | 見第 9 節 | **後端故障注入 middleware**、情境注入 |

> **v0.2 變更**：認證從 Out of scope 移入 In scope。改真後端後 API 裸奔說不過去，但只做最小 JWT，不做註冊與 OAuth。

### Out of scope（明確不做，README 需寫明理由）

- 註冊流程、OAuth、多使用者
- **線上部署**（本機 Docker Compose 即可，見 `adr/0004`）
- 多語系 i18n
- 深色模式（**但 token 分層已預留**，見 `adr/0009`）
- 微服務拆分、K8s
- K 線圖與技術指標
- PWA 與離線支援

---

## 8. 里程碑

**5 階段、31 個單元。不綁週數。**

每個單元做完即停 → 程式碼導讀 → 確認理解 → 才進下一個。**絕不批次交付。**

| 階段 | 交付內容 | 單元 | 完成判準 |
|---|---|---|---|
| **P0** | 地基：Docker Compose、schema、migration、seed、金額型別 | 6 | `docker compose up` 一行啟動，`psql` 看得到假資料 |
| **P1** | 讀取路徑：查詢 API、總覽頁、虛擬滾動 | 10 | 3,000 筆捲動，CPU 4x 節流下無 long task > 50ms |
| **P2** | 即時路徑：market-feed、Redis pub/sub、WebSocket | 5 | 關掉 feed 服務後 5 秒內顯示「報價中斷」 |
| **P3** | **寫入路徑：下單、交易一致性、樂觀更新回滾** | 6 | 下單被拒時 UI 還原且餘額不變；連點兩次只成立一筆 |
| **P4** | 韌性與交付：錯誤契約、Demo 控制台、README、影片 | 4 | 陌生人可自行操作出所有錯誤狀態 |

**以全職 35–40 小時／週估算，含導讀與問答時間約 12–16 週。**

每個階段末有**學習檢查點** —— 答不出來就回頭讀，答得出來才進下一階段。導讀與問答本身就是學習時間，不是額外開銷。

---

## 9. Demo 控制台

### 為什麼不做完整後台

真正的問題是：**要不要用第二個 App 的成本，去展示 RBAC 與 CRUD？**

- **做**：後台是 BPM 企業平台經驗的正面戰場（權限路由、角色切換、schema 驅動表單）。但等同做第二個 App，且會稀釋核心深度。
- **不做**：架構訊號集中於交易一致性、即時性、虛擬滾動 —— 更難，也更少人做。

**決策：不做後台，改做 Demo 控制台。**

效果是面試官不需要你在旁解說，自己就能把所有 error handling 點出來 —— 這比一個能新增文章的後台有用得多。

> 若日後想展示 RBAC，另開獨立小專案，不塞進本專案。

### v0.2 變更：故障注入移到後端

原設計是 MSW handler 讀 Zustand store。改真後端後，**故障注入放在後端 middleware**：

- 更真實 —— 故障發生在網路層之外，前端對來源完全無感知
- 這是分層正確性的證明

### State 設計

```ts
/** 帳戶情境：決定 seed 資料的形狀 */
type AccountScenario =
  | 'new-user'        // 無部位、無明細，測空狀態
  | 'active'          // 標準情境，多檔部位、混合損益
  | 'insufficient'    // 餘額不足，用於下單失敗
  | 'heavy-history';  // 8,000 筆明細，壓測虛擬滾動

/** 故障注入：可同時開啟多項 */
type FaultKind =
  | 'api-500'          // 伺服器錯誤
  | 'order-rejected'   // 下單被拒（驗證回滾）
  | 'quote-disconnect' // 報價中斷（驗證降級顯示）
  | 'api-timeout'      // 逾時（驗證「狀態未知」分支）
  | 'slow-network';    // 全域延遲 3s，觀察骨架屏
```

### 實作要點

- **狀態持久化至 URL query string，以 `_demo_` 前綴隔離** —— 避免與明細篩選參數打架；面試官可把「下單被拒」的情境連結直接貼給同事
- **故障注入在後端 middleware**，元件對此無感知
- **`seed` 固定亂數**，同一情境每次重整結果一致
- **切換 scenario 時清空 TanStack Query 快取**，避免舊資料殘留
- 控制台以 `NODE_ENV !== 'production' || ENABLE_DEMO=1` 控制掛載（NestJS 動態模組，關閉時路由不存在）

---

## 10. 資料層

沒有真實市場資料的金融 demo，九成垮在假資料上。

- **相對時間產生種子資料**（`now - 30d`），絕不寫死日期。否則半年後打開，明細停在去年，可信度歸零
- **報價必須會動**：`market-feed` 服務持續推送 tick。靜態數字一眼就看得出是假的
- **錯誤狀態是重點不是附屬**：happy path 面試官三秒滑過，error handling 才會讓他停下來提問
- **資料必須自洽**：先產生 `transactions`（歷史成交），才推導出 `positions`（當前持倉）與 `snapshots`（每日快照）。持倉的平均成本要真的等於歷史買入的加權平均 —— 面試官若心算發現對不上，整個專案的可信度就崩了
- 種子資料以 factory function 產生，接受 `seed` 與 `scenario` 參數

---

## 11. 長期維護

作品集最常見的死法：六個月後面試官點進去，畫面全白或數字停在去年。

**v0.2 策略變更**：改為**本機 Docker Compose，不做線上部署**。

- **沒有伺服器就沒有到期問題** —— 免費雲端方案六個月後會休眠或刪庫，這正是要避免的死法
- 封版後鎖定 lockfile、**pin 死 Docker 映像版本**（`postgres:16.4-alpine` 而非 `postgres:latest`），關閉自動依賴升級 PR
- README 標註 `Last verified: 2026-XX` —— 誠實勝過假裝持續維護
- 每次求職週期前執行一次冒煙測試（`git clone` → `docker compose up` → 操作一輪），確認未爛掉

### 因應「無線上 demo」的緩解措施

1. **README 首屏放 60 秒 GIF／影片** —— 必要交付，不是選配
2. **一行啟動** —— 自動 migration + seed，標明啟動耗時與資源需求
3. **關鍵畫面截圖進 repo** —— 總覽、下單確認、下單被拒、報價中斷四張

---

## 12. 備註

- ✅ **品牌名稱** —— **Shawn 財富**。字串收斂在 `shared/src/index.ts` 的 `APP_NAME`，UI 不寫死，改名只需改一行
- README 需附「本專案為虛構品牌，與任何真實金融機構無關」聲明
- 介面不得提供任何投資建議（合規紅線的延伸）

---

## 相關文件

完整規格見 [`docs/`](docs/README.md)。動工前必讀 [`docs/00-architecture.md`](docs/00-architecture.md)。
