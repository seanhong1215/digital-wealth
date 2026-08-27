/**
 * web/src/routes/TransactionsPage.tsx — 交易明細
 *
 * 在架構的哪一層：路由層（頁面）。
 *
 * ── 篩選條件同步到 URL ★ ──────────────────────────────────────────
 *
 *   類型篩選存在 `?type=BUY,SELL` 而不是元件的 useState。理由：
 *
 *     1. **可分享** —— 「你看一下我這個月的手續費」可以直接貼連結
 *     2. **重新整理不會重置** —— 使用者篩選完不小心重整，條件還在
 *     3. **返回鍵符合直覺** —— 按返回回到上一組篩選條件
 *
 *   代價是每次改篩選都會產生一筆瀏覽歷史。用 `replace: true` 可以
 *   避免，但那樣就失去第 3 點。這裡選擇保留歷史。
 *
 * ── 這一頁的職責邊界 ──────────────────────────────────────────────
 *
 *   頁面只管三件事：讀 URL 的篩選條件、呼叫 query、決定要顯示
 *   骨架屏／空狀態／列表哪一種。
 *
 *   「一列長什麼樣」在 TransactionRow，「幾千筆怎麼不卡」在
 *   TransactionList（虛擬滾動）。兩者都與篩選邏輯無關，
 *   所以不該住在這個檔案裡 —— 這也是為什麼虛擬滾動加進來之後，
 *   這一頁反而變短了。
 */

import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { TransactionType } from '@fintech/shared';

import { useTransactions } from '../features/transactions/api/queries';
import { TransactionList } from '../features/transactions/components/TransactionList';
import { Card, EmptyState, ErrorState, SectionTitle, Skeleton } from '../shared/ui';

/** 篩選鈕。空陣列代表全部。 */
const FILTER_OPTIONS: { label: string; types: TransactionType[] }[] = [
  { label: '全部', types: [] },
  { label: '買進', types: ['BUY'] },
  { label: '賣出', types: ['SELL'] },
  { label: '費用與稅', types: ['FEE', 'TAX'] },
  { label: '股利', types: ['DIVIDEND'] },
];

export function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const typeParam = searchParams.get('type') ?? '';
  const types = typeParam ? (typeParam.split(',') as TransactionType[]) : [];

  const query = useTransactions({ types });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  // useCallback 讓這個函式的參考穩定 —— TransactionList 的
  // 「捲到底自動載入」effect 把它列為相依，每次 render 都給新函式的話
  // 那個 effect 會不停重跑。
  const loadMore = useCallback(() => {
    void query.fetchNextPage();
  }, [query]);

  const setFilter = (next: TransactionType[]) => {
    const params = new URLSearchParams(searchParams);
    if (next.length === 0) params.delete('type');
    else params.set('type', next.join(','));
    setSearchParams(params);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card padded={false}>
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">
          <SectionTitle>交易明細</SectionTitle>

          {/* 橫向捲動的篩選列：手機上五個按鈕排不下，
              強制換行會讓標題區忽高忽低。 */}
          <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            {FILTER_OPTIONS.map((option) => {
              const isActive = option.types.join(',') === types.join(',');
              return (
                <button
                  key={option.label}
                  onClick={() => setFilter(option.types)}
                  aria-pressed={isActive}
                  className={`shrink-0 rounded-full border px-3.5 py-1.5 text-base font-medium transition-colors ${
                    isActive
                      ? 'border-indigo-600 bg-indigo-600 text-white'
                      : 'border-border bg-bg-surface text-text-secondary hover:bg-bg-subtle'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <div className="flex flex-col gap-3 p-4 sm:p-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="沒有符合條件的紀錄"
            hint={types.length > 0 ? '試試其他篩選條件' : '完成第一筆交易後這裡會有紀錄'}
          />
        ) : (
          <>
            <TransactionList
              items={items}
              hasNextPage={query.hasNextPage}
              isFetchingNextPage={query.isFetchingNextPage}
              onLoadMore={loadMore}
            />

            {!query.hasNextPage && (
              <p className="p-4 text-center text-sm text-text-secondary sm:p-6">
                已顯示全部 {items.length.toLocaleString('zh-TW')} 筆
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
