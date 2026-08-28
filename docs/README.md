# 文件索引

**Shawn 財富** 數位財富管理 —— 技術文件。

> **想快速了解這個專案？** 先讀[根目錄的 README](../README.md)，
> 再看 [`00-architecture.md`](00-architecture.md) 的「架構建議」與 [`adr/`](adr/) 的決策紀錄。

---

## 規格文件

| 文件 | 內容 | 什麼時候該讀 |
|---|---|---|
| [`00-architecture.md`](00-architecture.md) | 服務拓撲、模組拆解、**前後端分工**、技術棧、註解規範 | **從這裡開始**。動工前必讀 |
| [`01-proposal.md`](01-proposal.md) | 網站結構、做了哪些畫面、**沒做哪些以及為什麼** | 想知道功能邊界怎麼畫的 |
| [`02-backend.md`](02-backend.md) | ER 圖、Schema、索引、**交易一致性**、API 表、WS 協定、錯誤碼、認證 | 寫後端任何程式碼之前 |
| [`03-presentation.md`](03-presentation.md) | 格式化規範、狀態推導、圖表建議、**警示策略** | 寫任何顯示資料的元件之前 |
| [`04-design-system.md`](04-design-system.md) | Design Token（色階、字級、間距）、元件清單 | 寫任何 UI 之前 |
| [`07-reading-guide.md`](07-reading-guide.md) | 程式碼閱讀路線圖 | 不知道從哪裡開始讀程式碼時 |

## 頁面實作規格

| 文件 | 路由 | 重點 |
|---|---|---|
| [`05-specs/portfolio.md`](05-specs/portfolio.md) | `/portfolio` | 版面、即時報價的逐列訂閱 |
| [`05-specs/transactions.md`](05-specs/transactions.md) | `/transactions` | 虛擬滾動、URL 狀態同步 |
| [`05-specs/trade.md`](05-specs/trade.md) | `/trade/*` | 冪等鍵時機、為什麼是悲觀更新 |

## 決策紀錄（ADR）

每則一頁，格式為「背景 → 決策 → 替代方案 → 後果」。

| # | 決策 | 一句話 |
|---|---|---|
| [0001](adr/0001-real-backend-over-msw.md) | 真實後端而非 MSW mock | 交易一致性在 mock 環境演不出來（MSW 改負責測試與靜態展示版） |
| [0002](adr/0002-nestjs-over-spring-boot.md) | NestJS 而非 Spring Boot | 前後端型別共用，契約只有一份 |
| [0003](adr/0003-redis-two-responsibilities.md) | Redis 只承擔兩個職責 | 沒有明確理由的 Redis 只是多一個要維運的元件 |
| [0004](adr/0004-local-only-no-cloud-deploy.md) | 後端只做本機、前端靜態託管 | 免費方案的資料庫 30 天就過期 |
| [0005](adr/0005-money-as-bigint-cents.md) | 金額用整數分 ＋ branded type | 浮點誤差在金融系統不可接受 |
| [0006](adr/0006-semantic-price-color-tokens.md) | 漲跌色用語意 token | 台股紅漲綠跌，且與 UI 慣例衝突 |
| [0007](adr/0007-merge-overview-and-positions.md) | 總覽與持倉合併單頁 | 使用者情境是「三十秒快速查看」 |
| [0008](adr/0008-order-step-in-url-data-in-memory.md) | 下單步驟走路由、資料不持久化 | 下單草稿本來就不該被還原 |
| [0009](adr/0009-defer-dark-mode.md) | 不做深色模式，但 token 預留 | 是工作量不是技術難度 |
| [0010](adr/0010-raw-sql-over-orm.md) | 原生 SQL，不用 ORM | 行鎖與 cursor 分頁在 ORM 底下都要繞回原生 SQL |
| [0011](adr/0011-runtime-transpile-no-build.md) | api 不做 build，執行期用 SWC 轉譯 | shared 直接匯出 .ts，而 NestJS 的 DI 需要 decorator metadata |

---

## 常見問題：這件事寫在哪？

| 你想找 | 去哪看 |
|---|---|
| 為什麼下單要用 `SELECT ... FOR UPDATE` | [`02-backend.md`](02-backend.md) → 交易一致性設計 |
| 下單失敗時 UI 怎麼處理 | [`05-specs/trade.md`](05-specs/trade.md) → 為什麼是悲觀更新 |
| 金額 `null` 和 `0` 顯示有什麼不同 | [`03-presentation.md`](03-presentation.md) → 邊界條件 |
| 為什麼成功狀態不用綠色 | [`04-design-system.md`](04-design-system.md) → 狀態色 |
| 未實現損益是前端算還後端算 | [`00-architecture.md`](00-architecture.md) → 權威值 vs 衍生值 |
| 報價中斷時哪些功能還能用 | [`03-presentation.md`](03-presentation.md) → 報價新鮮度狀態機 |
| 明細分頁為什麼不用 `OFFSET` | [`02-backend.md`](02-backend.md) → 索引建議 |
| 冪等鍵什麼時候產生 | [`05-specs/trade.md`](05-specs/trade.md) → URL 策略定案 |
| 線上版與本機版差在哪 | [根目錄 README](../README.md) → 兩種展示 |
| 故障注入怎麼運作 | [根目錄 README](../README.md) → Demo 控制台 |
| 為什麼沒做 rate limiting | [`02-backend.md`](02-backend.md) → Rate Limiting |
| 哪些元件刻意沒做 | [`04-design-system.md`](04-design-system.md) → 元件清單 |
| 程式碼註解要寫多細 | [`00-architecture.md`](00-architecture.md) → 程式碼註解規範 |

---

> **本專案為虛構品牌，與任何真實金融機構無關。** 所有資料皆為程式產生的假資料，不構成任何投資建議。
