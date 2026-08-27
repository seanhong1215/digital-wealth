/**
 * web/src/features/transactions/components/TransactionList.tsx — 虛擬滾動的明細列表
 *
 * 在架構的哪一層：feature 的元件層。
 *
 * ── 虛擬滾動要解決什麼問題 ★ ────────────────────────────────────
 *
 *   `heavy-history` 情境有 8,000 筆明細。全部渲染出來的話：
 *
 *     · **8,000 個 <li>，每個裡面約 10 個 DOM 節點 → 8 萬個節點**
 *     · 瀏覽器要為每一個計算樣式與版面 —— 首次渲染會卡住主執行緒
 *       好幾秒，期間頁面完全不能動
 *     · 記憶體佔用以百 MB 計
 *     · 之後每一次重新渲染（例如篩選變更）都要再付一次
 *
 *   虛擬滾動的想法很簡單：**螢幕上放得下的只有十幾列，那就只渲染十幾列。**
 *   用一個高度等於「全部列數 × 列高」的容器撐出正確的捲軸長度，
 *   然後根據捲動位置，把那十幾列用絕對定位擺到該出現的地方。
 *
 *   結果是 DOM 節點數從 8 萬降到約 150，而且**與資料筆數無關** ——
 *   8,000 筆和 80,000 筆的渲染成本一樣。
 *
 * ── 為什麼用 useWindowVirtualizer 而不是容器捲動 ────────────────
 *
 *   TanStack Virtual 有兩種模式：
 *
 *     容器捲動   列表自己是一個固定高度的捲動區域（overflow: auto）
 *     視窗捲動   ✅ 整個頁面捲動，列表只是頁面的一部分
 *
 *   選視窗捲動的理由是**手機**：頁面內再套一個捲動區域，會出現
 *   「捲到列表底部之後手指要抬起來再捲一次頁面」的斷裂感，
 *   而且 iOS 的橡皮筋效果會讓兩層捲動互相打架。
 *
 *   代價是要告訴 virtualizer「列表距離頁面頂端多遠」（scrollMargin），
 *   否則它會以為列表從螢幕頂端開始，位置全部算錯。
 */

import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Transaction } from '@digital-wealth/shared';

import { TransactionRow } from './TransactionRow';

/**
 * 每一列的預估高度（px）。
 *
 * 這只是**初始猜測** —— 實際高度由 measureElement 量出來。
 * 猜得準的好處是捲軸長度一開始就接近正確，捲動時不會抖動；
 * 猜得離譜的話，使用者快速拖捲軸會看到內容位置跳來跳去。
 *
 * 72px 是實測「兩行文字 + 上下 padding」的高度。
 */
const ESTIMATED_ROW_HEIGHT = 72;

/**
 * 捲到剩幾列時開始載入下一頁。
 *
 * 太小（例如 1）：使用者會捲到底看到空白，等資料進來
 * 太大（例如 25）：一次捲動觸發好幾頁的載入，浪費頻寬
 * 8 列大約是一個螢幕高度，剛好在使用者看到底部之前就備好了
 */
const LOAD_MORE_THRESHOLD = 8;

export function TransactionList({
  items,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  items: Transaction[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // ── 量出列表距離頁面頂端的距離 ★ ────────────────────────────────
  //
  //   useWindowVirtualizer 是以「整個頁面」的捲動位置在算的，
  //   但列表上面還有導覽列、標題、篩選鈕。少了這個偏移量，
  //   virtualizer 會以為捲動 0px 時列表第一列在螢幕頂端，
  //   於是每一列的位置都會往上偏移一整個頁首的高度。
  //
  //   用 useLayoutEffect 而不是 useEffect：它在瀏覽器繪製**之前**執行，
  //   所以使用者不會看到「先錯位、下一幀才修正」的閃動。
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;

    const measure = () => setScrollMargin(element.offsetTop);
    measure();

    // 視窗寬度變化會讓上方內容換行，偏移量跟著變。
    // ResizeObserver 比 window.resize 精準 —— 它連「內容自己變高」
    // （例如報價中斷橫幅出現）都抓得到。
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  const virtualizer = useWindowVirtualizer({
    // 還有下一頁時多算一列，那一列用來顯示「載入中」。
    count: hasNextPage ? items.length + 1 : items.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    scrollMargin,
    // 上下各多渲染 5 列。快速捲動時，這幾列讓畫面不會先出現空白
    // 再補上內容 —— 這是虛擬滾動最常被抱怨的視覺瑕疵。
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // ── 捲到接近底部時自動載入下一頁 ──────────────────────────────
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;

    if (last.index >= items.length - LOAD_MORE_THRESHOLD && hasNextPage && !isFetchingNextPage) {
      onLoadMore();
    }
  }, [virtualItems, items.length, hasNextPage, isFetchingNextPage, onLoadMore]);

  return (
    <div ref={listRef} className="border-t border-border">
      {/*
        外層 div 的高度 = 全部列數 × 列高。
        它什麼都不顯示，唯一的用途是把頁面的捲軸「撐」到正確長度 ——
        使用者才會覺得自己在捲一個 8,000 筆的列表。
      */}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const isLoaderRow = virtualRow.index >= items.length;
          const transaction = items[virtualRow.index];

          return (
            <div
              key={virtualRow.key}
              // ★ data-index + measureElement 是「動態高度」的關鍵。
              //
              //   估計值只是起點，實際高度取決於內容（超長的標的名稱
              //   會換行）。measureElement 會在每一列渲染後量它的真實高度
              //   並回報給 virtualizer，捲軸長度因此逐步修正到精確值。
              //
              //   沒有這一段的話，所有列都會被硬塞成 72px，
              //   內容較高的列會被裁掉。
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                // 用 transform 而不是 top 來定位：transform 只觸發
                // 合成（composite），不會引起版面重算（layout）。
                // 捲動時每一幀都在改這個值，差別很明顯。
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {isLoaderRow ? (
                <p className="px-4 py-6 text-center text-base text-text-secondary sm:px-6">
                  載入更多…
                </p>
              ) : transaction ? (
                <div className="border-b border-border">
                  <TransactionRow transaction={transaction} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
