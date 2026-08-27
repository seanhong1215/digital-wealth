/**
 * web/src/shared/lib/query-client.ts — TanStack Query 設定
 *
 * 這個檔案是什麼：
 *   全域的 server state 快取設定。
 *
 * ── 為什麼 server state 不用 Zustand / Redux 管 ★ ────────────────
 *
 *   因為「後端的資料」和「UI 的狀態」是兩種完全不同的東西：
 *
 *     UI 狀態      我擁有它。Drawer 開著、目前在第幾步。
 *                  沒有別人會改它，也不會過期。
 *
 *     Server 狀態  我**不**擁有它，只是持有一份快取副本。
 *                  它隨時可能過期、需要重新驗證、需要處理載入與錯誤、
 *                  多個元件要共用同一份、失敗要重試。
 *
 *   把 server state 放進 Redux，等於要自己實作快取失效、去重、重試、
 *   背景更新 —— 那正是 TanStack Query 已經做好的事。
 *
 *   本專案的分工：TanStack Query 管 server state，Zustand 只管
 *   UI 與 Demo 控制台（見 PROJECT.md 的技術決策表）。
 */

import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api-client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * 資料在 30 秒內視為新鮮，不會重新抓。
       *
       * 為什麼不是 0（每次都抓）：使用者在總覽和明細之間來回切換時，
       * 每次都重抓會讓畫面閃一下骨架屏，體感很差。
       *
       * 為什麼不是 5 分鐘：金融資料放太久會讓人不信任。30 秒是
       * 「換頁不閃、但回頭看時是新的」的折衷。
       *
       * 注意這只影響「靜態」資料。即時報價走的是 WebSocket
       * （單元 2.3），不受這個設定影響。
       */
      staleTime: 30_000,

      /**
       * 重試策略：只重試「暫時性故障」。
       *
       * 餘額不足重試 100 次結果還是餘額不足，只是讓使用者多等三秒。
       * 判斷邏輯放在 ApiError.isRetryable，前後端的錯誤分類是同一套
       * （見 docs/02-backend.md 的錯誤分類與前端策略）。
       */
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          return error.isRetryable && failureCount < 3;
        }
        return failureCount < 2;
      },

      /** 指數退避：1s → 2s → 4s，上限 10s。 */
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),

      /**
       * 切回瀏覽器分頁時不自動重抓。
       *
       * 預設是 true，對多數 App 是好事。但金融數字在使用者眼前
       * 無預警跳動會讓人以為自己看錯了 —— 尤其是總資產。
       * 需要更新時由使用者主動下拉重整，或由 WebSocket 推送。
       */
      refetchOnWindowFocus: false,
    },

    mutations: {
      /**
       * 寫入操作**絕不自動重試**。
       *
       * 這是本設定檔最重要的一行。下單超時的時候，前端不知道
       * 「後端到底成立了沒」—— 自動重送可能變成下兩筆。
       *
       * 冪等鍵確實能防住這種重送，但那是**最後防線**，
       * 不該當成日常機制來用。正確做法是把「狀態未知」如實
       * 顯示給使用者，讓他自己決定要不要重試。
       */
      retry: false,
    },
  },
});

/**
 * Query key 的集中定義。
 *
 * 為什麼要集中：query key 同時是「快取的身分證」和「失效的目標」。
 * 下單成功後要讓投組、持倉、明細、帳戶全部失效重抓 —— 如果 key
 * 是散落各處的字串字面量，一定會有地方拼錯，而拼錯的後果是
 * **靜默地沒有失效**：畫面顯示舊餘額，使用者以為錢沒扣。
 */
export const queryKeys = {
  session: ['session'] as const,
  account: ['account'] as const,
  portfolioSummary: ['portfolio', 'summary'] as const,
  portfolioSnapshots: (days: number) => ['portfolio', 'snapshots', days] as const,
  positions: ['positions'] as const,
  instruments: (q: string) => ['instruments', q] as const,
  instrument: (symbol: string) => ['instrument', symbol] as const,
  transactions: (filters: unknown) => ['transactions', filters] as const,
  order: (id: string) => ['order', id] as const,
} as const;

/**
 * 下單成功後要失效的所有 query。
 *
 * 一筆成交會同時改變：現金餘額、持倉、投組總覽、交易明細。
 * 漏掉任何一個，畫面就會有一塊顯示著舊資料 ——
 * 而在金融介面裡，「有一塊數字是舊的」和「數字是錯的」沒有區別。
 */
export async function invalidateAfterTrade(): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.account }),
    queryClient.invalidateQueries({ queryKey: ['portfolio'] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.positions }),
    queryClient.invalidateQueries({ queryKey: ['transactions'] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.session }),
  ]);
}
