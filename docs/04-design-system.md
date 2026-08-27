# 04 — 設計系統

> 情境 C 產出｜Design Token 與元件庫規範
> 版本 0.1｜2026-08-13｜維護者：Shawn Ben

---

## Design Brief

**Shawn 財富是一個給散戶的數位財富管理介面。它的設計目標只有一個：讓使用者在通勤的三十秒內，準確知道自己的錢現在是什麼狀況。**

### 核心原則

| 原則 | 具體要求 |
|---|---|
| **數字優先** | 版面服務數字。金額、漲跌、報酬率是主角，裝飾元素一律讓路 |
| **準確勝於美觀** | 小數點對齊、等寬數字、正負號明確。寧可醜也不能讓人看錯 |
| **狀態必須可見** | 資料是即時的、延遲的、還是斷線的，使用者永遠看得出來 |
| **可讀性下限** | 內文最小 16px、金額字重不低於 500、關鍵色彩對比達 WCAG AA |
| **不做投資建議** | 只陳述事實。設計上不提供任何暗示買賣的視覺引導 |

### 風格定位

**簡潔 ＋ 高資料密度。** 參考 Robinhood 的數字留白處理與富果的台股排版密度，但不抄視覺。

明確避開：傳統券商舊版下單頁（資訊密度爆炸、桌機思維硬塞手機）、動畫過重的 fintech 行銷頁（本專案是產品內頁，不是 landing page）。

### 裝置策略

**Mobile-first。桌機是放大版，不是主版型。** 所有元件先在 375px 寬度下設計，再往上擴展。

---

## Token 分層架構 ★

**兩層設計，這是本設計系統最重要的結構決策。**

```
原始層（Primitive）          語意層（Semantic）            元件使用
--navy-900: #16243A    →    --color-text-primary    →    color: var(--color-text-primary)
--red-600:  #DC2626    →    --color-price-up        →    color: var(--color-price-up)
```

| 層級 | 命名方式 | 誰可以用 |
|---|---|---|
| **原始層** | 顏色名 ＋ 階數（`--navy-500`） | **只有語意層可以引用**。元件禁止直接使用 |
| **語意層** | 用途名（`--color-price-up`） | 所有元件只能用這一層 |

### 為什麼要分兩層

1. **切換市場情境只改一行** —— 台股紅漲綠跌，美股相反。只要把 `--color-price-up` 從紅改指向綠，所有元件自動跟著變，**不用改任何元件程式碼**
2. **深色模式的預留** —— 本專案不做深色模式，但只要重新定義語意層的對應值就能支援。原始層完全不用動
3. **強制思考用途** —— 寫 `--color-price-up` 會逼你想「這個顏色代表什麼意思」，寫 `--red-600` 則不會

> **「不做深色模式」因此是架構上的延後，而不是做不到。** 這個區別在面試時值得主動說明。

---

## 原始層：色階

### 深藍（Navy）— 品牌主色

| 階 | 色碼 | 用途 |
|---|---|---|
| 50 | `#F5F7FA` | 頁面背景 |
| 100 | `#E8EDF3` | 卡片次要背景、分隔線 |
| 200 | `#CFD9E6` | 邊框 |
| 300 | `#ABBCD2` | 停用狀態 |
| 400 | `#7E96B6` | 佔位文字 |
| 500 | `#5B769B` | 次要文字 |
| 600 | `#465D80` | — |
| 700 | `#384968` | — |
| 800 | `#2A3750` | 標題 |
| **900** | **`#16243A`** | **品牌主色**、主要文字 |
| 950 | `#0C1523` | 最深，導覽列背景 |

### 靛藍（Indigo）— 強調色

| 階 | 色碼 | 用途 |
|---|---|---|
| 50 | `#F2F3FE` | 強調區塊淺底 |
| 100 | `#E6E7FD` | — |
| 200 | `#CFD1FA` | — |
| 300 | `#ADB0F5` | — |
| 400 | `#8B8DEE` | — |
| **500** | **`#6E6DE4`** | **強調色主值** |
| 600 | `#5A54D6` | 主要按鈕、成功狀態 |
| 700 | `#4B44B8` | 按鈕 hover |
| 800 | `#3E3A95` | 按鈕 active |
| 900 | `#363377` | — |
| 950 | `#211F45` | — |

