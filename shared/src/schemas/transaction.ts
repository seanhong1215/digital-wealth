/**
 * shared/src/schemas/transaction.ts — 交易明細的契約
 *
 * 這個檔案是什麼：
 *   帳務流水帳的 schema，以及明細頁的查詢參數（含 cursor 分頁）。
 *
 * 對應端點：
 *   GET /api/v1/transactions
 *
 * 為什麼明細頁是本專案的技術重點之一：
 *   資料量 3,000 筆（active）／8,000 筆（heavy-history），
 *   要在手機上流暢捲動，牽涉到 cursor 分頁（後端）與虛擬滾動（前端）。
 *   這兩件事一起做對，是很具體的效能能力展示。
 *
 * 在架構的哪一層：契約層。
 */

import { z } from 'zod';

import {
  centsSchema,
  cursorSchema,
  isoDateTimeSchema,
  limitSchema,
  nonNegativeCentsSchema,
  pagedResponseSchema,
  quantitySchema,
  uuidSchema,
} from './common.js';
import { instrumentSchema } from './portfolio.js';

// ============================================================================
// 異動類型
// ============================================================================

/**
 * 帳務異動類型。
 *
 * 所有會影響現金餘額的事件都在這張表裡，用 type 區分：
 *
 *   BUY / SELL    買賣股款
 *   FEE / TAX     手續費與證交稅（與買賣分開記，因為它們是獨立的費用項目）
 *   DIVIDEND      現金股利
 *   DEPOSIT / WITHDRAWAL   銀行轉入轉出
 *
 * ── 為什麼手續費要獨立成一列，而不是併進買賣那一列 ────────────────
 *
 * 因為使用者會想問「我這個月付了多少手續費」。
 * 獨立成列之後，那個問題就是一句 `WHERE type = 'FEE'`；
 * 併在一起的話得去解析每一筆買賣的結構。
 *
 * 這也讓一次買進產生 2 列（BUY + FEE）、一次賣出產生 3 列
 * （SELL + FEE + TAX），是明細筆數比交易筆數多的原因。
 */
export const transactionTypeSchema = z.enum([
  'BUY',
  'SELL',
  'FEE',
  'TAX',
  'DIVIDEND',
  'DEPOSIT',
  'WITHDRAWAL',
]);

export type TransactionType = z.infer<typeof transactionTypeSchema>;

// ============================================================================
// 單筆明細
// ============================================================================

/**
 * 單筆帳務異動。
 *
 * ── 為什麼有些欄位是 nullable ─────────────────────────────────────
 *
 * `instrument` / `quantity` / `priceCents` 在**非交易類**異動
 * （入出金、費用）時為 null。
 *
 * **用 null 而不是 0 是有意義的**：
 *   0    代表「數量是零」
 *   null 代表「這個概念不適用」
 *
 * 前端顯示時兩者處理方式不同 —— 0 要顯示「0」，
 * null 要顯示「—」或整個欄位不出現。
 * 混用會讓「銀行轉入 0 股」這種荒謬的文字出現在畫面上。
 */
export const transactionSchema = z.object({
  id: uuidSchema,
  type: transactionTypeSchema,
  /** 標的。入出金與非個股相關的費用為 null */
  instrument: instrumentSchema.nullable(),
  /** 股數。非交易類為 null */
  quantity: quantitySchema.nullable(),
  /** 單價（分／股）。非交易類為 null */
  priceCents: nonNegativeCentsSchema.nullable(),
  /**
   * 對餘額的影響（分）。**正為入帳，負為出帳。**
   *
   * 用單一帶號欄位而非「借方／貸方」兩欄，是因為本專案只有一個
   * 現金帳戶，不需要複式簿記。
   *
   * 前端顯示時通常取絕對值，正負號交給 UI 的顏色與符號表達
   * （見 shared/money.ts 的 abs()）。
   */
  amountCents: centsSchema,
  /**
   * 異動後餘額（分）。真實帳務系統的標準欄位。
   *
   * 它讓每一筆異動都能**獨立驗證**：
   *   `前一筆的 balanceAfter + 這筆的 amount == 這筆的 balanceAfter`
   *
   * 對帳時不用把整個歷史重算一遍。這個欄位是「資料要怎麼被稽核」
   * 的思考產物，而不只是「資料要怎麼被顯示」。
   */
  balanceAfterCents: nonNegativeCentsSchema,
  /** 顯示文字，例如「買進 台積電 1,000 股」 */
  description: z.string(),
  /**
   * 發生時間，ISO 8601。
   *
   * **不是 createdAt** —— seed 產生的歷史資料，發生時間是過去、
   * 建立時間是現在，兩者必須分開。明細頁排序與篩選都用這個欄位。
   */
  occurredAt: isoDateTimeSchema,
});

export type Transaction = z.infer<typeof transactionSchema>;

// ============================================================================
// 查詢參數
// ============================================================================

/**
 * 明細查詢參數。
 *
 * 對應 `GET /transactions?cursor=...&limit=30&type=BUY,SELL&from=...&to=...`
 */
export const transactionQuerySchema = z.object({
  /**
   * 分頁游標。第一頁不傳，之後把上一頁的 `nextCursor` 原封不動傳回來。
   *
   * 它是**不透明字串** —— 前端不該解析、也不該自己組。
   * 內容其實是 base64 編碼的「時間 + id」，但那是後端的實作細節，
   * 未來改變排序欄位時前端完全不用改。
   */
  cursor: cursorSchema.optional(),

  limit: limitSchema,

  /**
   * 類型篩選，可多選。
   *
   * query string 傳的是逗號分隔的字串（`?type=BUY,SELL`），
   * 這裡用 `.transform()` 拆成陣列再逐一驗證。
   *
   * 為什麼不用 `?type=BUY&type=SELL` 的重複參數形式：
   *   那種形式在只有一個值時會被解析成字串、多個值時是陣列，
   *   型別不穩定，前後端都要多寫判斷。逗號分隔永遠是字串，單純得多。
   */
  type: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return undefined;

      const parts = value.split(',').map((part) => part.trim());
      const result = z.array(transactionTypeSchema).safeParse(parts);

      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `type 參數含有不認識的類型。可用值：${transactionTypeSchema.options.join('、')}`,
        });
        return z.NEVER;
      }
      return result.data;
    }),

  /**
   * 起始時間（含），ISO 8601。
   *
   * 與 `to` 一起構成日期區間篩選。兩者都是選填 ——
   * 只給 from 代表「從這天以後全部」，只給 to 代表「這天以前全部」。
   */
  from: isoDateTimeSchema.optional(),
  /** 結束時間（含），ISO 8601 */
  to: isoDateTimeSchema.optional(),
});

export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

/**
 * 明細查詢的回應：一頁資料 ＋ 下一頁的游標。
 *
 * `nextCursor` 為 `null` 代表**沒有下一頁了**，
 * 前端據此停止無限捲動。
 */
export const transactionPageSchema = pagedResponseSchema(transactionSchema);

export type TransactionPage = z.infer<typeof transactionPageSchema>;
