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
 * ── 為什麼不是虛擬滾動 ────────────────────────────────────────────
 *
 *   PROJECT.md 規劃的是 TanStack Virtual 處理 3,000+ 筆。這個 MVP
 *   先做「載入更多」按鈕：一次 30 筆，DOM 節點數量本來就受控，
 *   虛擬滾動要解決的問題（一次渲染幾千個節點）還沒發生。
 *
 *   虛擬滾動屬於單元 1.9，等真的要展示「8,000 筆連續捲動」時再做 ——
 *   在問題出現之前先做優化，是把複雜度當成績效。
 */

import { useSearchParams } from 'react-router-dom';

import type { Transaction, TransactionType } from '@fintech/shared';

import { useTransactions } from '../features/transactions/api/queries';
import { formatPrice, formatQuantity, formatRelativeTime } from '../shared/lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  MoneyText,
  SectionTitle,
  Skeleton,
} from '../shared/ui';

/** 篩選鈕。空陣列代表全部。 */
const FILTER_OPTIONS: { label: string; types: TransactionType[] }[] = [
  { label: '全部', types: [] },
  { label: '買進', types: ['BUY'] },
  { label: '賣出', types: ['SELL'] },
  { label: '費用與稅', types: ['FEE', 'TAX'] },
  { label: '股利', types: ['DIVIDEND'] },
];

/** 交易類型的顯示設定。集中在這裡，避免散落在 JSX 裡。 */
const TYPE_DISPLAY: Record<TransactionType, { label: string; tone: 'up' | 'down' | 'neutral' }> = {
  // 買進讓現金減少，但那是資產轉換不是虧損 —— 所以用中性色，
  // 不要用跌色。這是很容易做錯的地方：金額的正負號 ≠ 好壞。
  BUY: { label: '買進', tone: 'neutral' },
  SELL: { label: '賣出', tone: 'neutral' },
  FEE: { label: '手續費', tone: 'neutral' },
  TAX: { label: '稅', tone: 'neutral' },
  DIVIDEND: { label: '股利', tone: 'up' },
  DEPOSIT: { label: '轉入', tone: 'neutral' },
  WITHDRAWAL: { label: '轉出', tone: 'neutral' },
};

export function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const typeParam = searchParams.get('type') ?? '';
  const types = typeParam ? (typeParam.split(',') as TransactionType[]) : [];

  const query = useTransactions({ types });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

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
            <ul className="divide-y divide-border">
              {items.map((tx) => (
                <TransactionRow key={tx.id} transaction={tx} />
              ))}
            </ul>

            <div className="p-4 sm:p-6">
              {query.hasNextPage ? (
                <Button
                  variant="secondary"
                  fullWidth
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  載入更多
                </Button>
              ) : (
                <p className="text-center text-sm text-text-secondary">
                  已顯示全部 {items.length.toLocaleString('zh-TW')} 筆
                </p>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const display = TYPE_DISPLAY[transaction.type];

  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3 sm:px-6">
      <div className="min-w-0">
        <p className="flex items-center gap-2">
          <Badge tone={display.tone}>{display.label}</Badge>
          <span className="truncate text-base text-text-primary" title={transaction.description}>
            {transaction.description}
          </span>
        </p>

        <p className="tnum mt-1 text-sm text-text-secondary">
          {formatRelativeTime(transaction.occurredAt)}
          {/* 有成交價才顯示。手續費那一列沒有價格與股數，
              強行顯示會變成 `— 股 @ —`，比不顯示更糟。 */}
          {transaction.priceCents !== null && transaction.quantity !== null && (
            <>
              <span className="mx-1.5 text-text-placeholder">·</span>
              {formatQuantity(transaction.quantity)} @ {formatPrice(transaction.priceCents)}
            </>
          )}
        </p>
      </div>

      <div className="shrink-0 text-right">
        {/* colored：金額本身依正負著色。收入紅（台股漲色）、支出綠。 */}
        <p>
          <MoneyText value={transaction.amountCents} size="lg" signed colored />
        </p>
        <p className="tnum mt-0.5 text-sm text-text-secondary">
          結餘 {new Intl.NumberFormat('zh-TW').format(Math.round(transaction.balanceAfterCents / 100))}
        </p>
      </div>
    </li>
  );
}
