/**
 * web/src/routes/trade/OrderForm.tsx — 下單步驟 2：填寫委託
 *
 * 在架構的哪一層：路由層（頁面）。
 *
 * ── 這一頁的驗證用 shared 的市場規則，不是自己寫 if ★ ─────────────
 *
 *   漲跌停 ±10%、跳動單位分六個級距、手續費 0.1425% 最低 20 元 ——
 *   這些規則後端要用（擋非法委託）、前端要用（即時提示）、
 *   seed 也要用（產生合法的歷史資料）。
 *
 *   三個地方各寫一次的話，總有一天會有一個地方漏改。所以它們全部
 *   住在 shared/market-rules.ts，三邊 import 同一份。
 *
 *   這就是 adr/0002 選 NestJS 而不是 Spring Boot 的實際收益：
 *   不是「TypeScript 比較潮」，而是**業務規則可以只寫一次**。
 */

import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  alignToTick,
  calculateTradeCost,
  cents,
  isValidTick,
  isWithinPriceLimits,
  priceLimits,
  tickSize,
  type OrderSideValue,
} from '@fintech/shared';

import { useAccount, usePositions } from '../../features/portfolio/api/queries';
import { useLivePrice, useQuoteSubscription } from '../../features/quotes/api/use-quotes';
import {
  FreshnessTag,
  QuoteFeedBanner,
} from '../../features/quotes/components/QuoteStatus';
import { useInstrument } from '../../features/trading/api/queries';
import { formatMoney, formatPrice, formatQuantity } from '../../shared/lib/format';
import { Button, Card, ErrorState, Field, SectionTitle, Skeleton } from '../../shared/ui';
import { useTradeFlow } from './TradeLayout';

