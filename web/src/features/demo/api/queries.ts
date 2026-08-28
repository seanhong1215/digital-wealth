/**
 * web/src/features/demo/api/queries.ts — Demo 控制台的 query hooks
 *
 * 在架構的哪一層：feature 的 api 層。
 */

import { useMutation, useQuery } from '@tanstack/react-query';

import type {
  AccountScenarioValue,
  DemoState,
  FaultKindValue,
} from '@digital-wealth/shared';

import { ApiError, apiGet, apiPost } from '../../../shared/lib/api-client';
import { queryClient } from '../../../shared/lib/query-client';

const DEMO_STATE_KEY = ['demo', 'state'] as const;

/**
 * 控制台狀態。**同時也是「控制台存不存在」的探測**。
 *
 * ── 前端怎麼知道要不要顯示控制台 ★ ──────────────────────────────
 *
 *   直覺做法是在前端也放一個環境變數（`import.meta.env.DEV` 之類）。
 *   但那樣會有兩個真相來源，而且它們會不同步 ——
 *   前端 build 成 production、後端卻開著 ENABLE_DEMO=1 的話，
 *   面板不見了但故障注入還在，那是最難查的組合。
 *
 *   正確做法是**問後端**：控制台關閉時 `/demo/state` 這個路由
 *   根本不存在（見 demo.module.ts），回 404。前端收到 404
 *   就知道「這個部署沒有控制台」，什麼都不畫。
 *
 *   於是開關只有一個地方：後端的 `isDemoEnabled`。
 *   前端不需要任何設定，也不可能跟後端說法不一致。
 */
export function useDemoState() {
  return useQuery({
    queryKey: DEMO_STATE_KEY,
    queryFn: async (): Promise<DemoState | null> => {
      try {
        return await apiGet<DemoState>('/demo/state');
      } catch (error) {
        // 404 = 這個部署沒有控制台。這是正常結果，不是錯誤。
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
    // 控制台的狀態只會被自己改變，不需要定期重抓。
    staleTime: Infinity,
  });
}

/**
 * 切換帳戶情境。
 *
 * ── 為什麼是 `resetQueries()`，不是 invalidate 也不是 clear ★ ────
 *
 *   切換情境會**重建整個資料庫**。舊的持倉、明細、委託全部消失。
 *
 *     invalidateQueries()  會先把**舊資料**顯示出來、同時在背景重抓
 *                          （平常很好用的預設行為）。但這裡的舊資料
 *                          屬於一個已經不存在的狀態 —— 會看到
 *                          上個情境的數字閃過去才被換掉
 *
 *     clear()              ❌ 第一版用這個，結果畫面**完全不更新**。
 *                          clear() 只是把快取整個丟掉，它不會叫
 *                          已經掛載的 observer 重新抓 —— 元件停在
 *                          最後一次的資料上，直到下一次重新 render
 *
 *     resetQueries()       ✅ 把資料重設成初始狀態，**並且**重抓所有
 *                          正在使用中的 query。畫面回到骨架屏，
 *                          然後填入新情境的資料
 *
 *   差別只有在「切換後畫面沒反應」時才會發現，而那時很容易誤判成
 *   後端沒切成功。
 */
export function useSetScenario() {
  return useMutation({
    mutationFn: (params: { scenario: AccountScenarioValue; seed?: number }) =>
      apiPost<DemoState>('/demo/scenario', params),

    onSuccess: async (state) => {
      // 排除控制台自己的 query —— 它的最新值就在手上（`state`），
      // 重抓一次只會讓面板閃一下「載入中」。
      await queryClient.resetQueries({
        predicate: (query) => query.queryKey[0] !== 'demo',
      });
      queryClient.setQueryData(DEMO_STATE_KEY, state);
    },
  });
}

/**
 * 設定故障注入。
 *
 * 這裡**不清快取** —— 故障不改變資料，只改變「下一個請求會怎樣」。
 * 清掉的話會立刻觸發一輪重抓，而那些請求會馬上撞上剛開啟的故障，
 * 還沒看清楚面板就先看到滿頁錯誤。
 *
 * 讓他自己去點一個頁面觸發，比較能看清楚因果。
 */
export function useSetFaults() {
  return useMutation({
    mutationFn: (faults: FaultKindValue[]) => apiPost<DemoState>('/demo/faults', { faults }),
    onSuccess: (state) => queryClient.setQueryData(DEMO_STATE_KEY, state),
  });
}

/** 回到預設情境並清除所有故障。 */
export function useResetDemo() {
  return useMutation({
    mutationFn: () => apiPost<DemoState>('/demo/reset'),
    onSuccess: async (state) => {
      await queryClient.resetQueries({
        predicate: (query) => query.queryKey[0] !== 'demo',
      });
      queryClient.setQueryData(DEMO_STATE_KEY, state);
    },
  });
}
