/**
 * shared/src/schemas/order.ts — 下單契約
 *
 * 這個檔案是什麼：
 *   下單流程三個端點的 request / response 形狀：
 *
 *     POST /orders/preview   試算費用（確認頁要顯示的數字）
 *     POST /orders           送出委託
 *     GET  /orders/:id       查詢單一委託
 *
 * 為什麼放在 shared/：
 *   下單是本專案唯一的寫入路徑，也是前後端最容易對不齊的地方。
 *   例如 `quantity` 到底是「張」還是「股」—— 前端算一次、後端算一次，
 *   有一邊搞錯就是實際下單金額差一千倍。
 *   契約只有一份，兩邊 import 同一個型別，這種錯誤會在編譯期就爆。
 *
 * 在架構的哪一層：
 *   契約層。後端用它做執行期驗證，前端用它推導表單型別。
 *
 * ── 單位約定（整份專案最容易出錯的地方）───────────────────────────
 *
 *   quantity        股數，不是張數。台股 1 張 = 1000 股，
 *                   但零股交易的最小單位是 1 股，所以一律用股。
 *   limitPriceCents 每股價格，單位「分」。1085.00 元 → 108500 分。
 *
 *   兩者相乘就是股款（gross），這是唯一正確的算法。
 *
 * 相關文件：docs/02-backend.md → 下單；docs/05-specs/trade.md
 */

import { z } from 'zod';

import { nonNegativeCentsSchema, uuidSchema } from './common.js';
import { instrumentSchema } from './portfolio.js';

// ============================================================================
// 基礎列舉
// ============================================================================

/** 買賣方向。 */
export const orderSideSchema = z.enum(['BUY', 'SELL']);
export type OrderSideValue = z.infer<typeof orderSideSchema>;

/**
 * 委託類型。
 *
 * 目前只支援限價單（LIMIT）。市價單（MARKET）沒做，理由是：
 * 市價單的成交價要由撮合引擎決定，而本專案的「撮合」是模擬的 ——
 * 假裝有一個市價，那個數字就是憑空捏造的，反而降低可信度。
 * 限價單的成交價 = 使用者填的價格，這個模擬是誠實的。
 */
export const orderTypeSchema = z.enum(['LIMIT']);
export type OrderTypeValue = z.infer<typeof orderTypeSchema>;

/**
 * 委託狀態。
 *
 *   PENDING   已受理，尚未成交（本專案的模擬撮合是同步的，
 *             所以這個狀態只在交易進行中短暫存在，不會回傳給前端）
 *   FILLED    全部成交
 *   REJECTED  被拒絕，reject_reason 記錄原因
 */
export const orderStatusSchema = z.enum(['PENDING', 'FILLED', 'REJECTED']);
export type OrderStatusValue = z.infer<typeof orderStatusSchema>;

// ============================================================================
// Request
// ============================================================================

/**
 * 下單請求。`/orders` 與 `/orders/preview` 共用同一個形狀。
 *
 * ── 為什麼 preview 也要收 idempotencyKey ──────────────────────────
 *
 *   它不需要。所以 `idempotencyKey` 定義在下面的 createOrderSchema，
 *   而不是這裡 —— preview 是純計算、沒有副作用，重算幾次都一樣。
 *   把冪等鍵放進 preview 只會讓人誤以為它有副作用。
 */
export const orderDraftSchema = z.object({
  /** 標的代號，例如 '2330'。用 symbol 而不是 UUID，是因為它是使用者看得懂的東西 */
  symbol: z.string().trim().min(1, '請選擇標的'),
  side: orderSideSchema,
  orderType: orderTypeSchema.default('LIMIT'),
  /** 股數（不是張數）。上限 100 萬股是防呆，避免手滑多打幾個零 */
  quantity: z
    .number()
    .int('股數必須是整數')
    .positive('股數必須大於 0')
    .max(1_000_000, '單筆委託上限 1,000,000 股'),
  /** 每股限價，單位分 */
  limitPriceCents: nonNegativeCentsSchema.refine((v) => v > 0, '價格必須大於 0'),
});
export type OrderDraft = z.infer<typeof orderDraftSchema>;

