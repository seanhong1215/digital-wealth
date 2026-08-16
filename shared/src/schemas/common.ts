/**
 * shared/src/schemas/common.ts — 共用的 zod 基礎 schema
 *
 * 這個檔案是什麼：
 *   各種 API schema 都會用到的基本欄位定義：金額、UUID、時間、分頁。
 *
 * ── 為什麼要用 zod，而不是只寫 TypeScript 型別 ────────────────────
 *
 *   TypeScript 的型別**只存在於編譯期**，編譯完就消失了。
 *   也就是說，後端收到一包 JSON 時，TypeScript 完全幫不上忙 ——
 *   它不會檢查那包 JSON 到底長什麼樣：
 *
 *     const body = req.body as LoginRequest;   // ← 這只是「我說它是」
 *     body.email.toLowerCase();                //   實際上可能是 undefined
 *
 *   zod 是**執行期**的驗證器。它在執行時真的去檢查資料，
 *   不符合就拋錯：
 *
 *     const body = loginRequestSchema.parse(req.body);  // ← 真的驗過了
 *
 *   而且 zod 可以用 `z.infer` **反推出 TypeScript 型別**，
 *   所以你只需要寫一份定義，同時得到編譯期型別與執行期驗證。
 *
 * ── 為什麼放在 shared/ ────────────────────────────────────────────
 *
 *   這是本專案最重要的架構訊號（ADR 0002）：
 *
 *     後端  用 schema 驗證進來的請求、確保回傳的形狀正確
 *     前端  用 z.infer 推導型別、用 schema 驗證收到的回應
 *
 *   **改一個欄位，兩邊會同時編譯失敗。** 這正是我們要的 ——
 *   契約不同步的問題會在寫程式時就爆炸，而不是上線後才發現。
 *
 * 在架構的哪一層：
 *   契約層，依賴 money.ts。
 */

import { z } from 'zod';

import { MAX_SAFE_CENTS, type Cents } from '../money.js';

// ============================================================================
// 基本欄位
// ============================================================================

/**
 * 金額（分）。
 *
 * 驗證條件與 `money.ts` 的 `cents()` 一致：必須是整數、在安全範圍內。
 *
 * `.transform()` 那一行把驗證過的 number 標記成 `Cents` branded type，
 * 所以 parse 出來的值可以直接餵給 `add()`、`multiply()` 這些函式，
 * 不用再手動呼叫一次 `cents()`。
 *
 * **這是 branded type 與 zod 結合的關鍵**：驗證與型別標記一次完成，
 * 資料一進到系統邊界就帶著正確的型別往下走。
 */
export const centsSchema = z
  .number()
  .int('金額必須是整數分（1 元 = 100 分）')
  .min(-MAX_SAFE_CENTS, '金額超出安全範圍')
  .max(MAX_SAFE_CENTS, '金額超出安全範圍')
  .transform((value) => value as Cents);

/**
 * 非負金額（分）。用於餘額、市值這類不可能為負的欄位。
 */
export const nonNegativeCentsSchema = z
  .number()
  .int('金額必須是整數分')
  .min(0, '金額不可為負')
  .max(MAX_SAFE_CENTS, '金額超出安全範圍')
  .transform((value) => value as Cents);

/** 資料庫主鍵。PostgreSQL 的 `gen_random_uuid()` 產生的是 UUID v4。 */
export const uuidSchema = z.string().uuid('必須是合法的 UUID');

/**
 * 股數。
 *
 * 用整數而非小數 —— 台股零股的最小單位是 1 股，不存在 0.5 股
 * （見 ADR 0005）。若未來支援美股碎股，這裡要改。
 */
export const quantitySchema = z.number().int('股數必須是整數').nonnegative('股數不可為負');

/**
 * 時間戳記，ISO 8601 字串。
 *
 * 為什麼 API 回傳字串而不是 Date 物件：
 *   JSON 沒有日期型別。`JSON.stringify(new Date())` 出去是字串，
 *   前端 `JSON.parse` 回來也是字串 —— 中間那個 Date 型別是假的。
 *   所以契約直接定義成字串，由前端決定要不要轉成 Date。
 *
 * 為什麼是 ISO 8601 而不是 Unix timestamp：
 *   ISO 8601 帶時區資訊（結尾的 Z 或 +08:00），
 *   而 Unix timestamp 沒有 —— 跨時區時會出事。
 *   而且 ISO 字串人眼看得懂，除錯時差很多。
 */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** 日期（無時間部分），格式 `YYYY-MM-DD`。對應資料庫的 `DATE` 欄位。 */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必須是 YYYY-MM-DD');

// ============================================================================
// Cursor 分頁
// ============================================================================

/**
 * 分頁游標（cursor）。
 *
 * ── 什麼是 cursor 分頁，為什麼不用 OFFSET ─────────────────────────
 *
 * OFFSET 分頁（`LIMIT 30 OFFSET 2970`）有兩個問題：
 *
 *   1. **越翻越慢** —— 資料庫要先掃描並丟棄前 2970 筆才開始取資料
 *   2. **會重複或遺漏** —— 翻頁期間若有新資料插入，整個結果往後位移。
 *      使用者會看到同一筆出現兩次，或某筆整個消失。
 *      無限捲動的場景這問題特別明顯。
 *
 * cursor 分頁改成「從上次的最後一筆位置往下取」，
 * 成本恆定，且不受插入影響。
 *
 * ── 為什麼是不透明字串（opaque token）────────────────────────────
 *
 * 這個欄位的實際內容是 `base64("occurredAt,id")`，但**前端不該知道
 * 這件事，更不該自己組**。它只要把上一頁回傳的 `nextCursor` 原封不動
 * 傳回來就好。
 *
 * 好處：未來改變排序欄位（例如改成用 id 排序）時，前端完全不用改。
 * 如果直接暴露 `occurredAt` 與 `id` 兩個參數，前端就會依賴內部實作。
 */
export const cursorSchema = z.string().min(1);

/**
 * 每頁筆數。
 *
 * 上限 100 是刻意的防護 —— 沒有上限的話，有人傳 `limit=999999`
 * 就能讓資料庫一次撈出全部資料，等於一個免費的 DoS 開關。
 *
 * `.coerce` 是因為 query string 的值永遠是字串（`?limit=30` 拿到的是
 * `"30"`），需要先轉成數字再驗證。
 */
export const limitSchema = z.coerce
  .number()
  .int()
  .min(1, '每頁至少 1 筆')
  .max(100, '每頁最多 100 筆')
  .default(30);

/**
 * cursor 分頁的回應形狀。
 *
 * 這是一個**泛型 schema 工廠** —— 傳入單筆項目的 schema，
 * 回傳整個分頁回應的 schema。這樣 transactions、orders 等
 * 不同資源都能共用同一個分頁形狀。
 *
 * @param itemSchema 單筆項目的 schema
 *
 * @example
 *   const pagedTransactions = pagedResponseSchema(transactionSchema);
 *   type PagedTransactions = z.infer<typeof pagedTransactions>;
 */
export function pagedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    /**
     * 下一頁的游標。
     *
     * **`null` 代表沒有下一頁了** —— 前端據此停止無限捲動。
     * 用 null 而不是省略欄位，是為了讓「還有更多」與「到底了」
     * 兩種狀態都有明確的表示，前端不用寫 `'nextCursor' in response`。
     */
    nextCursor: z.string().nullable(),
  });
}
