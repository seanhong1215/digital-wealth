/**
 * shared/src/schemas/demo.ts — Demo 控制台的契約
 *
 * 這個檔案是什麼：
 *   帳戶情境、故障種類，以及控制台四個端點的形狀。
 *
 * ── Demo 控制台在解決什麼問題 ★ ──────────────────────────────────
 *
 *   happy path 三秒就滑過去了。真正會讓人停下來
 *   提問的是 **error handling** —— 餘額不足長什麼樣、下單逾時
 *   使用者怎麼知道成立了沒、報價斷了畫面會不會整片空白。
 *
 *   但這些狀態平常看不到。沒有控制台的話，你得在旁邊解說
 *   「如果這時候後端掛掉，會顯示…」—— 說跟看到是兩回事。
 *
 *   控制台讓使用者**自己**把這些狀態點出來。這比一個能新增文章的
 *   後台有用得多，而且成本只有一個 Module ＋ 一個浮動面板。
 *
 * ── 為什麼故障注入放在後端 ★ ─────────────────────────────────────
 *
 *   原本的設計是前端用 MSW 攔截請求後改回應。改成真後端之後，
 *   故障注入移到後端 middleware，理由不只是「因為有後端了」：
 *
 *     · **更真實** —— 故障發生在網路層之外，前端對來源完全無感知。
 *       前端的錯誤處理程式碼不知道自己正在被測試，
 *       所以測到的是真正會上線的那份邏輯
 *     · **這是分層正確性的證明** —— 如果前端有任何一處在
 *       「知道自己在 demo 模式」的前提下改變行為，那一層就髒了
 *
 * 在架構的哪一層：契約層。
 *
 * 相關文件：README 第 9 節
 */

import { z } from 'zod';

// ============================================================================
// 帳戶情境
// ============================================================================

/**
 * 帳戶情境 —— 決定 seed 資料的形狀。
 *
 * 每一個都對應一種**用其他方式很難看到**的畫面：
 *
 *   new-user       空狀態。真實帳戶一旦交易過就再也回不去，
 *                  但空狀態的設計品質恰恰是很多產品最草率的地方
 *   active         標準情境，多檔部位、混合損益
 *   insufficient   餘額恰好 500 元 —— 買任何東西都會失敗，
 *                  用來一鍵演示「餘額不足」而不必先把錢花光
 *   heavy-history  8,000 筆明細，壓測虛擬滾動
 */
export const accountScenarioSchema = z.enum([
  'new-user',
  'active',
  'insufficient',
  'heavy-history',
]);
export type AccountScenarioValue = z.infer<typeof accountScenarioSchema>;

/** 每個情境的中文說明。前端的控制台直接顯示這個，不自己維護一份。 */
export const SCENARIO_LABELS: Record<AccountScenarioValue, { name: string; hint: string }> = {
  'new-user': { name: '新用戶', hint: '無持倉、無明細 — 看空狀態' },
  active: { name: '一般帳戶', hint: '11 檔持倉、3,000 筆明細' },
  insufficient: { name: '餘額不足', hint: '現金只剩 500 元 — 下單必失敗' },
  'heavy-history': { name: '大量明細', hint: '8,000 筆 — 壓測虛擬滾動' },
};

// ============================================================================
// 故障注入
// ============================================================================

/**
 * 故障種類。可以同時開啟多項。
 *
 * 每一個都對應前端的一個**分支**，而那個分支平常永遠跑不到。
 */
export const faultKindSchema = z.enum([
  'api-500',
  'api-timeout',
  'slow-network',
  'order-rejected',
  'quote-disconnect',
]);
export type FaultKindValue = z.infer<typeof faultKindSchema>;

/** 故障說明。含「開了之後該去哪裡看」—— 不必翻文件就知道怎麼驗。 */
export const FAULT_LABELS: Record<FaultKindValue, { name: string; hint: string }> = {
  'api-500': { name: '伺服器錯誤', hint: '所有 API 回 500 — 看全頁錯誤與 traceId' },
  'api-timeout': { name: '請求逾時', hint: '連線被中斷不回應 — 看「狀態未知」的處理' },
  'slow-network': { name: '慢速網路', hint: '每個請求延遲 3 秒 — 看骨架屏' },
  'order-rejected': { name: '下單被拒', hint: '委託一律被拒 — 看回滾與失敗分支' },
  'quote-disconnect': { name: '報價中斷', hint: 'WebSocket 被切斷 — 看降級顯示' },
};

// ============================================================================
// 端點
// ============================================================================

/** `GET /demo/state` 的回應。 */
export const demoStateSchema = z.object({
  scenario: accountScenarioSchema,
  /** 亂數種子。同一組（情境、種子）永遠產生一模一樣的資料 */
  seed: z.number().int(),
  faults: z.array(faultKindSchema),
});
export type DemoState = z.infer<typeof demoStateSchema>;

/** `POST /demo/scenario` 的請求。 */
export const setScenarioSchema = z.object({
  scenario: accountScenarioSchema,
  /**
   * 選填。不給就沿用目前的種子。
   *
   * ★ 種子必須是固定的，這是 demo 可信度的關鍵：
   *   把「餘額不足」的連結貼給別人，對方打開時看到的數字
   *   如果跟他不一樣，整個 demo 就變成「隨機產生器」而不是「系統」。
   */
  seed: z.number().int().optional(),
});
export type SetScenarioRequest = z.infer<typeof setScenarioSchema>;

/** `POST /demo/faults` 的請求。傳空陣列等於全部關閉。 */
export const setFaultsSchema = z.object({
  faults: z.array(faultKindSchema),
});
export type SetFaultsRequest = z.infer<typeof setFaultsSchema>;

// ============================================================================
// URL 同步
// ============================================================================

/**
 * 控制台狀態在網址上的參數前綴。
 *
 * ── 為什麼要前綴，不直接用 `?scenario=` ★ ──────────────────────
 *
 *   因為網址是**共用的命名空間**。交易明細已經有 `?type=BUY,SELL`，
 *   之後還會有日期區間、排序。控制台再塞幾個沒有前綴的參數進去，
 *   遲早會撞名 —— 而撞名的症狀是「切換情境時篩選條件被清掉」
 *   這種完全看不出原因的怪 bug。
 *
 *   加上 `_demo_` 之後：
 *     · 一眼看出哪些參數屬於控制台
 *     · 前端可以用「前綴」批次清除，不必列舉每一個 key
 *     · 底線開頭是慣例上的「內部參數」，不會被誤認為業務參數
 *
 *   而放進網址（而不是 localStorage）的理由是**可分享**：
 *   可以把「下單被拒」的情境連結直接貼給別人。
 */
export const DEMO_QUERY_PREFIX = '_demo_';

/** 網址上的三個參數名。 */
export const DEMO_QUERY_KEYS = {
  scenario: `${DEMO_QUERY_PREFIX}scenario`,
  seed: `${DEMO_QUERY_PREFIX}seed`,
  faults: `${DEMO_QUERY_PREFIX}faults`,
} as const;

/** 預設狀態。服務啟動時、以及 `POST /demo/reset` 之後都是這個。 */
export const DEFAULT_DEMO_STATE: DemoState = {
  scenario: 'active',
  seed: 42,
  faults: [],
};