/**
 * 正式下單請求 = 草稿 ＋ 冪等鍵。
 *
 * ── idempotencyKey 為什麼由「前端」產生 ★ ─────────────────────────
 *
 *   直覺會覺得該由後端發：呼叫 `/orders/prepare` 拿一把 key，再帶著它下單。
 *   但那樣要多一次往返，而且中間斷線的話那把 key 就浪費了。
 *
 *   真正的關鍵不是誰產生，而是**什麼時候產生**：
 *
 *     ✅ 進入確認頁時產生一次，存在該頁的狀態裡
 *        → 使用者在確認頁連點送出 10 次，帶的都是同一把 key
 *        → 後端第 1 次受理，第 2–10 次回 DUPLICATE_REQUEST
 *
 *     ❌ 按下送出時才產生
 *        → 連點 10 次產生 10 把不同的 key
 *        → 後端看起來就是 10 筆完全合法的不同委託 → 成交 10 筆
 *
 *   所以冪等鍵的正確性是**前端的責任**，後端只能防重放、防不了亂發。
 *   這也是為什麼 docs/05-specs/trade.md 要專門寫一節講產生時機。
 */
export const createOrderSchema = orderDraftSchema.extend({
  /** UUID v4，前端在進入確認頁時產生 */
  idempotencyKey: uuidSchema,
});
export type CreateOrderRequest = z.infer<typeof createOrderSchema>;

// ============================================================================
// Response
// ============================================================================

/**
 * 費用試算結果。
 *
 * 為什麼一定要後端算（前端明明也能呼叫 shared/market-rules）：
 *   能算，但**不該由前端的計算結果決定實際扣款**。前端算的是「給人看的數字」，
 *   後端算的是「真正要扣的錢」。兩邊都呼叫同一個 calculateTradeCost()，
 *   結果必然一致 —— 但權威來源只有一個，就是後端。
 *
 *   如果前端算完把 netCents 一起送給後端讓它照扣，那就是把金額計算的
 *   信任邊界交給瀏覽器，改個 JS 變數就能一塊錢買台積電。
 */
export const orderPreviewSchema = z.object({
  /** 股款 = 每股價格 × 股數 */
  grossCents: nonNegativeCentsSchema,
  /** 手續費 0.1425%，無條件捨去到元，最低 20 元 */
  feeCents: nonNegativeCentsSchema,
  /** 證交稅 0.3%，**僅賣出時收取**，買進為 0 */
  taxCents: nonNegativeCentsSchema,
  /** 買進 = 股款 + 費用（要付出的錢）；賣出 = 股款 − 費用（實拿的錢） */
  netCents: nonNegativeCentsSchema,
});
export type OrderPreview = z.infer<typeof orderPreviewSchema>;

/** 成交明細。一筆委託可以有多筆成交，本專案的模擬撮合固定產生一筆。 */
export const executionSchema = z.object({
  id: uuidSchema,
  filledQuantity: z.number().int().positive(),
  filledPriceCents: nonNegativeCentsSchema,
  feeCents: nonNegativeCentsSchema,
  taxCents: nonNegativeCentsSchema,
  executedAt: z.string(),
});
export type Execution = z.infer<typeof executionSchema>;

/** 委託。 */
export const orderSchema = z.object({
  id: uuidSchema,
  instrument: instrumentSchema,
  side: orderSideSchema,
  orderType: orderTypeSchema,
  quantity: z.number().int().positive(),
  limitPriceCents: nonNegativeCentsSchema,
  status: orderStatusSchema,
  /** 僅 status 為 REJECTED 時有值，內容是 ErrorCode */
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
});
export type Order = z.infer<typeof orderSchema>;

/**
 * 下單成功的回應。
 *
 * 為什麼要一併回傳 account：
 *   下單成功後餘額一定變了。如果只回 order，前端得再打一次 /accounts/me
 *   才能更新畫面上的可用餘額 —— 多一次往返，而且中間有短暫的數字不一致。
 *   後端在同一個交易裡已經拿到扣款後的餘額，順手回傳是零成本的。
 */
export const orderResultSchema = z.object({
  order: orderSchema,
  execution: executionSchema,
  /** 成交後的帳戶餘額 */
  cashBalanceCents: nonNegativeCentsSchema,
});
export type OrderResult = z.infer<typeof orderResultSchema>;
