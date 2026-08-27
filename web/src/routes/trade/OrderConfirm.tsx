/**
 * web/src/routes/trade/OrderConfirm.tsx — 下單步驟 3：確認
 *
 * 在架構的哪一層：路由層（頁面）。
 *
 * ── 這一頁為什麼存在 ──────────────────────────────────────────────
 *
 *   多一個步驟就多一次流失，一般產品能省則省。但下單的兩個特性
 *   讓它值得：
 *
 *     1. **不可逆** —— 成交了就是成交了，沒有「取消訂單」
 *     2. **費用不直觀** —— 使用者輸入的是「1000 股 @ 888」，
 *        實際扣款是 889,265 元。那 1,265 元的手續費必須在
 *        按下確認**之前**被看到
 *
 *   而且次要使用者是 55 歲以上族群，「關鍵操作二次確認」是
 *   PROJECT.md 明列的設計要求。
 *
 * ── 三個容易做錯的地方 ★ ─────────────────────────────────────────
 *
 *   1. 費用必須用**後端試算**的數字，不是前端自己算的
 *   2. 送出中必須把按鈕 disabled（loading 狀態），否則連點
 *   3. 收到 409 DUPLICATE_REQUEST **不能顯示錯誤** —— 見下方說明
 */

import { Navigate, useNavigate, useParams } from 'react-router-dom';

import { useAccount } from '../../features/portfolio/api/queries';
import { useCreateOrder, useOrderPreview } from '../../features/trading/api/queries';
import { ApiError } from '../../shared/lib/api-client';
import { formatMoney, formatPrice, formatQuantity } from '../../shared/lib/format';
import { Button, Card, ErrorState, SectionTitle, Skeleton } from '../../shared/ui';
import { useTradeFlow } from './TradeLayout';

