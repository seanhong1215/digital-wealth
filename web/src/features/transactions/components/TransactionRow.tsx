/**
 * web/src/features/transactions/components/TransactionRow.tsx — 明細單列
 *
 * 在架構的哪一層：feature 的元件層。
 *
 * 從頁面抽出來的理由：虛擬滾動的容器（TransactionList）需要它，
 * 而頁面本身只負責篩選與狀態組裝。一列長什麼樣子是這一層的事。
 *
 * ★ 這個元件必須保持「輕」—— 虛擬滾動下它每秒會被建立與銷毀好幾十次。
 *   任何昂貴的計算（日期解析、金額格式化）都已經是純函式，
 *   不要在這裡加 useEffect 或訂閱。
 */

import type { Transaction, TransactionType } from '@digital-wealth/shared';

import { formatPrice, formatQuantity, formatRelativeTime } from '../../../shared/lib/format';
import { Badge, MoneyText } from '../../../shared/ui';

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

export function TransactionRow({ transaction }: { transaction: Transaction }) {
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
