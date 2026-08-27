/**
 * web/src/routes/trade/TradeLayout.tsx — 下單流程的共用狀態
 *
 * 在架構的哪一層：路由層。它是 /trade/* 底下所有步驟的父層。
 *
 * ── 這個檔案存在的唯一理由：草稿要跨步驟共用，但不能持久化 ★ ──────
 *
 *   步驟 2 填的股數與價格，步驟 3 要拿來顯示與送出。所以需要一個
 *   比單一頁面活得久的地方放它。選項有四個：
 *
 *     URL query string  ❌ 網址會變成 ?qty=1000&price=88800，
 *                          而且可以被竄改後分享給別人
 *     localStorage      ❌ 隔天打開瀏覽器跳出「要繼續昨天那筆台積電嗎」，
 *                          但價格早就不是昨天的價格了 —— 那是危險不是體貼
 *     全域 store        ❌ Zustand 是為了「多個不相干的元件共用」，
 *                          這裡只有一條路徑上的四個頁面
 *     ✅ 父路由的 state    活得剛好跟這段流程一樣久，離開就消失
 *
 *   「離開就消失」正是我們要的行為。下單草稿本來就不該被還原 ——
 *   重新整理回到步驟 2 重填，比還原出一筆基於過期價格的委託安全。
 *
 *   詳見 docs/adr/0008。
 *
 * ── idempotencyKey 在這裡產生，時機是「進入確認頁」★ ───────────────
 *
 *   見下方 beginConfirmation() 的說明。這是整個下單流程最容易做錯、
 *   而且錯了不會有任何徵兆的地方。
 */

import { useCallback, useMemo, useState } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';

import type { OrderDraft } from '@fintech/shared';

/**
 * 步驟 2 填好的委託草稿。
 *
 * 直接沿用 shared 的 `OrderDraft` 而不是自己定義一份長得很像的介面 ——
 * 自己定義的話，`limitPriceCents` 會是普通的 number 而不是 branded 的
 * `Cents`，於是「元」和「分」混用時 TypeScript 不會擋。
 * 契約只有一份，這種錯誤才會在編譯期被抓到。
 */
export type TradeDraft = OrderDraft;

interface TradeContext {
  draft: TradeDraft | null;
  /** 步驟 2 → 3：存下草稿並產生冪等鍵 */
  beginConfirmation: (draft: TradeDraft) => void;
  /** 送出時要帶的冪等鍵。尚未進入確認頁時為 null */
  idempotencyKey: string | null;
  /** 流程結束（成功或放棄）時清空 */
  resetFlow: () => void;
}

export function TradeLayout() {
  const [draft, setDraft] = useState<TradeDraft | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  /**
   * 進入確認頁時呼叫。
   *
   * ── 冪等鍵為什麼在**這裡**產生，而不是在按下「送出」時 ★★ ──────
   *
   *   這是整個下單流程最關鍵的一行，而且做錯了完全沒有徵兆 ——
   *   在單人測試下兩種寫法的行為一模一樣。
   *
   *     ❌ 在送出時產生
   *        使用者在確認頁連點送出 3 次
   *        → 產生 3 把不同的 key
   *        → 後端看到的是 3 筆完全合法的、不同的委託
   *        → 成交 3 筆，扣 3 次錢
   *        冪等機制形同虛設，但它「有在運作」，所以不會有人發現。
   *
   *     ✅ 在進入確認頁時產生一次
   *        連點 3 次帶的都是同一把 key
   *        → 後端第 1 次受理，第 2、3 次回 409 DUPLICATE_REQUEST
   *        → 前端把 409 靜默處理成「已經成功了」
   *
   *   換句話說：**冪等鍵的正確性是前端的責任。** 後端只能防重放，
   *   防不了前端亂發新 key。
   *
   *   `crypto.randomUUID()` 是瀏覽器原生 API，不需要 uuid 套件。
   *   它只在 HTTPS 或 localhost 下可用 —— 兩者都涵蓋本專案的情境。
   */
  const beginConfirmation = useCallback((next: TradeDraft) => {
    setDraft(next);
    setIdempotencyKey(crypto.randomUUID());
  }, []);

  const resetFlow = useCallback(() => {
    setDraft(null);
    setIdempotencyKey(null);
  }, []);

  const context = useMemo<TradeContext>(
    () => ({ draft, beginConfirmation, idempotencyKey, resetFlow }),
    [draft, beginConfirmation, idempotencyKey, resetFlow],
  );

  return (
    <div className="flex flex-col gap-4">
      <Outlet context={context} />
    </div>
  );
}

/** 子路由取用流程狀態的入口。 */
export function useTradeFlow(): TradeContext {
  return useOutletContext<TradeContext>();
}
