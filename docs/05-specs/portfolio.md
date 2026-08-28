# 05-1 — 資產總覽頁實作規格

> 路由 `/portfolio`｜實作於 [`web/src/routes/PortfolioPage.tsx`](../../web/src/routes/PortfolioPage.tsx)
> 版本 0.2｜2026-08-28

---

## 頁面概述

**App 的預設首頁。** 使用者打開就是這一頁。

**總覽與持倉合併為單頁**（[ADR 0007](../adr/0007-merge-overview-and-positions.md)）。使用者情境是「通勤或睡前快速查看部位」，分成兩個分頁等於強迫他多點一次才能看到最關心的資訊。

### 版面結構（由上而下）

```
┌─────────────────────────────────┐
│ 頂部列：帳號 ＋ Demo 控制台入口    │
├─────────────────────────────────┤
│ 🔵 報價中斷橫幅（僅斷線時出現）    │
├─────────────────────────────────┤
│ 總覽卡片                          │
│   總資產（36px 粗體）              │
│   今日損益                        │
│   現金｜持股市值｜未實現｜已實現    │
├─────────────────────────────────┤
│ 資產走勢曲線（近 30 個交易日）      │
├─────────────────────────────────┤
│ 持倉列表                          │
│   ├ 2330 台積電   NT$ 338,328     │
│   │  381 股·均價 879.71·現價 888  │
│   │                ▲ +3,158 +0.94%│
│   └ 2454 聯發科  ...             │
│      （整列連到 /trade/:symbol）   │
├─────────────────────────────────┤
│ 底部 Tab Bar：資產 / 明細 / 下單   │
└─────────────────────────────────┘
```

---

## 元件清單

實際的組成（全部在 `PortfolioPage.tsx` 這一個檔案裡，不另外拆檔）：

| 區塊 | 說明 |
|---|---|
| `OverviewCard` | 總資產、今日損益、現金、持股市值、未實現／已實現損益 |
| `TrendCard` | 資產走勢折線圖（Recharts） |
| `PositionsCard` ＋ `PositionRow` | 持倉列表。每一列各自訂閱自己那一檔的報價 |
| `MoneyText`｜`PriceChange`｜`Skeleton`｜`EmptyState`｜`ErrorState` | 來自 [`shared/ui`](../../web/src/shared/ui/index.tsx) |
| `QuoteFeedBanner`｜`FreshnessTag` | 來自 [`features/quotes`](../../web/src/features/quotes/components/QuoteStatus.tsx) |

> 三個 Card 都是同一個檔案裡的區域元件。抽成獨立檔案的門檻是「**有第二個使用者**」——
> 目前沒有，抽出去只會多三個只被 import 一次的檔案。

### 沒有做的

| 原本規劃 | 為什麼 |
|---|---|
| `SmartSummary`（自然語言摘要） | 合規風險 ＋ 資訊重複。見 [`03-presentation.md`](../03-presentation.md) |
| 持倉列展開詳情 | 列表上已經有股數、均價、現價、市值、損益。展開只是把同樣的數字換個位置 |

---

## 元件規格

### `PortfolioSummaryCard`

| 項目 | 規格 |
|---|---|
| 容器 | `Card`，`padding: var(--space-6)`，`radius: var(--radius-lg)` |
| 總資產數字 | `--text-4xl`(36px) ／ `--weight-bold`(700) ／ `tabular-nums` |
| 總資產標籤 | `--text-sm` ／ `--color-text-secondary` |
| 今日損益 | `--text-lg` ／ `PriceChange` 元件 ／ 顯示金額與百分比 |
| 次要數值（現金、持股市值） | `--text-base` ／ `--weight-medium` ／ 兩欄並排 |
| 區塊間距 | `--space-4` |

**資料來源**：`GET /api/v1/portfolio/summary`

> **「今日損益」用哪個基準？** 用 `prev_close_cents`（昨收）為基準，不是「今天開盤的資產」。這符合使用者對「今天賺賠」的直覺。

### `PositionRow`

| 位置 | 內容 | 樣式 |
|---|---|---|
| 左上 | 代號 ＋ 股票名稱 | `text-lg` / `font-semibold`；名稱單行省略 ＋ `title` |
| 左下 | 持股數（`1,081 股（1 張 81 股）`）、均價、現價、新鮮度標籤 | `text-sm` / `text-text-secondary` |
| 右上 | 市值 | `MoneyText size="lg"` |
| 右下 | `PriceChange`（未實現損益 ＋ 報酬率） | 預設尺寸 |

整列是一個連到 `/trade/:symbol` 的連結 —— 看到某檔想加碼或減碼時，
下一個動作就在同一個地方。

