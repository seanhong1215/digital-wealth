/**
 * web/src/shared/ui/index.tsx — 基礎元件
 *
 * 這個檔案是什麼：
 *   跨 feature 共用的無業務邏輯元件。它們只認識 design token，
 *   不認識「投組」「委託」這些概念。
 *
 * 在架構的哪一層：
 *   最底層的顯示元件。features/ 底下的元件會用它們組裝出業務畫面。
 *
 * 為什麼放在同一個檔案：
 *   MVP 階段總共八個小元件，拆成八個檔案只會讓人一直在檔案間跳。
 *   哪個元件長到超過 80 行、或開始需要自己的測試時，再拆出去。
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { ApiError } from '../lib/api-client';
import {
  EMPTY_DISPLAY,
  formatMoney,
  formatPercent,
  priceDirection,
  type PriceDirection,
} from '../lib/format';

// ============================================================================
// 版面
// ============================================================================

/** 卡片。手機優先 → 用邊框分隔而不是陰影（陰影在小螢幕會讓密集列表顯得髒）。 */
export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={`rounded-lg border border-border bg-bg-surface ${padded ? 'p-4 sm:p-6' : ''} ${className}`}
    >
      {children}
    </section>
  );
}

/** 區塊標題。 */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-xl font-semibold text-text-primary">{children}</h2>
      {action}
    </div>
  );
}

// ============================================================================
// 按鈕
// ============================================================================

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  // 主要按鈕用靛藍，不是綠色 —— 綠色在台股是「跌」。
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800',
  secondary: 'bg-bg-subtle text-text-primary hover:bg-navy-200 active:bg-navy-300',
  ghost: 'bg-transparent text-text-secondary hover:bg-bg-subtle',
  // 危險操作用玫瑰紅，與漲色紅 #DC2626 刻意區隔。
  danger: 'bg-error text-white hover:brightness-110',
};

export function Button({
  variant = 'primary',
  fullWidth = false,
  loading = false,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  fullWidth?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      {...rest}
      // loading 時也要 disabled —— 只把文字換成「處理中」但按鈕還能點，
      // 是下單重複送出的頭號原因。
      disabled={disabled || loading}
      className={`
        min-h-11 rounded-md px-4 text-base font-medium
        transition-colors duration-100
        disabled:cursor-not-allowed disabled:bg-navy-200 disabled:text-text-disabled
        ${BUTTON_STYLES[variant]}
        ${fullWidth ? 'w-full' : ''}
        ${className}
      `}
    >
      {loading ? '處理中…' : children}
    </button>
  );
}

// ============================================================================
// 表單
// ============================================================================

/**
 * 文字輸入欄位。
 *
 * 錯誤訊息用 `aria-describedby` 綁定，而不是只把紅字放在下面 ——
 * 螢幕閱讀器要唸得出「這個欄位有什麼問題」。
 */
