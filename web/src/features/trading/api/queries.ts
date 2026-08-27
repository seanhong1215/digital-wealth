/**
 * web/src/features/trading/api/queries.ts — 下單的 query / mutation hooks
 *
 * 在架構的哪一層：feature 的 api/ 層。
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  CreateOrderRequest,
  Execution,
  Instrument,
  Order,
  OrderDraft,
  OrderPreview,
  OrderResult,
} from '@digital-wealth/shared';

import { apiGet, apiPost } from '../../../shared/lib/api-client';
import { invalidateAfterTrade, queryKeys } from '../../../shared/lib/query-client';

/** 搜尋標的。空字串時回傳預設清單（後端的 q 是選填）。 */
export function useInstrumentSearch(keyword: string) {
  return useQuery({
    queryKey: queryKeys.instruments(keyword),
    queryFn: () => {
      const params = new URLSearchParams({ limit: '20' });
      if (keyword.trim()) params.set('q', keyword.trim());
      return apiGet<Instrument[]>(`/instruments?${params.toString()}`);
    },
    // 標的清單幾乎不變，快取久一點。
    staleTime: 5 * 60_000,
  });
}

/** 單一標的。下單頁要用它的昨收價算漲跌停與預設價格。 */
export function useInstrument(symbol: string | undefined) {
  return useQuery({
    queryKey: queryKeys.instrument(symbol ?? ''),
    queryFn: () => apiGet<Instrument>(`/instruments/${symbol}`),
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
  });
}

/**
 * 費用試算。
 *
 * 為什麼用 useQuery 而不是 useMutation —— 它明明是 POST？
 *   判準不是 HTTP 動詞，是**有沒有副作用**。試算是純計算，
 *   同樣的輸入永遠得到同樣的輸出，而且該被快取、該在參數變動時
 *   自動重算 —— 這些全是 useQuery 的行為。
 *   用 useMutation 反而要自己寫「參數變了就重新呼叫」的 effect。
 */
export function useOrderPreview(draft: OrderDraft | null) {
  return useQuery({
    queryKey: ['order-preview', draft],
    queryFn: () => apiPost<OrderPreview>('/orders/preview', draft),
    enabled: draft !== null,
    // 試算失敗多半是價格不合法（漲跌停、跳動點），重試沒有意義。
    retry: false,
  });
}

/**
 * 送出委託。★
 *
 * ── 為什麼這裡沒有「樂觀更新」 ─────────────────────────────────
 *
 *   樂觀更新（先假設成功、更新畫面、失敗再回滾）適合**幾乎一定成功**
 *   而且**錯了代價很小**的操作 —— 按讚、加入收藏。
 *
 *   下單兩個條件都不符合：它有一整排合理的失敗理由（餘額不足、
 *   持股不足、超過漲跌停），而且「顯示成交了、兩秒後改口說沒成交」
 *   在金融場景是會讓人失去信任的體驗。
 *
 *   所以下單走的是**悲觀更新**：等後端確定成交，才更新畫面。
 *   代價是使用者要看兩秒的「處理中」，換來的是畫面上的數字
 *   永遠是真的。
 *
 *   （PROJECT.md 提到的樂觀更新回滾，屬於 P3 後續單元的
 *   「持倉列表即時反映」情境，不是下單送出本身。）
 */
export function useCreateOrder() {
  return useMutation({
    mutationFn: (request: CreateOrderRequest) => apiPost<OrderResult>('/orders', request),

    // 成交後現金、持倉、總覽、明細全都變了 —— 一次失效乾淨。
    // 漏掉任何一個，畫面就會有一塊顯示著舊資料。
    onSuccess: () => invalidateAfterTrade(),
  });
}

/**
 * 查詢單一委託。
 *
 * 結果頁靠這個支撐「重新整理後畫面還在」與「連結可分享給同事」——
 * 委託 ID 在網址裡，資料從後端重新取得，不依賴任何前端狀態。
 * 這是 docs/adr/0008「下單步驟走路由」的具體後果。
 */
export function useOrder(orderId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.order(orderId ?? ''),
    queryFn: () => apiGet<{ order: Order; executions: Execution[] }>(`/orders/${orderId}`),
    enabled: Boolean(orderId),
  });
}
