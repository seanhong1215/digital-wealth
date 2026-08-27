/**
 * web/src/features/transactions/api/queries.ts — 交易明細的 query hooks
 *
 * 在架構的哪一層：feature 的 api/ 層。
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import type { TransactionPage, TransactionType } from '@fintech/shared';

import { apiGet } from '../../../shared/lib/api-client';
import { queryKeys } from '../../../shared/lib/query-client';

export interface TransactionFilters {
  /** 空陣列代表不篩選（全部類型） */
  types: TransactionType[];
}

/**
 * 交易明細，cursor 分頁。
 *
 * ── 為什麼是 cursor 而不是 `?page=3` ★ ──────────────────────────
 *
 *   OFFSET 分頁有兩個問題，在「持續有新資料寫入」的明細上都會發作：
 *
 *     1. **翻頁時資料會重複或遺漏**
 *        你在看第 1 頁（最新 30 筆）時剛好下了一筆單。
 *        按「下一頁」送出 OFFSET 30 —— 但整個列表已經往後推了一格，
 *        所以第 1 頁的最後一筆會**再出現一次**。
 *        反過來，如果有資料被刪，就會有一筆你永遠看不到。
 *
 *     2. **深頁很慢**
 *        `OFFSET 9000` 要求資料庫先掃過並丟棄 9000 列才開始回傳。
 *        頁數越深越慢，而且是線性惡化。
 *
 *   cursor 分頁改成「給我 occurred_at 比這個時間更早的 30 筆」，
 *   直接走索引定位，跟頁數多深無關，也不受期間新增資料影響。
 *
 * ── nextCursor 為什麼是一串看不懂的 base64 ────────────────────────
 *
 *   後端刻意把它編碼成**不透明字串（opaque token）**。前端不該解析它，
 *   也不該自己組 —— 這樣後端哪天改變排序欄位（例如加上 id 當第二排序鍵），
 *   前端一行都不用改。前端唯一該做的事就是「把上一頁給我的字串原樣送回去」。
 */
export function useTransactions(filters: TransactionFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.transactions(filters),

    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '30' });
      if (pageParam) params.set('cursor', pageParam);
      if (filters.types.length > 0) params.set('type', filters.types.join(','));

      return apiGet<TransactionPage>(`/transactions?${params.toString()}`);
    },

    initialPageParam: '' as string,

    // 回傳 undefined 代表「沒有下一頁了」，TanStack Query 會把
    // hasNextPage 設成 false。後端在最後一頁回傳 nextCursor: null。
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
