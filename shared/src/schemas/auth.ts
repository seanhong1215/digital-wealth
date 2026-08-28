/**
 * shared/src/schemas/auth.ts — 認證相關的契約
 *
 * 這個檔案是什麼：
 *   登入請求、使用者資料、帳戶資料的 schema。
 *
 * 對應端點：
 *   POST /api/v1/auth/login
 *   POST /api/v1/auth/logout
 *   GET  /api/v1/auth/me
 *   GET  /api/v1/accounts/me
 *
 * 在架構的哪一層：契約層。
 */

import { z } from 'zod';

import { nonNegativeCentsSchema, uuidSchema } from './common.js';

// ============================================================================
// 登入
// ============================================================================

/**
 * 登入請求。
 *
 * 為什麼密碼只驗長度不驗複雜度：
 *   複雜度規則（要有大小寫、數字、符號）屬於**註冊**時的檢查。
 *   登入時該做的只有「有沒有填」—— 如果登入也擋複雜度，
 *   那些在規則上線前註冊的舊使用者就登不進來了。
 *
 *   本專案沒有註冊流程（單一 demo 帳號），但這個區分值得知道。
 */
export const loginRequestSchema = z.object({
  email: z.string().email('請輸入合法的電子郵件'),
  password: z.string().min(1, '請輸入密碼'),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ============================================================================
// 使用者
// ============================================================================

/**
 * 使用者資料。
 *
 * ⚠️ **這個 schema 刻意不包含 `passwordHash`。**
 *
 * 資料庫的 users 表有那個欄位，但它**絕不可以出現在任何 API 回應裡**。
 * 把 schema 定義成「只有這幾個欄位」，等於在契約層就把它擋掉了 ——
 * 就算 Service 不小心把整個 row 傳出來，序列化時也只會剩下這三個欄位。
 *
 * 這是「用型別做安全防護」的實例：不是靠人記得要刪，是靠結構讓它不可能發生。
 */
export const userSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  displayName: z.string(),
});

export type User = z.infer<typeof userSchema>;

// ============================================================================
// 帳戶
// ============================================================================

/**
 * 帳戶資料。
 *
 * 對應 `GET /accounts/me`。
 *
 * ── 為什麼端點是 /accounts/me 而不是 /accounts/:id ────────────────
 *
 * 如果寫成 `/accounts/:id`，攻擊者只要把網址裡的 id 換成別人的，
 * 就能看到別人的帳戶 —— 這叫 **IDOR（不安全的直接物件參考）**，
 * 是最常見也最容易犯的授權漏洞。
 *
 * 正確做法：**帳戶身分只能來自 JWT，前端根本不需要傳。**
 * 後端從 token 取出 userId，再查出他的 accountId。
 *
 * 「絕不信任前端傳來的 accountId」這條原則，在本專案所有查詢都適用。
 */
export const accountSchema = z.object({
  id: uuidSchema,
  /** 顯示用帳號，格式 `1234-5678`。與主鍵分開，兩者用途不同 */
  accountNo: z.string(),
  /** 可用現金（分）。**後端不回傳格式化字串**，千分位是前端的事 */
  cashBalanceCents: nonNegativeCentsSchema,
  /** 幣別代碼。本專案只有 TWD */
  currency: z.string().length(3),
});

export type Account = z.infer<typeof accountSchema>;

// ============================================================================
// 登入／取得當前身分的回應
// ============================================================================

/**
 * `POST /auth/login` 與 `GET /auth/me` 的回應。
 *
 * ⚠️ **回應裡沒有 token。**
 *
 * JWT 是透過 `Set-Cookie` 標頭下發的 httpOnly cookie，
 * JavaScript 讀不到，所以也不會出現在回應主體裡。
 *
 * 為什麼不用 localStorage 存 token（新手最常見的做法）：
 *   只要頁面上有任何 XSS 漏洞，攻擊者一行
 *   `localStorage.getItem('token')` 就把身分偷走了。
 *   httpOnly cookie 從瀏覽器層級阻止 JS 讀取。
 *
 * 代價是要處理 CSRF —— 用 `SameSite=Lax` 擋掉大部分情況。
 * 詳見 docs/02-backend.md 的認證設計。
 *
 * 登入與「取得當前身分」回傳同一個形狀，是刻意的：
 * 前端重整頁面後呼叫 /auth/me，拿到的資料結構跟剛登入時一樣，
 * 可以共用同一段狀態更新邏輯。
 */
export const authSessionSchema = z.object({
  user: userSchema,
  account: accountSchema,
});

export type AuthSession = z.infer<typeof authSessionSchema>;

// ============================================================================
// JWT payload
// ============================================================================

/**
 * JWT 內容（payload）。
 *
 * ── JWT 裡該放什麼、不該放什麼 ────────────────────────────────────
 *
 * ⚠️ **JWT 的 payload 沒有加密，只有簽章。**
 *    任何人都可以把 token 貼到 jwt.io 看到裡面所有內容。
 *    簽章保證的是「內容沒被竄改」，不是「內容看不到」。
 *
 * 所以：
 *   ✅ 可以放：使用者 id、帳戶 id、角色 —— 這些洩漏了也沒關係
 *   ❌ 不可放：密碼、email、身分證字號、任何個資
 *
 * 這裡放 accountId 是為了**省一次資料庫查詢** —— 每個查詢 API 都需要
 * 知道要查哪個帳戶，放進 token 就不用每次都 `SELECT id FROM accounts
 * WHERE user_id = $1`。
 *
 * 代價：如果帳戶結構改變（例如一個使用者有多個帳戶），
 * 舊 token 裡的 accountId 會過時。本專案是單一帳戶，不會遇到。
 *
 * `sub`、`iat`、`exp` 是 JWT 規格定義的標準欄位：
 *   sub  subject，習慣上放使用者識別碼
 *   iat  issued at，簽發時間（由 jwt 函式庫自動填）
 *   exp  expiration，到期時間（由 jwt 函式庫自動填）
 */
export const jwtPayloadSchema = z.object({
  /** 使用者 id（JWT 標準欄位 `sub`） */
  sub: uuidSchema,
  /** 帳戶 id。放進 token 以省下每次請求的一次查詢 */
  accountId: uuidSchema,
  /** 簽發時間，Unix 秒。由 jwt 函式庫自動填入 */
  iat: z.number().optional(),
  /** 到期時間，Unix 秒。由 jwt 函式庫自動填入 */
  exp: z.number().optional(),
});

export type JwtPayload = z.infer<typeof jwtPayloadSchema>;

/**
 * 通過認證的請求所攜帶的身分資訊。
 *
 * Guard 驗證 token 之後把它掛到 request 上，Controller 用
 * `@CurrentUser()` 裝飾器取出來。它是 JwtPayload 的精簡版 ——
 * 只留下業務邏輯真正會用到的兩個 id。
 */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly accountId: string;
}

// ============================================================================
// Cookie 設定
// ============================================================================

/** 存放 JWT 的 cookie 名稱。前後端都引用這個常數，避免打錯字。 */
export const AUTH_COOKIE_NAME = 'access_token';

/**
 * JWT 有效期（秒）。24 小時。
 *
 * 為什麼不做 refresh token：
 *   MVP 只有一個 demo 帳號、單一裝置。refresh token 機制
 *   （輪替、撤銷清單、竊取偵測）的複雜度遠超過它在本專案的價值。
 *
 *   **README 要寫明這是刻意的取捨**，而不是不知道有這東西 ——
 *   這個區別值得想清楚。
 */
export const AUTH_TOKEN_TTL_SECONDS = 24 * 60 * 60;
