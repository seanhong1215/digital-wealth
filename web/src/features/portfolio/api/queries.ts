/**
 * web/src/features/portfolio/api/queries.ts — 投組的 query hooks
 *
 * 在架構的哪一層：feature 的 api/ 層。
 */

import { useQuery } from '@tanstack/react-query';
import type { Account, PortfolioSnapshot, PortfolioSummary, Position } from '@fintech/shared';

import { apiGet } from '../../../shared/lib/api-client';
import { queryKeys } from '../../../shared/lib/query-client';

/**
 * 投組總覽。
 *
 * ⚠️ 注意這個端點**不含未實現損益**。未實現損益需要即時報價
 *    （市值 − 成本），而報價走 WebSocket，是前端的衍生值。
 *    後端只回傳它擁有權威資料的東西：現金、成本、已實現損益。
 *
 *    這個「權威值 vs 衍生值」的界線，是 docs/00-architecture.md
 *    定義的前後端分工原則。目前 WebSocket 尚未實作（單元 2.3），
 *    所以市值用昨收價計算，見 usePositions 的說明。
 */
export function usePortfolioSummary() {
  return useQuery({
    queryKey: queryKeys.portfolioSummary,
    queryFn: () => apiGet<PortfolioSummary>('/portfolio/summary'),
  });
}

/** 資產走勢。回傳由舊到新排序，正好是折線圖需要的順序。 */
export function usePortfolioSnapshots(days = 30) {
  return useQuery({
    queryKey: queryKeys.portfolioSnapshots(days),
    queryFn: () => apiGet<PortfolioSnapshot[]>(`/portfolio/snapshots?days=${days}`),
  });
}

/**
 * 持倉列表。
 *
 * 目前的市值以 `prevCloseCents`（昨收價）計算 —— 這是誠實的簡化：
 * WebSocket 即時報價還沒接上（單元 2.3），與其顯示一個假裝在跳的
 * 數字，不如用真實存在的昨收價，並在畫面上標明「以昨收計算」。
 */
export function usePositions() {
  return useQuery({
    queryKey: queryKeys.positions,
    queryFn: () => apiGet<Position[]>('/positions'),
  });
}

/** 帳戶餘額。下單頁要用它顯示「可用餘額」。 */
export function useAccount() {
  return useQuery({
    queryKey: queryKeys.account,
    queryFn: () => apiGet<Account>('/accounts/me'),
  });
}
