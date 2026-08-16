/**
 * api/src/modules/transactions/cursor.ts — 分頁游標的編解碼
 *
 * 這個檔案是什麼：
 *   把「上一頁最後一筆的位置」編碼成一個不透明字串，以及反向解碼。
 *
 * ── 為什麼需要游標（先講 OFFSET 分頁錯在哪）──────────────────────
 *
 * 一般人會這樣寫分頁：
 *
 *     SELECT * FROM transactions WHERE account_id = $1
 *     ORDER BY occurred_at DESC LIMIT 30 OFFSET 2970;
 *
 * 兩個問題：
 *
 *   1. **越翻越慢。** 資料庫沒辦法「跳到第 2971 筆」——
 *      它必須真的掃過前面 2970 筆再一一丟棄。
 *      第 1 頁很快，第 100 頁慢得有感。
 *
 *   2. **會重複或遺漏。** 假設你正在看第 1 頁，這時有人新增了一筆
 *      交易（它會排在最前面），整個列表往後位移一格：
 *
 *          翻頁前         翻頁後（多了一筆新的）
 *          [0] A          [0] 新
 *          [1] B          [1] A
 *          ...            [2] B    ← B 從索引 1 變成 2
 *          [29] Z         [30] Z   ← Z 被推到第 2 頁
 *
 *      你翻到第 2 頁（OFFSET 30）時，會**再看到一次 Z**。
 *      無限捲動的場景這問題特別明顯 —— 使用者會看到重複項目。
 *
 * ── cursor 分頁怎麼解決 ───────────────────────────────────────────
 *
 * 不說「跳過前 N 筆」，改說「從這個位置之後開始取」：
 *
 *     WHERE (occurred_at, id) < ($2, $3)
 *
 * 因為位置是用**資料本身的值**定位的，所以：
 *   - 成本恆定（沿著索引直接定位，不用掃描丟棄）
 *   - 不受插入影響（新資料排在前面，不會改變「B 之後是什麼」）
 *
 * ── 為什麼游標要包含 id ★ ─────────────────────────────────────────
 *
 * 因為 `occurred_at` **可能重複** —— 同一秒可以有多筆交易
 * （seed 產生的資料尤其如此，一次買進會產生 BUY + FEE 兩列）。
 *
 * 只用 occurred_at 當游標的話，時間相同的那幾筆排序不穩定，
 * 翻頁時會跳過或重複。`id` 在這裡是 **tie-breaker（決勝欄位）**，
 * 保證排序絕對唯一。
 *
 * ── `(a, b) < (c, d)` 是什麼語法 ──────────────────────────────────
 *
 * 這是 SQL 的**列比較（row comparison）**，語意是字典序：
 *
 *     先比 a 與 c；a < c 就成立、a > c 就不成立；
 *     a = c 時才去比 b 與 d
 *
 * 等價於 `a < c OR (a = c AND b < d)`，但列比較的寫法讓
 * PostgreSQL 能直接沿著複合索引 `(account_id, occurred_at DESC, id DESC)`
 * 掃描，不需要額外排序。**這是這個索引存在的全部意義。**
 *
 * 在架構的哪一層：業務邏輯層的工具函式。純函式，可直接測試。
 */

import { AppError } from '../../common/errors/app.error.js';

/** 游標所指向的位置：某一筆交易的排序鍵。 */
export interface CursorPosition {
  /** 該筆交易的發生時間，ISO 8601 字串 */
  readonly occurredAt: string;
  /** 該筆交易的 id，作為時間相同時的決勝欄位 */
  readonly id: string;
}

/**
 * 分隔符號。
 *
 * 用 `|` 而不是逗號，是因為 ISO 8601 時間字串裡不會出現 `|`，
 * 但未來如果有欄位含逗號就會解析錯誤。挑一個不可能衝突的字元比較安全。
 */
const SEPARATOR = '|';

/**
 * 把位置編碼成不透明的游標字串。
 *
 * ── 為什麼要 base64，而不是直接傳「時間,id」──────────────────────
 *
 * **不是為了安全**（base64 是編碼不是加密，任何人都解得開）,
 * 而是為了讓它看起來「不像可以自己組的東西」：
 *
 *     eyJvY2N1cnJlZEF0Ijo...      ← 一看就知道是給機器用的
 *     2026-08-16T04:00:00Z,abc    ← 前端工程師會忍不住自己拼一個
 *
 * 這叫**不透明權杖（opaque token）**。它的價值在於：
 * 未來要改變排序欄位（例如改成用 id 單獨排序），
 * 只要改這個檔案，前端完全不用動 —— 因為前端從來不知道裡面是什麼。
 *
 * 如果直接暴露 `occurredAt` 與 `id` 兩個 query 參數，
 * 前端就會依賴內部實作，改動時兩邊都要改。
 *
 * @param position 要編碼的位置
 * @returns base64url 編碼的游標字串
 */
export function encodeCursor(position: CursorPosition): string {
  const raw = `${position.occurredAt}${SEPARATOR}${position.id}`;

  // 用 base64url 而不是標準 base64：
  //   標準 base64 會產生 `+` `/` `=` 三個字元，它們在 URL 裡有特殊意義，
  //   得額外做 URL encode。base64url 用 `-` `_` 取代且不補 `=`，
  //   可以直接放進 query string。
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * 把游標字串解碼回位置。
 *
 * ── 為什麼要這麼小心地驗證 ────────────────────────────────────────
 *
 * 游標是**使用者可控的輸入** —— 任何人都能在網址列亂改。
 * 所以這裡要當成不可信資料處理：
 *
 *   - 不是合法 base64 → 擋
 *   - 解開後格式不對 → 擋
 *   - 時間不是合法日期 → 擋
 *
 * 少了這些檢查，一個亂打的游標會變成 SQL 參數丟給資料庫，
 * 輕則查詢報錯回 500，重則行為不可預期。
 *
 * ⚠️ 這裡**不驗證 id 是不是真的存在**。那需要多一次查詢，
 *    而且沒有意義 —— 指向一筆已被刪除的資料，查出來就是空的下一頁，
 *    對使用者來說跟「到底了」的結果一樣。
 *
 * @param cursor 前端傳來的游標字串
 * @returns 解碼後的位置
 * @throws {AppError} 游標格式不合法時（VALIDATION_FAILED）
 */
export function decodeCursor(cursor: string): CursorPosition {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new AppError('VALIDATION_FAILED', '分頁游標格式不正確');
  }

  const separatorIndex = raw.indexOf(SEPARATOR);
  if (separatorIndex === -1) {
    throw new AppError('VALIDATION_FAILED', '分頁游標格式不正確');
  }

  const occurredAt = raw.slice(0, separatorIndex);
  const id = raw.slice(separatorIndex + 1);

  if (occurredAt === '' || id === '') {
    throw new AppError('VALIDATION_FAILED', '分頁游標格式不正確');
  }

  // 確認時間部分真的是合法日期。
  // Number.isNaN(Date.parse(x)) 是判斷「這個字串能不能被解析成日期」
  // 的標準寫法 —— 解析失敗時 Date.parse 回傳 NaN。
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new AppError('VALIDATION_FAILED', '分頁游標格式不正確');
  }

  return { occurredAt, id };
}