| 項目 | 規格 |
|---|---|
| 列高 | 最小 72px（觸控目標 ≥ 44px） |
| 分隔 | `divide-y divide-border` |
| 重繪範圍 | **只有這一列**。每列各自 `useLivePrice(symbol)` 訂閱自己那一檔，11 檔持倉時一筆報價只重畫 1/11 |

> **報價跳動閃爍沒有做。** 理由見 [`04-design-system.md`](../04-design-system.md)。

### `PortfolioChart`

| 項目 | 規格 |
|---|---|
| 圖表類型 | 折線圖 ＋ 漸層填充（Recharts `AreaChart`） |
| 高度 | 手機 180px ／ 桌機 240px |
| 線色 | 期間報酬為正 → `--color-price-up`；為負 → `--color-price-down` |
| Y 軸 | **不從 0 起**（見 `03-presentation.md`）；不顯示軸線，只在 tooltip 顯示數值 |
| X 軸 | 只標首、中、末三個日期 |
| 互動 | 觸控／滑鼠移動顯示當日總資產 ＋ 日期 |

**資料來源**：`GET /api/v1/portfolio/snapshots?days=30`

---

## 互動狀態說明

**五種狀態全部必須實作。** 錯誤狀態是本專案主打。

| 狀態 | 觸發條件 | 視覺表現 |
|---|---|---|
| `default` | 資料載入完成 | 正常顯示 |
| `loading` | 首次載入 | **骨架屏**：總覽卡片顯示數字形狀的 `Skeleton`；持倉顯示 5 列骨架；圖表顯示灰底區塊 |
| `empty` | 無持倉（`new-user` 情境） | 總覽卡片正常顯示（現金仍有值）；持倉區塊顯示 `EmptyState`「尚無持倉」＋「開始下單」按鈕 |
| `error` | API 失敗 | **區塊級降級**：哪個區塊失敗只有該區塊顯示 `ErrorState` ＋ 重試鈕，其他區塊正常 |
| `offline` | WebSocket 斷線 | 頂部橘色 `QuoteBanner`「報價連線中斷，顯示最後價格」；價格數字加灰底；**其餘功能仍可用** |

### 區塊級降級的具體要求

走勢圖 API 掛掉時，**持倉列表必須正常顯示**。實作上每個資料區塊獨立包 error boundary，各自有自己的 TanStack Query。

> 這是本頁最重要的實作要求。整頁白掉是最糟的錯誤處理。

### 載入順序

三個 API 平行發出，**各自渲染**，不等彼此：

```
GET /portfolio/summary   → 總覽卡片
GET /positions           → 持倉列表
GET /portfolio/snapshots → 走勢圖
```

不做「全部載完才顯示」—— 那會讓使用者盯著空白畫面。

---

## 響應式斷點規則

| 斷點 | 版型 |
|---|---|
| < 640px（預設） | 單欄。總覽卡片全寬、圖表全寬、持倉單欄列表。底部 Tab Bar |
| ≥ 640px | 總覽卡片內的次要數值改三欄並排 |
| ≥ 1024px | **頂部導覽取代底部 Tab**（實作為頂部橫向導覽，不是側邊欄）；內容維持單欄、最大寬度 `max-w-5xl` |

---

## Handoff 注意事項

### 容易踩的坑

1. **未實現損益是前端算的** —— 後端不回傳這個欄位。用 `avgCostCents` ＋ WebSocket 最新報價計算。如果去 API 找這個欄位會找不到。

2. **只重繪變動的那一列** —— 報價每秒推送，若整個持倉列表重繪，低階手機會掉幀。`PositionRow` 要用 `memo`，且比較函式只比該檔標的的價格。

3. **買賣不使用漲跌色** —— 漲跌色專屬於價格變動。持倉列表裡沒有「買進／賣出」概念，不會遇到；但 `03-presentation.md` 有這條規則，明細頁會用到。

4. **`0` 與 `null` 顯示不同** —— 餘額為 0 顯示 `NT$ 0`，資料未載入顯示 `—`。

5. **總覽卡片在 `empty` 情境仍要顯示** —— 新使用者有現金但無持倉，總資產 = 現金。不要整張卡片變空狀態。

### 效能要求

| 項目 | 目標 |
|---|---|
| 首次內容繪製 | 骨架屏在 200ms 內出現 |
| 報價更新 | 單列重繪，不觸發整表 re-render |
| 圖表 | 30 個資料點，不需虛擬化 |

### 與設計的已知差異

- 無 Figma 設計稿，本規格以 `01-proposal.md` 的 Sitemap 與 `04-design-system.md` 的 token 為準
- 圖示暫用 Lucide React，不客製