> **強調色從原本規劃的琥珀改為靛藍。** 琥珀（`#B45309`）與台股漲色紅在色相上太近，持倉列表裡「紅色的上漲數字」旁邊放「琥珀色的買進按鈕」，兩塊暖色會互相干擾。靛藍與紅綠都拉開距離，且是深藍主色的同色系延伸。
>
> 琥珀沒有被丟掉 —— 它降級為**警告色**，見下方。

---

## 語意層：色彩 Token

### 台股漲跌色 ★

```css
--color-price-up:      #DC2626;  /* 紅 — 台股上漲 */
--color-price-down:    #15803D;  /* 綠 — 台股下跌 */
--color-price-flat:    #64748B;  /* 灰 — 平盤 */

--color-price-up-bg:   #FEE2E2;  /* 報價跳動時的閃爍背景 */
--color-price-down-bg: #DCFCE7;
```

> **綠色必須調深才合格。** 標準綠 `#16A34A` 對白底的對比只有 **3.05:1**，未達 WCAG AA 的 4.5:1。調深到 `#15803D` 後是 **4.62:1** ✓。
>
> 綠色天生在白底上的對比就低，這是很多介面無障礙不合格的原因。紅色 `#DC2626` 是 4.53:1，剛好過關。

### 狀態色（刻意避開漲跌色）

```css
--color-success: #5A54D6;  /* 靛藍 600 — 不用綠！ */
--color-warning: #B45309;  /* 琥珀 — 原強調色降級再利用 */
--color-error:   #BE123C;  /* 玫瑰紅 — 偏洋紅，與漲色區隔 */
--color-info:    #5B769B;  /* 深藍 500 */
```

> **這是本設計系統解決的最關鍵衝突：金融介面的色彩語意打架。**
>
> | 衝突 | 一般 UI 慣例 | 台股語意 | 解法 |
> |---|---|---|---|
> | 綠色 | 成功 ✓ | **下跌**（壞消息） | **成功改用靛藍**，綠色專屬於「跌」 |
> | 紅色 | 錯誤 ✕ | **上漲**（好消息） | **錯誤改用玫瑰紅** `#BE123C`，與漲色 `#DC2626` 區隔 |
>
> 如果不處理，下單成功時彈出的綠色勾勾，在使用者的金融直覺裡是「跌」。這個衝突值得在面試中主動提出。

### 介面色

```css
--color-bg-page:       #F5F7FA;  /* navy-50 */
--color-bg-surface:    #FFFFFF;  /* 卡片 */
--color-bg-subtle:     #E8EDF3;  /* navy-100 */
--color-border:        #CFD9E6;  /* navy-200 */
--color-border-strong: #ABBCD2;  /* navy-300 */

--color-text-primary:   #16243A;  /* navy-900 */
--color-text-secondary: #5B769B;  /* navy-500 */
--color-text-placeholder:#7E96B6; /* navy-400 */
--color-text-inverse:   #FFFFFF;
--color-text-disabled:  #ABBCD2;  /* navy-300 */
```

---

## 字體與排版 Token

### 字體家族

```css
--font-sans: 'Noto Sans TC', -apple-system, BlinkMacSystemFont, sans-serif;
--font-numeric-feature: tabular-nums;  /* 所有數字必用 */
```

### 字級（最小 16px 是硬性下限）

| Token | 大小 | 用途 | 限制 |
|---|---|---|---|
| `--text-xs` | 12px | 僅限非關鍵標籤 | **禁用於任何數值** |
| `--text-sm` | 14px | 輔助說明、時間戳 | 不用於金額 |
| `--text-base` | **16px** | **內文下限** | — |
| `--text-lg` | 18px | 列表主要文字、金額 | — |
| `--text-xl` | 20px | 區塊標題 | — |
| `--text-2xl` | 24px | 頁面標題 | — |
| `--text-3xl` | 30px | 持倉市值 | — |
| `--text-4xl` | 36px | **總資產數字** | — |

> **12px 禁用於數值**是為了 55 歲以上的次要使用者。金額看不清是這個族群最主要的抱怨來源。

### 字重

