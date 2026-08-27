/**
 * web/src/routes/trade/OrderResult.tsx — 下單步驟 4：結果
 *
 * 在架構的哪一層：路由層（頁面）。
 *
 * ── 這一頁完全不依賴前端狀態 ★ ────────────────────────────────────
 *
 *   委託 ID 在網址的 query string 裡（`?orderId=...`），畫面上所有
 *   資料都是用它去後端重新查回來的。這帶來三個能力：
 *
 *     1. **重新整理不會白畫面** —— 資料在後端，不在記憶體
 *     2. **連結可以分享** —— 把「下單結果」貼給同事，他打開看得到
 *        （前提是同一個帳號 —— 後端的 WHERE 有 account_id 過濾，
 *          別人開會拿到 404，這正是防 IDOR 的效果）
 *     3. **返回鍵不會回到「送出中」** —— 前一頁用 replace 導航過來
 *
 *   代價是多一次 API 往返（送出時明明已經拿到完整結果了）。
 *   這個取捨是刻意的：換來的是「網址就是完整狀態」。
 */

import { Link, useSearchParams } from 'react-router-dom';

import { useOrder } from '../../features/trading/api/queries';
import { formatDateTime, formatMoney, formatPrice, formatQuantity } from '../../shared/lib/format';
import { Badge, Button, Card, ErrorState, SectionTitle, Skeleton } from '../../shared/ui';
import { useTradeFlow } from './TradeLayout';

export function OrderResult() {
  const [searchParams] = useSearchParams();
  const orderId = searchParams.get('orderId') ?? undefined;
  const { resetFlow } = useTradeFlow();

  const { data, isLoading, error, refetch } = useOrder(orderId);

  if (!orderId) {
    return (
      <Card>
        <ErrorState error={new Error('缺少委託編號')} />
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-4 h-32 w-full" />
      </Card>
    );
  }

  const { order, executions } = data;
  const execution = executions[0];
  const isFilled = order.status === 'FILLED';

  // 實際成交金額由 executions 反推，而不是拿委託的限價再算一次 ——
  // 部分成交或以更好的價格成交時，兩者會不一樣。目前的模擬撮合是
  // 全額限價成交，兩者相同，但用 executions 的寫法才不會在
  // 未來接上真實撮合時算錯。
  const grossCents = execution ? execution.filledPriceCents * execution.filledQuantity : 0;
  const feeCents = execution?.feeCents ?? 0;
  const taxCents = execution?.taxCents ?? 0;
  const netCents =
    order.side === 'BUY' ? grossCents + feeCents + taxCents : grossCents - feeCents - taxCents;

  return (
    <Card>
      <div className="flex items-center gap-3">
        {/* ★ 成功狀態用靛藍，不是綠色。
            綠色在台股語意裡是「下跌」—— 下單成功彈出綠色勾勾，
            在使用者的金融直覺裡是壞消息。這是本設計系統
            解決的最關鍵衝突（見 04-design-system.md）。 */}
        <span
          aria-hidden="true"
          className={`flex size-10 items-center justify-center rounded-full text-xl ${
            isFilled ? 'bg-success-bg text-success' : 'bg-error-bg text-error'
          }`}
        >
          {isFilled ? '✓' : '✕'}
        </span>
        <div>
          <SectionTitle>{isFilled ? '委託已成交' : '委託未成立'}</SectionTitle>
          <p className="-mt-3 text-base text-text-secondary">
            {order.instrument.symbol} {order.instrument.name}
          </p>
        </div>
      </div>

      <dl className="mt-5 flex flex-col gap-3 border-y border-border py-4">
        <Row
          label="買賣別"
          value={
            <Badge tone={order.side === 'BUY' ? 'up' : 'down'}>
              {order.side === 'BUY' ? '買進' : '賣出'}
            </Badge>
          }
        />
        <Row label="成交股數" value={formatQuantity(execution?.filledQuantity ?? order.quantity)} />
        <Row
          label="成交價"
          value={`${formatPrice(execution?.filledPriceCents ?? order.limitPriceCents)} 元／股`}
        />
        <Row label="成交時間" value={formatDateTime(execution?.executedAt ?? order.createdAt)} />
      </dl>

      <dl className="mt-4 flex flex-col gap-2">
        <Row label="股款" value={formatMoney(grossCents)} />
        <Row label="手續費" value={formatMoney(feeCents)} />
        {taxCents > 0 && <Row label="證券交易稅" value={formatMoney(taxCents)} />}
        <div className="mt-1 border-t border-border pt-3">
          <Row
            label={order.side === 'BUY' ? '實付總額' : '實收金額'}
            value={formatMoney(netCents)}
            strong
          />
        </div>
      </dl>

      {/* 委託編號要顯示 —— 使用者要對帳、要客訴、要截圖回報時，
          這串 ID 是唯一能定位到這筆交易的東西。 */}
      <p className="tnum mt-4 text-sm text-text-secondary">
        委託編號 <code className="break-all">{order.id}</code>
      </p>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
        <Button fullWidth onClick={resetFlow} className="sm:w-auto">
          <Link to="/portfolio" className="block">
            回到投資總覽
          </Link>
        </Button>
        <Button variant="secondary" fullWidth onClick={resetFlow} className="sm:w-auto">
          <Link to="/trade" className="block">
            再下一筆
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'text-base font-medium' : 'text-base text-text-secondary'}>
        {label}
      </dt>
      <dd className={`tnum ${strong ? 'text-xl font-semibold' : 'text-lg font-medium'}`}>
        {value}
      </dd>
    </div>
  );
}
