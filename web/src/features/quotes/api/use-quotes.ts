/**
 * web/src/features/quotes/api/use-quotes.ts — 報價的 React 介面
 *
 * 這個檔案是什麼：
 *   把 quote-store（活在 React 之外的 WebSocket store）接進元件的 hooks。
 *
 * 在架構的哪一層：feature 的 api 層。
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { Cents } from '@digital-wealth/shared';

import {
  quoteStore,
  type ConnectionStatus,
  type FeedStatus,
  type QuoteFreshness,
  type StoredQuote,
} from './quote-store';

/**
 * 連線狀態。給「報價中斷」橫幅用。
 *
 * `useSyncExternalStore(subscribe, getSnapshot)` 的兩個參數：
 *   subscribe    告訴 store「有變動時呼叫我」，回傳取消函式
 *   getSnapshot  同步讀出當前值
 *
 * React 會在每次 render 呼叫 getSnapshot 比對，值沒變就不重畫。
 * 所以 getSnapshot **必須回傳穩定的參考** —— 每次回傳新物件的話
 * 會無限重畫。這也是 store 裡把 status 存成字串而不是物件的原因。
 */
export function useQuoteConnection(): ConnectionStatus {
  return useSyncExternalStore(quoteStore.subscribeStatus, quoteStore.getStatus);
}

/**
 * 整個報價來源的狀態。給橫幅用。
 *
 * 跟 useQuoteConnection 的差別：那個只看 WebSocket 通不通，
 * 這個還看「有沒有資料真的流進來」—— market-feed 掛掉時，
 * 連線好好的但一筆報價都沒有。
 */
export function useFeedStatus(): FeedStatus {
  return useSyncExternalStore(quoteStore.subscribeStatus, quoteStore.getFeedStatus);
}

/**
 * 訂閱一組標的的即時報價。
 *
 * 在畫面掛載時訂閱、離開時取消 —— 這就是「只訂閱畫面上看得到的標的」。
 *
 * @param symbols 要訂閱的代號。傳入陣列的**內容**變了才會重新訂閱
 */
export function useQuoteSubscription(symbols: readonly string[]): void {
  // ── 為什麼要 join 成字串當相依 ★ ──────────────────────────────
  //
  //   useEffect 的相依比較是 `Object.is`。陣列每次 render 都是新物件，
  //   即使內容一模一樣也會被判定為「變了」→ 每次 render 都退訂再訂閱，
  //   每秒好幾次。伺服器端會看到訂閱訊息洪水，而畫面上的數字會斷斷續續。
  //
  //   把內容序列化成字串當相依，內容真的變了才會重跑。
  const key = symbols.join(',');

  useEffect(() => {
    if (symbols.length === 0) return;
    return quoteStore.subscribeSymbols(symbols);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key 就是 symbols 的內容指紋
  }, [key]);
}

/**
 * 讀取單一標的的報價。
 *
 * ★ 這個 hook 只會在**這一檔**有新報價時觸發 re-render。
 *   持倉頁有 11 檔，一筆 2330 的報價只重畫那一列。
 */
export function useQuote(symbol: string): {
  quote: StoredQuote | undefined;
  freshness: QuoteFreshness;
} {
  const stored = useSyncExternalStore(
    (listener) => quoteStore.subscribeQuote(symbol, listener),
    () => quoteStore.getQuote(symbol),
  );

  const freshness = quoteStore.getFreshness(symbol);

  return { quote: stored, freshness };
}

/**
 * 取得「現在價格」，並在沒有報價時退回昨收價。
 *
 * ── 這個 fallback 是降級設計的核心 ★ ────────────────────────────
 *
 *   報價斷了，畫面**不該變成空白或 `—`**。持倉市值仍然要算得出來，
 *   使用者仍然要看得到自己有多少錢 —— 只是那個數字是用昨收價算的，
 *   而且必須**明確標示出來**（呼叫端用 freshness 顯示「延遲」或
 *   「報價中斷」）。
 *
 *   PROJECT.md 的原則寫得很清楚：「報價斷了，其他功能仍要能用」。
 *   顯示過期資料而不說，跟顯示錯誤資料一樣糟；
 *   但因為資料過期就整片空白，是更糟的第三種選擇。
 *
 * @param symbol 標的代號
 * @param prevCloseCents 昨收價，報價還沒到時的替代值
 */
export function useLivePrice(
  symbol: string,
  prevCloseCents: Cents | number,
): { priceCents: number; freshness: QuoteFreshness; isFallback: boolean } {
  const { quote, freshness } = useQuote(symbol);

  return useMemo(
    () => ({
      priceCents: quote?.quote.priceCents ?? prevCloseCents,
      freshness,
      isFallback: quote === undefined,
    }),
    [quote, prevCloseCents, freshness],
  );
}

/**
 * 用即時報價算出持倉的總市值。
 *
 * ── 為什麼市值由前端算，而不是後端回傳 ★ ───────────────────────
 *
 *   這是 docs/00-architecture.md 定義的「權威值 vs 衍生值」界線：
 *
 *     權威值   後端擁有，前端只能讀。現金餘額、持股股數、成本基礎。
 *              這些東西改變的唯一途徑是交易，而交易由後端執行。
 *
 *     衍生值   由權威值 ＋ 即時資料算出來。市值 = 股數 × 現價。
 *              現價每秒都在動，如果讓後端算，每跳一次報價就要
 *              重打一次 API —— 那等於把 WebSocket 退化成輪詢。
 *
 *   所以規則是：**會隨報價變動的東西，一律在前端算。**
 *
 * @param positions 持倉清單
 * @returns 總市值（分），以及是否有任何一檔是用昨收價替代的
 */
export function useLiveMarketValue(
  positions: readonly { instrument: { symbol: string; prevCloseCents: Cents }; quantity: number }[],
): { marketValueCents: number; hasFallback: boolean } {
  // 訂閱「任何一檔有變動」。回傳版本號（整數）而不是算好的總和 ——
  // 理由見 quote-store.ts 的 version 欄位說明。
  useSyncExternalStore(quoteStore.subscribeAny, quoteStore.getVersion);

  let marketValueCents = 0;
  let hasFallback = false;

  for (const position of positions) {
    const stored = quoteStore.getQuote(position.instrument.symbol);
    if (!stored) hasFallback = true;

    const price = stored?.quote.priceCents ?? position.instrument.prevCloseCents;
    marketValueCents += price * position.quantity;
  }

  return { marketValueCents, hasFallback };
}