```css
--weight-normal:   400;  /* 一般文字 */
--weight-medium:   500;  /* 金額下限 —— 金額絕不使用細字重 */
--weight-semibold: 600;  /* 標題、重要數值 */
--weight-bold:     700;  /* 總資產 */
```

### 行高

```css
--leading-tight:  1.25;  /* 數字、標題 */
--leading-normal: 1.5;   /* 內文 */
--leading-relaxed:1.75;  /* 長段落說明 */
```

> 中文的行高需求比英文高。1.5 是中文內文的下限，1.4 以下會擠。

---

## 間距與形狀 Token

### 間距（4px 基準）

```css
--space-1: 4px;    --space-2: 8px;    --space-3: 12px;
--space-4: 16px;   --space-5: 20px;   --space-6: 24px;
--space-8: 32px;   --space-10: 40px;  --space-12: 48px;
--space-16: 64px;
```

### 圓角

```css
--radius-sm:   4px;    /* 標籤、徽章 */
--radius-md:   8px;    /* 按鈕、輸入框 */
--radius-lg:   12px;   /* 卡片 */
--radius-full: 9999px; /* 圓形 */
```

### 陰影（節制使用）

```css
--shadow-sm: 0 1px 2px rgba(22, 36, 58, 0.06);
--shadow-md: 0 4px 12px rgba(22, 36, 58, 0.08);
--shadow-lg: 0 12px 32px rgba(22, 36, 58, 0.12);  /* 僅用於 Drawer / Dialog */
```

> **手機優先意味著少用陰影，多用邊框。** 陰影在小螢幕上容易讓密集列表顯得髒。卡片之間用 `--color-border` 分隔即可。

### 動效

```css
--duration-instant: 100ms;  /* 按鈕回饋 */
--duration-fast:    150ms;  /* 報價閃爍淡出 */
--duration-normal:  250ms;  /* Drawer 滑入 */
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
```

> **只做狀態轉場，不做裝飾動畫。** 本專案是產品內頁，不是 landing page。

### 響應式斷點

| Token | 寬度 | 版型變化 |
|---|---|---|
| （預設） | < 640px | 單欄、底部 Tab Bar |
| `sm` | ≥ 640px | 卡片橫向排列 |
| `md` | ≥ 768px | 明細改雙欄資訊 |
| `lg` | ≥ 1024px | **左側導覽取代底部 Tab**、總覽雙欄 |

---

## 核心元件清單

按實作優先序排列。所有元件用 CVA 管理變體。

### P0 — Phase 1 必須完成

| 元件 | 用途 | 主要 Variants |
|---|---|---|
| **`MoneyText`** | 金額顯示的唯一入口 | `size`: sm/base/lg/xl/2xl｜`showSign`: bool｜`colorBy`: none/sign |
| **`PriceChange`** | **漲跌三重編碼** | `format`: value/percent/both｜`size`｜`showArrow`: bool |
| **`Card`** | 內容容器 | `padding`: sm/md/lg｜`variant`: default/subtle |
| **`Button`** | 動作 | `variant`: primary/secondary/ghost/danger｜`size`: sm/md/lg｜`loading` |
| **`Skeleton`** | 載入骨架 | `variant`: text/number/block/row |
| **`EmptyState`** | 空資料 | `icon`｜`title`｜`description`｜`action` |
| **`ErrorState`** | 錯誤 ＋ 重試 | `scope`: block/page｜`onRetry`｜`traceId` |

**`MoneyText` 與 `PriceChange` 是最重要的兩個元件** —— 所有金額與漲跌一律經過它們，禁止在頁面裡直接寫 `<span>{amount}</span>`。這是「金額運算集中於單一入口」原則在呈現層的延伸。

### P1 — Phase 2–3

| 元件 | 用途 | 主要 Variants |
|---|---|---|
| `Badge` | 狀態標籤 | `variant`: neutral/success/warning/error |
| `QuoteFreshnessIndicator` | 報價新鮮度 | `state`: live/stale/disconnected |
| `Field` | 表單欄位 ＋ 錯誤 | `error`｜`hint`｜`required` |
| `NumberInput` | 股數／價格輸入 | `step`｜`min`/`max`｜`suffix` |
| `StepIndicator` | 下單步驟 | `steps`｜`current` |
| `Dialog` | **二次確認** | `variant`: default/danger |
| `BottomNav` / `SideNav` | 導覽（響應式切換） | — |

