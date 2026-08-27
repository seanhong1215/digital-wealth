/**
 * web/src/routes/PortfolioPage.tsx — 投資總覽 ＋ 持倉（合併單頁）
 *
 * 在架構的哪一層：路由層（頁面）。負責組裝，不負責取資料的細節。
 *
 * ── 為什麼總覽和持倉合併成一頁 ★ ─────────────────────────────────
 *
 *   分成兩頁比較「乾淨」，但使用者情境不支持：主要使用者是通勤或
 *   睡前打開來看三十秒的散戶，他要問的問題是「我現在有多少、賺賠多少」。
 *   總資產和持倉明細是**同一個問題的兩個層次**，分兩頁等於強迫他
 *   多點一次才能得到完整答案。
 *
 *   詳見 docs/adr/0007。
 *
 * ── 未實現損益是前端算的，不是後端 ★ ─────────────────────────────
 *
 *   後端只回傳它擁有權威資料的東西：現金、成本基礎、已實現損益。
 *   「未實現損益 = 市值 − 成本」需要**即時報價**，而報價是會動的、
 *   前端從 WebSocket 收得到的東西。
 *
 *   如果讓後端算，每次報價跳動都要重打一次 API 才能更新損益 ——
 *   那等於把即時串流退化成輪詢。
 *
 *   所以這一頁的市值與未實現損益，是用 WebSocket 推來的即時價格
 *   在前端算出來的。報價中斷時自動退回昨收價，並在畫面上標示 ——
 *   降級不是把數字藏起來，是把數字的來源說清楚。
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Position } from '@digital-wealth/shared';

import {
  usePortfolioSnapshots,
  usePortfolioSummary,
  usePositions,
} from '../features/portfolio/api/queries';
import {
  useFeedStatus,
  useLiveMarketValue,
  useLivePrice,
  useQuoteSubscription,
} from '../features/quotes/api/use-quotes';
import {
  FreshnessTag,
  QuoteFeedBanner,
} from '../features/quotes/components/QuoteStatus';
import {
  formatMoney,
  formatPrice,
  formatQuantity,
  formatShortDate,
  priceDirection,
} from '../shared/lib/format';
import {
  Card,
  EmptyState,
  ErrorState,
  MoneyText,
  PriceChange,
  SectionTitle,
  Skeleton,
} from '../shared/ui';

export function PortfolioPage() {
  const summary = usePortfolioSummary();
  const snapshots = usePortfolioSnapshots(30);
  const positions = usePositions();

  // ★ 只訂閱畫面上真的看得到的標的 —— 也就是這個帳戶的持倉。
  //
  // useMemo 是必要的：symbols 陣列如果每次 render 都是新物件，
  // 訂閱的 effect 會不斷退訂再訂閱（理由見 useQuoteSubscription 的說明）。
  const symbols = useMemo(
    () => (positions.data ?? []).map((p) => p.instrument.symbol),
    [positions.data],
  );
  useQuoteSubscription(symbols);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">投資總覽</h1>

      <QuoteFeedBanner />

      <OverviewCard
        data={summary.data}
        isLoading={summary.isLoading}
        error={summary.error}
        onRetry={() => void summary.refetch()}
        positions={positions.data}
      />

      <TrendCard
        data={snapshots.data}
        isLoading={snapshots.isLoading}
        error={snapshots.error}
        onRetry={() => void snapshots.refetch()}
      />

      <PositionsCard
        data={positions.data}
        isLoading={positions.isLoading}
        error={positions.error}
        onRetry={() => void positions.refetch()}
      />
    </div>
  );
}

// ============================================================================
// 總覽卡
// ============================================================================

function OverviewCard({
  data,
  isLoading,
  error,
  onRetry,
  positions,
}: {
  data: ReturnType<typeof usePortfolioSummary>['data'];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  positions: Position[] | undefined;
}) {
  // ★ 市值用**即時報價**重算，不用後端回傳的 marketValueCents。
  //
  // 後端那個值是用昨收價算的（它沒有即時報價）。這裡拿 WebSocket
  // 推來的價格 × 股數重算，數字才會跟著市場跳動。
  // 報價還沒到的標的自動退回昨收價，hasFallback 會標記出來。
  const live = useLiveMarketValue(positions ?? []);
  const feed = useFeedStatus();

  // 未實現損益 = 即時市值 − 成本基礎。成本基礎是後端的權威值。
  const unrealizedPnl = data && positions ? live.marketValueCents - data.totalCostBasisCents : null;

  // 報酬率的分母是成本。成本為 0 時（例如全部部位都是股票股利取得）
  // 相除會得到 Infinity —— formatPercent 會把它顯示成 `—` 而不是 "Infinity%"。
  const unrealizedRatio =
    data && data.totalCostBasisCents > 0 && unrealizedPnl !== null
      ? unrealizedPnl / data.totalCostBasisCents
      : null;

  // 總資產也要跟著即時市值走。後端的 totalValueCents 同樣是昨收價版本。
  const totalValue = data ? data.cashCents + live.marketValueCents : null;

  if (error) return <Card><ErrorState error={error} onRetry={onRetry} /></Card>;

  if (isLoading || !data) {
    return (
      <Card>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-3 h-10 w-56" />
        <Skeleton className="mt-4 h-16 w-full" />
      </Card>
    );
  }

  return (
    <Card>
      <p className="text-base text-text-secondary">總資產</p>

      {/* 36px、bold —— 這是整個 App 字級最大的數字，因為它是使用者
          打開 App 唯一真正想看的東西。 */}
      <p className="mt-1">
        <MoneyText value={totalValue} size="4xl" />
      </p>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-base text-text-secondary">今日</span>
        <PriceChange valueCents={data.todayPnlCents} size="lg" />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
        <Stat label="現金" value={<MoneyText value={data.cashCents} size="lg" />} />
        <Stat
          label="持股市值"
          value={<MoneyText value={live.marketValueCents} size="lg" />}
          // 數字的來源必須誠實標示 —— 報價停了卻還寫「即時報價」，
          // 比不標示更糟。三種情況三種說法。
          hint={
            feed !== 'live'
              ? '最後收到的報價'
              : live.hasFallback
                ? '部分標的以昨收價計算'
                : '即時報價'
          }
        />
        <Stat
          label="未實現損益"
          value={<PriceChange valueCents={unrealizedPnl} ratio={unrealizedRatio} size="lg" />}
        />
        <Stat
          label="已實現損益"
          value={<MoneyText value={data.realizedPnlCents} size="lg" signed colored />}
        />
      </dl>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-text-placeholder">{hint}</p>}
    </div>
  );
}

