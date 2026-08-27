/**
 * web/src/features/quotes/components/QuoteStatus.tsx — 報價狀態的視覺呈現
 *
 * 在架構的哪一層：feature 的元件層。
 *
 * ── 「報價中斷」為什麼是橫幅而不是彈窗 ★ ────────────────────────
 *
 *   彈窗會擋住畫面、需要使用者關掉才能繼續 —— 那等於在說
 *   「報價斷了，所以你什麼都不能做」。但事實正好相反：
 *   持倉、明細、下單都不依賴 WebSocket，通通還能用。
 *
 *   橫幅只是把事實說出來，不打斷任何操作。這就是
 *   「降級是設計的一部分」在 UI 上的樣子。
 */

import type { QuoteFreshness } from '../api/quote-store';
import { useFeedStatus, useQuote } from '../api/use-quotes';

/**
 * 報價異常的橫幅。一切正常時完全不佔空間。
 *
 * ── 兩種異常要用不同的說法 ★ ────────────────────────────────────
 *
 *   disconnected  WebSocket 斷了。系統會自動重連，使用者只需要知道
 *                 「畫面上的價格不是現在的」
 *
 *   stalled       連線好好的，但 market-feed 一筆報價都沒送來。
 *                 從使用者角度看是同一件事（數字不動了），
 *                 但原因不同 —— 訊息裡不該說「正在重新連線」，
 *                 因為根本沒有斷線，重連也修不好。
 *
 *   把兩者合併成一句「報價異常」比較省事，但那會讓訊息變得含糊，
 *   而含糊的錯誤訊息等於沒有訊息。
 *
 * 兩種情況的共同重點都在後半句：**其他功能不受影響**。
 */
export function QuoteFeedBanner() {
  const feed = useFeedStatus();

  if (feed === 'live') return null;

  const message =
    feed === 'disconnected'
      ? { title: '報價連線中斷，正在重新連線。', detail: '畫面上的價格為最後收到的資料。' }
      : { title: '報價來源目前沒有更新。', detail: '畫面上的價格為最後收到的資料。' };

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2"
    >
      <span aria-hidden="true" className="text-warning">
        ⚠
      </span>
      <p className="text-base text-text-primary">
        {message.title}
        <span className="text-text-secondary"> {message.detail}持倉、明細與下單不受影響。</span>
      </p>
    </div>
  );
}

/**
 * 新鮮度標籤。掛在報價數字旁邊。
 *
 * ── 三種狀態要分開講 ────────────────────────────────────────────
 *
 *   live          不顯示任何東西。正常狀態不需要標籤 ——
 *                 每個數字旁邊掛一個綠點只是視覺噪音
 *   stale         「延遲」。連線好好的，只是這檔剛好沒成交
 *   disconnected  「昨收」。連線斷了，這個數字根本不是即時價
 */
export function FreshnessTag({ freshness }: { freshness: QuoteFreshness }) {
  if (freshness === 'live') return null;

  return (
    <span className="ml-1.5 rounded-sm bg-bg-subtle px-1.5 py-0.5 text-xs text-text-secondary">
      {freshness === 'stale' ? '延遲' : '昨收'}
    </span>
  );
}

/**
 * 報價跳動時的閃爍。
 *
 * ── 為什麼閃爍只有 150ms、而且只在漲跌時 ★ ──────────────────────
 *
 *   報價跳動的視覺回饋是券商 App 的標準做法，但很容易做過頭：
 *
 *     · 太久（>300ms）→ 幾檔同時在跳，整個列表變成聖誕樹
 *     · 每次都閃（含平盤）→ 沒有資訊量，只是在閃
 *
 *   150ms 剛好是「眼角餘光注意到，但視線回來時已經恢復」的長度。
 *   而且用背景色而不是文字色 —— 文字閃爍會讓數字本身變得難讀，
 *   而使用者要看的正是那個數字。
 *
 *   `prefers-reduced-motion` 的使用者完全不會看到閃爍
 *   （全域 CSS 已把所有 transition 壓到 0.01ms）。
 */
export function useFlashOnChange(symbol: string): string {
  const { quote } = useQuote(symbol);

  // 用 receivedAt 當 key：同一個時間戳代表沒有新報價。
  // 這裡不用 useState + useEffect 是刻意的 —— 那會多一次 render，
  // 而這個效果純粹是視覺的，交給 CSS animation 就好。
  if (!quote) return '';

  const isRecent = Date.now() - quote.receivedAt < 150;
  if (!isRecent) return '';

  const direction = quote.quote.priceCents - quote.quote.prevCloseCents;
  if (direction === 0) return '';

  return direction > 0 ? 'bg-price-up-bg' : 'bg-price-down-bg';
}