### P2 — Phase 4

| 元件 | 用途 |
|---|---|
| `Drawer` | Demo 控制台側邊抽屜 |
| `Toast` | 操作回饋 |
| `Banner` | 全域提示（報價中斷） |

---

## 關鍵元件規格

### `PriceChange` — 三重編碼

```tsx
<PriceChange
  currentCents={108500}
  baseCents={107000}
  format="both"
/>
// 輸出：▲ +15.00 (+1.40%)   紅色
```

| 狀態 | 顏色 | 符號 | 正負號 |
|---|---|---|---|
| 上漲 | `--color-price-up` | `▲` | `+` |
| 下跌 | `--color-price-down` | `▼` | `−` |
| 平盤 | `--color-price-flat` | `—` | 無 |

**三者缺一不可。** 顏色給一般使用者、符號給色覺辨識障礙者、正負號給所有人。

### `MoneyText` — 金額顯示

必須套用：
- `font-variant-numeric: tabular-nums`（小數點對齊）
- 字重 ≥ `--weight-medium`（500）
- `null` → `—`，`0` → `NT$ 0`

### 報價跳動閃爍

報價更新時，該欄位背景閃對應漲跌色，`--duration-fast`（150ms）淡出。

```css
@keyframes flash-up {
  from { background-color: var(--color-price-up-bg); }
  to   { background-color: transparent; }
}
```

> 成本極低但效果顯著 —— demo 影片裡會非常「像真的」。

---

## 設計開發協作規範

### 命名規則

| 對象 | 規則 | 範例 |
|---|---|---|
| CSS 變數（原始層） | `--{色名}-{階}` | `--navy-900` |
| CSS 變數（語意層） | `--color-{用途}` / `--{類別}-{名}` | `--color-price-up`、`--space-4` |
| 元件檔名 | PascalCase | `PriceChange.tsx` |
| 元件 props | camelCase，布林用 `is`/`show`/`has` 前綴 | `showArrow` |
| CVA variant 值 | kebab-case 或單字 | `variant: 'primary'` |

### 硬性規範

1. **元件禁止使用原始層 token** —— 只能用語意層。code review 會檢查
2. **金額一律經 `MoneyText`**，漲跌一律經 `PriceChange`
3. **禁止硬編色碼** —— 任何 `#` 開頭的顏色只能出現在 token 定義檔
4. **禁止硬編間距** —— 用 `--space-*`，不寫 `margin: 13px`
5. **買賣不使用漲跌色** —— 漲跌色專屬於價格變動（見 `03-presentation.md`）

### Token 定義檔位置

```
web/shared/tokens/
├── primitive.css    # 原始層：色階、字級、間距
├── semantic.css     # 語意層：用途對應
└── index.css        # 匯入 + Tailwind 對接
```

Tailwind 設定透過 `theme.extend` 引用 CSS 變數，讓 `bg-surface`、`text-price-up` 這類 class 可用。

---

## 替代方案與不選的理由

| 我們的選擇 | 沒選的方案 | 捨棄理由 |
|---|---|---|
| 強調色靛藍 | 琥珀 `#B45309` | 與台股漲色紅色相太近，按鈕與數字互相干擾 |
| 成功色用靛藍 | 用綠色（UI 慣例） | 台股綠 = 跌，綠色勾勾在金融直覺裡是壞消息 |
| 錯誤色用玫瑰紅 | 用標準紅 `#DC2626` | 與漲色同色，錯誤訊息與上漲數字撞色 |
| 跌色調深至 `#15803D` | 標準綠 `#16A34A` | 標準綠對白底僅 3.05:1，未達 WCAG AA |
| Token 兩層架構 | 單層直接用色碼 | 無法切換市場情境，也無法預留深色模式 |
| CVA | styled-components | CSS-in-JS 有執行期成本；CVA 是編譯期的 class 組合 |
| Tailwind | 純 CSS Modules | Token 驅動下 Tailwind 的 utility 更快，且變體集中在 CVA |
| 少陰影多邊框 | 大量卡片陰影 | 小螢幕密集列表用陰影會顯髒 |
| 內文下限 16px | 14px（常見預設） | 55+ 次要使用者的可讀性需求 |