export function OrderForm() {
  const { symbol } = useParams<{ symbol: string }>();
  const navigate = useNavigate();
  const { beginConfirmation } = useTradeFlow();

  const instrumentQuery = useInstrument(symbol);
  const accountQuery = useAccount();
  const positionsQuery = usePositions();

  // 只訂閱當前這一檔。useMemo 讓陣列參考穩定，避免反覆退訂／訂閱。
  const watched = useMemo(() => (symbol ? [symbol] : []), [symbol]);
  useQuoteSubscription(watched);

  const [side, setSide] = useState<OrderSideValue>('BUY');
  const [quantityInput, setQuantityInput] = useState('1000');
  const [priceInput, setPriceInput] = useState('');

  const instrument = instrumentQuery.data;
  const live = useLivePrice(symbol ?? '', instrument?.prevCloseCents ?? 0);

  // ── 價格預設帶「現價」，不是昨收價 ★ ──────────────────────────
  //
  //   使用者要下的是現在這個價格附近的單，預設帶昨收會讓他每次
  //   都得先改一次。帶現價則多數情況直接按下一步就好。
  //
  //   ⚠️ 但這裡有個陷阱：現價每 800ms 就變一次。如果無條件跟著跳，
  //      使用者打到一半的數字會被蓋掉 —— 那是會讓人想砸鍵盤的 bug。
  //
  //   所以只在「使用者還沒碰過這個欄位」（priceInput === ''）時
  //   才顯示現價。一旦他輸入任何東西，欄位就完全歸他控制。
  //
  //   用衍生值而不是 useEffect + setState 也是同一個理由：
  //   effect 會在報價變動時把值塞回欄位，正是我們要避免的行為。
  const priceValue =
    priceInput !== '' ? priceInput : live.priceCents > 0 ? (live.priceCents / 100).toFixed(2) : '';

  if (instrumentQuery.error) {
    return (
      <Card>
        <ErrorState error={instrumentQuery.error} onRetry={() => void instrumentQuery.refetch()} />
      </Card>
    );
  }

  if (!instrument) {
    return (
      <Card>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-4 h-11 w-full" />
        <Skeleton className="mt-3 h-11 w-full" />
      </Card>
    );
  }

  // ── 解析與驗證 ────────────────────────────────────────────────
  //
  // 注意這裡全程用「分」計算，只在最後顯示時才轉成元。
  // 價格輸入 "888.5" → 88850 分。用 Math.round 是因為
  // 888.5 * 100 在浮點數下可能是 88849.999…（見 adr/0005）。
  const quantity = Number.parseInt(quantityInput, 10);
  const priceMajor = Number.parseFloat(priceValue);
  const priceCents = Number.isFinite(priceMajor) ? cents(Math.round(priceMajor * 100)) : null;

  const limits = priceLimits(instrument.prevCloseCents);
  const heldQuantity =
    positionsQuery.data?.find((p) => p.instrument.symbol === instrument.symbol)?.quantity ?? 0;

  const quantityError =
    quantityInput === ''
      ? null
      : !Number.isInteger(quantity) || quantity <= 0
        ? '股數必須是正整數'
        : side === 'SELL' && quantity > heldQuantity
          ? `持股不足，目前持有 ${formatQuantity(heldQuantity, instrument.lotSize)}`
          : null;

  const priceError =
    priceCents === null || priceCents <= 0
      ? priceValue === ''
        ? null
        : '請輸入合法價格'
      : !isValidTick(priceCents)
        ? `非法的升降單位。此價位每檔 ${formatPrice(tickSize(priceCents))} 元，最接近的合法價是 ${formatPrice(alignToTick(priceCents))}`
        : !isWithinPriceLimits(priceCents, instrument.prevCloseCents)
          ? `超出今日漲跌停（${formatPrice(limits.lower)} – ${formatPrice(limits.upper)}）`
          : null;

  const isValid =
    quantityError === null &&
    priceError === null &&
    Number.isInteger(quantity) &&
    quantity > 0 &&
    priceCents !== null &&
    priceCents > 0;

  // 即時試算給使用者一個概念。權威值仍然由後端在確認頁提供 ——
  // 這裡只是「大約多少錢」的預覽，用的是同一個 calculateTradeCost()。
  const estimate = isValid ? calculateTradeCost(priceCents, quantity, side) : null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!isValid || priceCents === null) return;

    // 產生冪等鍵的時機就是這裡 —— 進入確認頁的那一刻，不是按送出時。
    // 理由見 TradeLayout.tsx 的說明。
    beginConfirmation({
      symbol: instrument.symbol,
      side,
      orderType: 'LIMIT',
      quantity,
      limitPriceCents: priceCents,
    });

    navigate(`/trade/${instrument.symbol}/confirm`);
  };

  return (
    <>
      <QuoteFeedBanner />
      <Card>
      <SectionTitle
        action={
          <Link to="/trade" className="px-2 py-1 text-base text-text-secondary hover:underline">
            換標的
          </Link>
        }
      >
        {instrument.symbol} {instrument.name}
      </SectionTitle>

      <div className="-mt-2 mb-4">
        <p className="tnum flex flex-wrap items-baseline gap-x-2 text-base">
          <span className="text-text-secondary">現價</span>
          <span
            className={`text-xl font-semibold ${
              live.priceCents > instrument.prevCloseCents
                ? 'text-price-up'
                : live.priceCents < instrument.prevCloseCents
                  ? 'text-price-down'
                  : 'text-price-flat'
            }`}
          >
            {formatPrice(live.priceCents)}
          </span>
          <FreshnessTag freshness={live.freshness} />
        </p>
        <p className="tnum mt-1 text-sm text-text-secondary">
          昨收 {formatPrice(instrument.prevCloseCents)}
          <span className="mx-1.5 text-text-placeholder">·</span>
          漲跌停 {formatPrice(limits.lower)} – {formatPrice(limits.upper)}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* ── 買賣切換 ────────────────────────────────────────────
            用大面積的分段控制而不是下拉選單。買和賣的後果完全相反，
            這是整個表單最不能點錯的地方，值得佔一整排空間。 */}
        <fieldset>
          <legend className="mb-1.5 text-base font-medium">買賣別</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['BUY', 'SELL'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSide(option)}
                aria-pressed={side === option}
                className={`min-h-11 rounded-md border text-lg font-semibold transition-colors ${
                  side === option
                    ? option === 'BUY'
                      ? 'border-price-up bg-price-up-bg text-price-up'
                      : 'border-price-down bg-price-down-bg text-price-down'
                    : 'border-border bg-bg-surface text-text-secondary hover:bg-bg-subtle'
                }`}
              >
                {option === 'BUY' ? '買進' : '賣出'}
              </button>
            ))}
          </div>
        </fieldset>

        <Field
          id="quantity"
          label="股數"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={quantityInput}
          onChange={(e) => setQuantityInput(e.target.value)}
          error={quantityError}
          hint={
            side === 'SELL'
              ? `目前持有 ${formatQuantity(heldQuantity, instrument.lotSize)}`
              : `1 張 = ${instrument.lotSize.toLocaleString('zh-TW')} 股，可下零股`
          }
        />

        <Field
          id="price"
          label="限價（每股）"
          type="number"
          inputMode="decimal"
          step={tickSize(instrument.prevCloseCents) / 100}
          value={priceValue}
          onChange={(e) => setPriceInput(e.target.value)}
          error={priceError}
          hint={`每檔 ${formatPrice(tickSize(instrument.prevCloseCents))} 元`}
        />

        {/* 預估金額。標明「預估」是因為權威值在下一頁由後端算 ——
            前端算的數字只用來讓使用者判斷「要不要繼續」。 */}
        {estimate && (
          <dl className="flex flex-col gap-1.5 rounded-md bg-bg-subtle px-3 py-3 text-base">
            <Row label="股款" value={formatMoney(estimate.gross)} />
            <Row label="預估手續費" value={formatMoney(estimate.fee)} />
            {estimate.tax > 0 && <Row label="預估證交稅" value={formatMoney(estimate.tax)} />}
            <div className="mt-1 border-t border-border pt-1.5">
              <Row
                label={side === 'BUY' ? '預估支付' : '預估實收'}
                value={formatMoney(estimate.net)}
                strong
              />
            </div>
          </dl>
        )}

        {accountQuery.data && (
          <p className="tnum text-sm text-text-secondary">
            可用餘額 {formatMoney(accountQuery.data.cashBalanceCents)}
          </p>
        )}

        <Button type="submit" fullWidth disabled={!isValid}>
          下一步 · 確認委託
        </Button>
      </form>
      </Card>
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-medium' : 'text-text-secondary'}>{label}</dt>
      <dd className={`tnum ${strong ? 'text-lg font-semibold' : 'font-medium'}`}>{value}</dd>
    </div>
  );
}