export function OrderConfirm() {
  const { symbol } = useParams<{ symbol: string }>();
  const navigate = useNavigate();
  const { draft, idempotencyKey } = useTradeFlow();

  const accountQuery = useAccount();
  const preview = useOrderPreview(draft);
  const createOrder = useCreateOrder();

  // ── 直接開這個網址、或重新整理，草稿就沒了 ────────────────────
  //
  // 這不是 bug，是 adr/0008 的決策：下單草稿不持久化。
  // 送他回步驟 2 重填，比讓他基於一個來路不明的草稿下單安全。
  if (!draft || !idempotencyKey) {
    return <Navigate to={`/trade/${symbol ?? ''}`} replace />;
  }

  const handleSubmit = () => {
    createOrder.mutate(
      { ...draft, idempotencyKey },
      {
        onSuccess: (result) => {
          navigate(`/trade/${draft.symbol}/result?orderId=${result.order.id}`, { replace: true });
        },
      },
    );
  };

  // ── 錯誤分流 ★ ────────────────────────────────────────────────
  //
  // 「技術上的錯誤」不等於「該讓使用者看到的錯誤」。
  //
  // 409 DUPLICATE_REQUEST 代表這把冪等鍵已經成立過一筆委託 ——
  // 使用者連點了兩下，第一次已經成功。從他的角度看，他只是點了兩下，
  // 顯示「這筆委託已經送出過了」只會讓他困惑「所以到底成立了沒？」
  //
  // 正確處理是靜默地帶他去看結果。但這裡有個現實限制：後端目前
  // 只回錯誤碼，不回原本那筆的 orderId，所以無法直接跳到結果頁。
  // 折衷做法是顯示一則**中性的提示**（不是紅色錯誤），
  // 引導他去交易明細確認 —— 而不是讓他以為下單失敗又再點一次。
  const error = createOrder.error;
  const isDuplicate = error instanceof ApiError && error.code === 'DUPLICATE_REQUEST';
  const businessError = error instanceof ApiError && !isDuplicate ? error : null;

  return (
    <Card>
      <SectionTitle>確認委託</SectionTitle>

      <dl className="flex flex-col gap-3 border-y border-border py-4">
        <Row label="標的" value={draft.symbol} />
        <Row
          label="買賣別"
          value={
            <span
              className={draft.side === 'BUY' ? 'text-price-up' : 'text-price-down'}
            >
              {draft.side === 'BUY' ? '買進' : '賣出'}
            </span>
          }
        />
        <Row label="股數" value={formatQuantity(draft.quantity)} />
        <Row label="限價" value={`${formatPrice(draft.limitPriceCents)} 元／股`} />
      </dl>

      {/* ── 費用明細 ★ ────────────────────────────────────────────
          這些數字來自 POST /orders/preview，是**後端算的**。
          前端當然也能用同一個 calculateTradeCost() 算出一樣的結果，
          但權威來源只能有一個。前一頁的「預估」是給人參考的，
          這一頁的數字是實際會扣的錢。 */}
      <div className="mt-4">
        {preview.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : preview.error ? (
          <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        ) : preview.data ? (
          <dl className="flex flex-col gap-2">
            <Row label="股款" value={formatMoney(preview.data.grossCents)} />
            <Row label="手續費" value={formatMoney(preview.data.feeCents)} />
            {preview.data.taxCents > 0 && (
              <Row label="證券交易稅" value={formatMoney(preview.data.taxCents)} />
            )}
            <div className="mt-1 border-t border-border pt-3">
              <Row
                label={draft.side === 'BUY' ? '應付總額' : '實收金額'}
                value={formatMoney(preview.data.netCents)}
                strong
              />
            </div>
          </dl>
        ) : null}
      </div>

      {accountQuery.data && (
        <p className="tnum mt-3 text-sm text-text-secondary">
          可用餘額 {formatMoney(accountQuery.data.cashBalanceCents)}
        </p>
      )}

      {/* 業務規則拒絕：紅底提示，並把後端算好的差額顯示出來。
          「還差 586,063 元」比「餘額不足」有用得多 ——
          前者告訴使用者要怎麼做，後者只是陳述失敗。 */}
      {businessError && (
        <div role="alert" className="mt-4 rounded-md bg-error-bg px-3 py-3">
          <p className="text-base font-medium text-error">{businessError.message}</p>
          <ShortfallHint error={businessError} />
          {businessError.traceId && (
            <p className="tnum mt-1.5 text-xs text-text-secondary">
              追蹤碼 {businessError.traceId}
            </p>
          )}
        </div>
      )}

      {/* 冪等重複：中性提示，不是錯誤。刻意不用紅色。 */}
      {isDuplicate && (
        <div role="status" className="mt-4 rounded-md bg-bg-subtle px-3 py-3">
          <p className="text-base text-text-primary">
            這筆委託已經送出過了，重複點擊不會再成立一筆。
          </p>
          <button
            onClick={() => navigate('/transactions')}
            className="mt-1.5 text-base font-medium text-indigo-600 hover:underline"
          >
            到交易明細確認 →
          </button>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
        <Button
          fullWidth
          loading={createOrder.isPending}
          // 試算還沒回來就不能送 —— 使用者必須先看到實際費用。
          disabled={!preview.data || isDuplicate}
          onClick={handleSubmit}
        >
          確認送出
        </Button>
        <Button
          variant="secondary"
          fullWidth
          disabled={createOrder.isPending}
          onClick={() => navigate(-1)}
        >
          返回修改
        </Button>
      </div>
    </Card>
  );
}

/**
 * 餘額／持股不足時，把後端算好的差額顯示出來。
 *
 * 差額是後端在 details 裡給的，不是前端自己減 —— 前端減會有
 * 「忘記這是分不是元」這種錯誤，而且後端本來就已經算好了。
 */
function ShortfallHint({ error }: { error: ApiError }) {
  const details = error.details ?? {};

  if (error.code === 'INSUFFICIENT_FUNDS' && typeof details.shortfallCents === 'number') {
    return (
      <p className="tnum mt-1 text-base text-error">
        還差 {formatMoney(details.shortfallCents)}
      </p>
    );
  }

  if (error.code === 'INSUFFICIENT_POSITION' && typeof details.availableQuantity === 'number') {
    return (
      <p className="tnum mt-1 text-base text-error">
        目前可賣 {formatQuantity(details.availableQuantity)}
      </p>
    );
  }

  return null;
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