// ============================================================================
// 走勢卡
// ============================================================================

/**
 * 資產走勢。
 *
 * ── Y 軸為什麼不從 0 開始 ★ ────────────────────────────────────────
 *
 *   一般的資料視覺化準則是「長條圖的 Y 軸必須從 0 開始」，否則會
 *   誇大差異。但**折線圖的資產曲線是例外**：
 *
 *   一個 300 萬的投組，一個月波動 5 萬。如果 Y 軸從 0 畫到 300 萬，
 *   那條線會是一條完全水平的直線 —— 使用者什麼都看不出來。
 *
 *   這裡用 `domain={['dataMin', 'dataMax']}` 讓 Y 軸貼合資料範圍。
 *   代價是視覺上會放大波動，所以**必須把 Y 軸刻度標出來**
 *   （不能只畫線不標數字），讓使用者自己判斷幅度。
 */
function TrendCard({
  data,
  isLoading,
  error,
  onRetry,
}: {
  data: ReturnType<typeof usePortfolioSnapshots>['data'];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const chartData = useMemo(
    () =>
      (data ?? []).map((s) => ({
        date: formatShortDate(s.date),
        total: s.totalValueCents / 100,
      })),
    [data],
  );

  if (error) return <Card><ErrorState error={error} onRetry={onRetry} /></Card>;

  return (
    <Card>
      <SectionTitle>資產走勢</SectionTitle>
      <p className="-mt-2 mb-3 text-sm text-text-secondary">近 30 個交易日</p>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : chartData.length === 0 ? (
        <EmptyState title="尚無歷史資料" hint="開始交易後這裡會顯示資產變化" />
      ) : (
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id="totalFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-indigo-500)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--color-indigo-500)" stopOpacity={0} />
                </linearGradient>
              </defs>

              <CartesianGrid stroke="var(--color-navy-100)" vertical={false} />

              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: 'var(--color-navy-500)' }}
                tickLine={false}
                axisLine={false}
                // 30 個點全部標出來會擠成一團。interval 讓 Recharts
                // 自己挑選要顯示哪幾個刻度。
                interval="preserveStartEnd"
                minTickGap={24}
              />

              <YAxis
                domain={['dataMin', 'dataMax']}
                tick={{ fontSize: 12, fill: 'var(--color-navy-500)' }}
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => `${Math.round(v / 10000)} 萬`}
              />

              <Tooltip
                formatter={(value) => [formatMoney(Number(value) * 100), '總資產']}
                contentStyle={{
                  borderRadius: 8,
                  border: '1px solid var(--color-border)',
                  fontSize: 14,
                }}
              />

              <Area
                type="monotone"
                dataKey="total"
                stroke="var(--color-indigo-600)"
                strokeWidth={2}
                fill="url(#totalFill)"
                // 30 個點每個都畫圓點太吵，只在 hover 時顯示。
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// 持倉卡
// ============================================================================

function PositionsCard({
  data,
  isLoading,
  error,
  onRetry,
}: {
  data: Position[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error) return <Card><ErrorState error={error} onRetry={onRetry} /></Card>;

  return (
    <Card padded={false}>
      <div className="px-4 pt-4 sm:px-6 sm:pt-6">
        <SectionTitle
          action={
            <Link
              to="/trade"
              className="rounded-md px-3 py-1.5 text-base font-medium text-indigo-600 hover:bg-indigo-50"
            >
              下單
            </Link>
          }
        >
          我的持倉
        </SectionTitle>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState title="尚無持倉" hint="從「下單」開始建立第一筆部位" />
      ) : (
        <ul className="divide-y divide-border">
          {data.map((position) => (
            <PositionRow key={position.id} position={position} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PositionRow({ position }: { position: Position }) {
  const { instrument, quantity, avgCostCents, costBasisCents } = position;

  // ★ 每一列各自訂閱自己那一檔的報價。
  //
  // 這代表 2330 跳動時，**只有這一列**會 re-render ——
  // 其他 10 檔完全不受影響。持倉列表捲動時不會因為報價而卡頓。
  // 做法見 quote-store.ts 的 listeners Map 說明。
  const { priceCents, freshness } = useLivePrice(instrument.symbol, instrument.prevCloseCents);

  const marketValue = priceCents * quantity;
  const pnl = marketValue - costBasisCents;
  const ratio = costBasisCents > 0 ? pnl / costBasisCents : null;
  const direction = priceDirection(pnl);

  return (
    <li>
      <Link
        to={`/trade/${instrument.symbol}`}
        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-navy-50 sm:px-6"
      >
        <div className="min-w-0">
          <p className="flex items-baseline gap-2">
            <span className="tnum text-lg font-semibold text-text-primary">
              {instrument.symbol}
            </span>
            {/* truncate + title：超長標的名稱單行省略，滑鼠停留看全名。
                不換行是為了不破壞右側金額的對齊。 */}
            <span className="truncate text-base text-text-secondary" title={instrument.name}>
              {instrument.name}
            </span>
          </p>
          <p className="tnum mt-0.5 text-sm text-text-secondary">
            {formatQuantity(quantity, instrument.lotSize)}
            <span className="mx-1.5 text-text-placeholder">·</span>
            均價 {formatPrice(avgCostCents)}
            <span className="mx-1.5 text-text-placeholder">·</span>
            現價 {formatPrice(priceCents)}
            <FreshnessTag freshness={freshness} />
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p>
            <MoneyText value={marketValue} size="lg" />
          </p>
          <p className="mt-0.5">
            <PriceChange valueCents={pnl} ratio={ratio} />
          </p>
          {/* 三重編碼的第三層：除了顏色與箭頭，連文字都說明方向。
              螢幕閱讀器使用者只會聽到這一句。 */}
          <span className="sr-only">
            {direction === 'up' ? '獲利' : direction === 'down' ? '虧損' : '損益兩平'}
          </span>
        </div>
      </Link>
    </li>
  );
}
