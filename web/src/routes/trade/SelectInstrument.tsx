/**
 * web/src/routes/trade/SelectInstrument.tsx — 下單步驟 1：選擇標的
 *
 * 在架構的哪一層：路由層（頁面）。
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useInstrumentSearch } from '../../features/trading/api/queries';
import { formatPrice } from '../../shared/lib/format';
import { Card, EmptyState, ErrorState, Field, SectionTitle, Skeleton } from '../../shared/ui';

export function SelectInstrument() {
  const [input, setInput] = useState('');
  const keyword = useDebounced(input, 250);
  const { data, isLoading, error, refetch } = useInstrumentSearch(keyword);

  return (
    <Card padded={false}>
      <div className="p-4 sm:p-6">
        <SectionTitle>下單 · 選擇標的</SectionTitle>

        <Field
          id="search"
          label="搜尋"
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="輸入代號或名稱，例如 2330 或 台積電"
          hint="留空顯示全部可交易標的"
          // 手機上鍵盤的 Enter 鍵顯示成「搜尋」而不是「換行」。
          enterKeyHint="search"
        />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState title="查無標的" hint="確認代號或名稱是否正確" />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {data.map((instrument) => (
            <li key={instrument.id}>
              <Link
                to={`/trade/${instrument.symbol}`}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-navy-50 sm:px-6"
              >
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2">
                    <span className="tnum text-lg font-semibold">{instrument.symbol}</span>
                    <span className="truncate text-base text-text-secondary" title={instrument.name}>
                      {instrument.name}
                    </span>
                  </p>
                  <p className="mt-0.5 text-sm text-text-secondary">{instrument.market}</p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="tnum text-lg font-medium">
                    {formatPrice(instrument.prevCloseCents)}
                  </p>
                  <p className="text-sm text-text-secondary">昨收</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * 延遲更新，避免每打一個字就打一次 API。
 *
 * 250ms 的取捨：低於 150ms 幾乎等於沒有防抖；高於 400ms 使用者
 * 會感覺「打完字之後畫面愣了一下」。250ms 剛好落在
 * 「連續打字時不觸發、停下來就馬上反應」的區間。
 *
 * 注意 cleanup 的 clearTimeout —— 少了它，每次 input 變動都會留下
 * 一個計時器，最後全部一起觸發，防抖完全失效。
 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
