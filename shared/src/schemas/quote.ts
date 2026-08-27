/**
 * shared/src/schemas/quote.ts — 即時報價的 WebSocket 協定
 *
 * 這個檔案是什麼：
 *   WebSocket 上來回傳遞的所有訊息形狀，以及 Redis pub/sub 的頻道名稱。
 *
 * 為什麼放在 shared/：
 *   這個協定有**三個**使用者，比 REST API 還多一個：
 *
 *     market-feed  產生 tick → publish 到 Redis
 *     api          subscribe Redis → 推給有訂閱的 WebSocket 連線
 *     web          接收並更新畫面
 *
 *   三個獨立的程序講同一套協定。少了共用契約，改一個欄位名要同時
 *   記得改三個地方，而且改錯不會編譯失敗 —— 只會在執行時安靜地
 *   收到 undefined。
 *
 * 在架構的哪一層：契約層。
 *
 * 相關文件：docs/02-backend.md → WebSocket 協定
 */

import { z } from 'zod';

import { nonNegativeCentsSchema } from './common.js';

// ============================================================================
// Redis 頻道
// ============================================================================

/**
 * market-feed 發布報價的 Redis 頻道。
 *
 * ── 為什麼是「單一頻道 + 應用層扇出」而不是每檔一個頻道 ★ ────────
 *
 *   直覺做法是每檔標的一個頻道（`quotes:2330`），API 只訂閱使用者
 *   實際需要的那幾檔。但那需要**動態 subscribe / unsubscribe** ——
 *   使用者切換頁面時，API 要即時增減 Redis 訂閱，而且要處理
 *   「還有沒有別的連線也在看這檔」的引用計數。
 *
 *   單一頻道的做法：API 固定訂閱 `quotes` 一個頻道，收到之後在
 *   記憶體裡查 `Map<symbol, Set<client>>` 決定推給誰。
 *
 *   代價是 API 會收到所有標的的 tick（包含沒人在看的）。以本專案
 *   500 檔標的、每秒數十筆的量級，這個成本可以忽略；換來的是
 *   訂閱管理完全不碰 Redis，邏輯簡單很多。
 *
 *   量級再大就要換回多頻道（或 Redis Streams）—— 但那是為
 *   真實流量做的優化，不是現在該付的複雜度。
 */
export const QUOTE_CHANNEL = 'quotes';

/**
 * WebSocket 端點路徑。
 *
 * ── 為什麼在 `/api` 底下，而不是 docs 原本寫的 `/ws/quotes` ★ ─────
 *
 *   這是實作時撞到、規格上看不出來的衝突：
 *
 *   存放 JWT 的 cookie 設了 `path: '/api'`（見 auth.controller.ts）——
 *   那是刻意的收斂：cookie 只送給真正需要它的路徑，靜態資源、
 *   前端路由都不會夾帶身分憑證。
 *
 *   但 cookie 的 path 限制是**瀏覽器端**執行的。WebSocket 在
 *   `/ws/quotes` 的話，瀏覽器判定「這不在 /api 底下」，
 *   於是握手請求**完全不帶 cookie** —— 後端只會看到一個匿名連線，
 *   回 AUTH_REQUIRED。
 *
 *   而且這個失敗很難查：後端日誌看起來一切正常（它確實沒收到 cookie），
 *   用 wscat 直連（手動帶 Cookie 標頭）也完全正常，
 *   只有瀏覽器連不上。
 *
 *   兩個解法：
 *     A. 把 cookie 的 path 放寬成 '/'  → 每個請求都夾帶憑證，退步
 *     B. ✅ 把 WebSocket 移進 /api 底下 → cookie 的收斂維持不變
 *
 *   選 B。docs/02-backend.md 的路徑已同步更新。
 */
export const QUOTES_WS_PATH = '/api/ws/quotes';

// ============================================================================
// 報價本體
// ============================================================================

/** 單一標的的最新報價快照。 */
export const quoteSchema = z.object({
  symbol: z.string(),
  /** 最新成交價（分） */
  priceCents: nonNegativeCentsSchema,
  /** 昨收價（分）。放在報價裡是為了讓前端不必另外查就能算漲跌 */
  prevCloseCents: nonNegativeCentsSchema,
  /** 累計成交量（股） */
  volume: z.number().int().nonnegative(),
  /** 這筆報價的時間（ISO 8601） */
  at: z.string(),
});
export type Quote = z.infer<typeof quoteSchema>;

// ============================================================================
// Client → Server
// ============================================================================

/**
 * 訂閱／取消訂閱。
 *
 * 前端只訂閱**畫面上看得到的標的**：總覽頁訂閱持倉清單，
 * 下單頁訂閱當前這一檔。不做全域訂閱 —— 持有 8 檔的使用者
 * 不該收到 500 檔的報價。
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), symbols: z.array(z.string()).max(100) }),
  z.object({ type: z.literal('unsubscribe'), symbols: z.array(z.string()).max(100) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ============================================================================
// Server → Client
// ============================================================================

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('quote'), data: quoteSchema }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ============================================================================
// 心跳與重連參數
// ============================================================================

/**
 * 這組數字前後端都要用，所以放 shared。
 *
 * ── 為什麼逾時是心跳的兩倍以上 ★ ────────────────────────────────
 *
 *   心跳 20 秒、逾時 45 秒，容許**兩次**心跳遺失才判定斷線。
 *   如果逾時設成 25 秒，一次網路抖動就會誤判斷線 → 重連 →
 *   重新訂閱，使用者會看到畫面閃一下。
 *
 *   反過來設太長（例如 5 分鐘），真的斷線時使用者會盯著
 *   五分鐘前的價格以為那是現在的價格 —— 在金融介面裡，
 *   **顯示過期資料比顯示錯誤更危險**。
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** 超過這個時間沒收到任何訊息就視為斷線。 */
export const CONNECTION_TIMEOUT_MS = 45_000;

/**
 * 單一標的超過這個時間沒有新報價 → 標記為 stale（數字轉灰）。
 *
 * 這跟連線是否還活著無關 —— 連線好好的，但這檔股票就是
 * 五秒沒有人成交。誠實顯示「這個數字有點舊了」，
 * 比讓使用者以為那是即時價格好。
 */
export const QUOTE_STALE_AFTER_MS = 5_000;

/** 重連退避序列（毫秒）。超過陣列長度就固定用最後一個值。 */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * 退避時額外加上 0–1000ms 的隨機抖動。
 *
 * ── 為什麼需要 jitter ★ ─────────────────────────────────────────
 *
 *   後端重啟時，所有客戶端會在**完全相同的時間點**斷線，
 *   於是也在完全相同的時間點重連 —— 後端剛起來就被打爆，
 *   可能再次倒下，形成重連風暴（thundering herd）。
 *
 *   加上隨機抖動可以把重連請求打散在一秒的區間內。
 *   這是分散式系統的基本功，一行程式碼的成本。
 */
export const RECONNECT_JITTER_MS = 1_000;