export function Field({
  label,
  error,
  hint,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | null;
  hint?: ReactNode;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-base font-medium text-text-primary">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`
          tnum min-h-11 rounded-md border bg-bg-surface px-3 text-lg
          placeholder:text-text-placeholder
          ${error ? 'border-error' : 'border-border focus:border-indigo-500'}
        `}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-text-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ============================================================================
// 金額與漲跌 ★
// ============================================================================

const DIRECTION_TEXT: Record<PriceDirection, string> = {
  up: 'text-price-up',
  down: 'text-price-down',
  flat: 'text-price-flat',
};

/**
 * 金額顯示。
 *
 * 為什麼要一個元件而不是直接 `{formatMoney(v)}`：
 *   為了強制掛上 `tnum`（等寬數字）和最低字重。金額用細字重、
 *   非等寬數字，是本專案明文禁止的兩件事 —— 包成元件就不會有人忘記。
 */
export function MoneyText({
  value,
  size = 'base',
  signed = false,
  colored = false,
  className = '',
}: {
  value: number | null | undefined;
  size?: 'base' | 'lg' | 'xl' | '3xl' | '4xl';
  /** 是否強制顯示正號（損益用） */
  signed?: boolean;
  /** 是否依正負套用漲跌色 */
  colored?: boolean;
  className?: string;
}) {
  const sizeClass = {
    base: 'text-base',
    lg: 'text-lg',
    xl: 'text-xl',
    '3xl': 'text-3xl',
    '4xl': 'text-4xl',
  }[size];

  // 金額的字重下限是 medium(500)，總資產級距用 bold(700)。
  const weightClass = size === '4xl' ? 'font-bold' : 'font-medium';
  const colorClass = colored ? DIRECTION_TEXT[priceDirection(value)] : '';

  return (
    <span className={`tnum ${sizeClass} ${weightClass} ${colorClass} ${className}`}>
      {formatMoney(value, { signed })}
    </span>
  );
}

/**
 * 漲跌顯示 — 三重編碼 ★
 *
 * ── 為什麼同一個資訊要編碼三次 ────────────────────────────────────
 *
 *   顏色、符號（▲▼）、正負號，三者傳達的是同一件事。看似冗餘，
 *   但它解決兩個真實問題：
 *
 *     1. **色盲**：紅綠色盲約占男性 8%。只靠顏色的話，
 *        這 8% 的使用者完全讀不出漲跌 —— 在金融介面裡這不是
 *        體驗問題，是會讓人做錯決策的問題。
 *
 *     2. **文化差異**：台股紅漲綠跌，歐美相反。看到紅色數字，
 *        習慣美股的人會直覺解讀成「跌」。▲ 沒有這個歧義。
 *
 *   這也是 WCAG 1.4.1「不以顏色作為唯一的視覺傳達方式」的要求。
 */
export function PriceChange({
  valueCents,
  ratio,
  size = 'base',
}: {
  /** 漲跌金額（分） */
  valueCents: number | null | undefined;
  /** 漲跌幅（0.014 = 1.4%）。省略則只顯示金額 */
  ratio?: number | null;
  size?: 'base' | 'lg' | 'xl';
}) {
  const direction = priceDirection(valueCents);
  const arrow = { up: '▲', down: '▼', flat: '—' }[direction];
  const sizeClass = { base: 'text-base', lg: 'text-lg', xl: 'text-xl' }[size];

  if (valueCents === null || valueCents === undefined) {
    return <span className="tnum text-text-secondary">{EMPTY_DISPLAY}</span>;
  }

  return (
    <span className={`tnum inline-flex items-baseline gap-1 font-medium ${DIRECTION_TEXT[direction]} ${sizeClass}`}>
      {/* aria-hidden：符號是給眼睛看的視覺輔助，螢幕閱讀器唸「三角形」
          只會製造噪音 —— 正負號已經表達了同樣的資訊。 */}
      <span aria-hidden="true">{arrow}</span>
      <span>{formatMoney(valueCents, { withCurrency: false, signed: true })}</span>
      {ratio !== undefined && ratio !== null && (
        <span className="text-[0.875em] opacity-90">({formatPercent(ratio)})</span>
      )}
    </span>
  );
}

// ============================================================================
// 狀態
// ============================================================================

/**
 * 骨架屏。
 *
 * 為什麼不用轉圈圈的 spinner：spinner 只說「在忙」，骨架屏還說了
 * 「等一下這裡會出現什麼形狀的東西」。使用者的眼睛可以先就位，
 * 資料到達時的視覺跳動也比較小。
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-bg-subtle ${className}`} aria-hidden="true" />;
}

/** 空狀態。空陣列要顯示這個，不是留一塊空白區域。 */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      <p className="text-lg font-medium text-text-primary">{title}</p>
      {hint && <p className="text-base text-text-secondary">{hint}</p>}
    </div>
  );
}

/**
 * 錯誤狀態。
 *
 * ★ 一定要顯示 traceId。使用者截圖回報時，那串 ID 是唯一能讓你
 *   在後端日誌裡定位到那一次請求的東西 —— 沒有它，「我剛剛下單失敗了」
 *   這句話對除錯毫無幫助。
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null;
  const message = apiError?.message ?? '發生未預期的錯誤';

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-lg font-medium text-error">{message}</p>
      {apiError?.traceId && (
        <p className="text-sm text-text-secondary">
          追蹤碼 <code className="tnum">{apiError.traceId}</code>
        </p>
      )}
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          重試
        </Button>
      )}
    </div>
  );
}

/** 標籤徽章。交易類型、委託狀態用。 */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'success' | 'error';
}) {
  const toneClass = {
    neutral: 'bg-bg-subtle text-text-secondary',
    up: 'bg-price-up-bg text-price-up',
    down: 'bg-price-down-bg text-price-down',
    success: 'bg-success-bg text-success',
    error: 'bg-error-bg text-error',
  }[tone];

  return (
    <span className={`inline-flex shrink-0 rounded-sm px-2 py-0.5 text-sm font-medium ${toneClass}`}>
      {children}
    </span>
  );
}
