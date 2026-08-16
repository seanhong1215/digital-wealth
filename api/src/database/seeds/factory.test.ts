/**
 * api/src/database/seeds/factory.test.ts — 種子資料自洽性測試
 *
 * 這支測試在驗證什麼：
 *   **不是**「資料有沒有產生出來」，而是「產生出來的資料互相對得上嗎」。
 *
 * 為什麼這是本專案最有價值的測試之一：
 *   假資料的破綻不會讓程式當掉，只會讓面試官在心算之後皺眉。
 *   而破綻的形式很固定，就是下面這幾條「應該恆成立」的關係：
 *
 *     1. 每一筆流水的結餘 = 前一筆結餘 + 這筆金額
 *     2. 帳戶餘額 = 最後一筆流水的結餘
 *     3. 持倉的平均成本 = 由明細重算出來的加權平均
 *     4. 快照的總資產 = 當天現金 + 當天持股市值
 *
 *   把這些關係寫成測試之後，任何破壞自洽性的改動都會立刻被抓到 ——
 *   而不是等到 demo 當天被面試官抓到。
 *
 * ── 測試為什麼要傳入固定的 today ────────────────────────────────────
 *
 *   factory 預設用「現在」當基準（相對時間規則）。測試如果也用現在，
 *   結果會隨執行日期而變 —— 週末跑跟平日跑的交易日數量就不同。
 *   傳入固定日期讓測試本身也是可重現的。
 */

import { describe, expect, it } from 'vitest';

import { cents, isValidTick, weightedAverageCost, type Cents } from '@fintech/shared';

import { buildSeedData, type AccountScenario, type SeedTransaction } from './factory.js';

/** 固定的基準日，讓測試結果不隨執行日期改變。挑週三避開週末的邊界。 */
const FIXED_TODAY = new Date(Date.UTC(2026, 7, 12)); // 2026-08-12（週三）

/** 預設種子。與 seed.ts 的預設值一致，測的就是實際會產生的那份資料。 */
const SEED = 42;

describe('buildSeedData() — 決定性', () => {
  it('★ 同一組（情境、種子）產生完全相同的資料', () => {
    // 這是「demo 重整之後數字不會變」的保證。
    // 如果哪天有人在 factory 裡偷用了 Math.random() 或 Date.now()，
    // 這個測試會立刻失敗。
    const first = buildSeedData('active', SEED, FIXED_TODAY);
    const second = buildSeedData('active', SEED, FIXED_TODAY);

    expect(second.cashBalanceCents).toBe(first.cashBalanceCents);
    expect(second.transactions.length).toBe(first.transactions.length);
    expect(JSON.stringify(second.positions)).toBe(JSON.stringify(first.positions));
    expect(JSON.stringify(second.snapshots)).toBe(JSON.stringify(first.snapshots));
  });

  it('不同種子產生不同的資料（否則種子參數就是假的）', () => {
    const a = buildSeedData('active', 1, FIXED_TODAY);
    const b = buildSeedData('active', 2, FIXED_TODAY);

    expect(b.cashBalanceCents).not.toBe(a.cashBalanceCents);
  });
});

describe('buildSeedData() — 帳務自洽性', () => {
  const data = buildSeedData('active', SEED, FIXED_TODAY);

  it('★ 每一筆流水的結餘 = 前一筆結餘 + 這筆金額', () => {
    // 這是 balance_after_cents 這個欄位存在的全部意義 ——
    // 讓每一筆異動都能獨立驗證，對帳時不用重算整個歷史。
    let previousBalance = 0;

    for (const [index, tx] of data.transactions.entries()) {
      expect(
        tx.balanceAfterCents,
        `第 ${index} 筆（${tx.type}｜${tx.description}）的結餘對不上`,
      ).toBe(previousBalance + tx.amountCents);
      previousBalance = tx.balanceAfterCents;
    }
  });

  it('帳戶最終餘額 = 最後一筆流水的結餘', () => {
    const last = data.transactions.at(-1);
    expect(last).toBeDefined();
    expect(data.cashBalanceCents).toBe(last?.balanceAfterCents);
  });

  it('結餘永遠不為負（資料庫的 CHECK 約束會擋，這裡先擋一次）', () => {
    for (const tx of data.transactions) {
      expect(tx.balanceAfterCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('流水時間不遞減 —— 否則按時間排序後結餘序列會亂掉', () => {
    for (let i = 1; i < data.transactions.length; i += 1) {
      const previous = data.transactions[i - 1]!.occurredAt.getTime();
      const current = data.transactions[i]!.occurredAt.getTime();
      expect(current, `第 ${i} 筆的時間比前一筆早`).toBeGreaterThanOrEqual(previous);
    }
  });
});

describe('buildSeedData() — 持倉與明細對得上', () => {
  const data = buildSeedData('active', SEED, FIXED_TODAY);

  /**
   * 從交易明細獨立重算持倉。
   *
   * 刻意**不看** `data.positions`，完全從 transactions 重建。
   * 這模擬的正是面試官的動作：打開明細，自己加一遍，看跟持倉頁對不對。
   */
  function rebuildPositionsFromTransactions(
    transactions: readonly SeedTransaction[],
  ): Map<string, { quantity: number; avgCostCents: Cents }> {
    const rebuilt = new Map<string, { quantity: number; avgCostCents: Cents }>();

    for (const tx of transactions) {
      if (tx.symbol === null || tx.quantity === null || tx.priceCents === null) continue;

      if (tx.type === 'BUY') {
        const existing = rebuilt.get(tx.symbol);
        if (existing && existing.quantity > 0) {
          existing.avgCostCents = weightedAverageCost(
            existing.quantity,
            existing.avgCostCents,
            tx.quantity,
            tx.priceCents,
          );
          existing.quantity += tx.quantity;
        } else {
          rebuilt.set(tx.symbol, { quantity: tx.quantity, avgCostCents: tx.priceCents });
        }
      } else if (tx.type === 'SELL') {
        const existing = rebuilt.get(tx.symbol);
        if (existing) {
          // 賣出只減股數，不動平均成本（賣掉的部分變成已實現損益）。
          existing.quantity -= tx.quantity;
        }
      }
      // DIVIDEND 有 symbol 與 quantity，但不改變持倉，所以不處理。
    }

    return rebuilt;
  }

  it('★ 持倉的股數，等於由明細重算出來的股數', () => {
    const rebuilt = rebuildPositionsFromTransactions(data.transactions);

    for (const position of data.positions) {
      expect(
        rebuilt.get(position.symbol)?.quantity,
        `${position.symbol} 的股數與明細對不上`,
      ).toBe(position.quantity);
    }
  });

  it('★★ 持倉的平均成本，等於由明細重算出來的加權平均', () => {
    // 這是整個 demo 可信度的核心。面試官如果心算發現這裡對不上，
    // 整個專案的可信度就崩了。
    const rebuilt = rebuildPositionsFromTransactions(data.transactions);

    for (const position of data.positions) {
      expect(
        rebuilt.get(position.symbol)?.avgCostCents,
        `${position.symbol} 的平均成本與明細對不上`,
      ).toBe(position.avgCostCents);
    }
  });

  it('持倉不含已出清的標的（股數為 0 的不該出現在持倉頁）', () => {
    for (const position of data.positions) {
      expect(position.quantity).toBeGreaterThan(0);
    }
  });

  it('所有成交價都落在合法的跳動點上', () => {
    // 掛在非跳動點的價格，真實券商會直接退件 ——
    // 明細裡出現這種價格，懂台股的面試官一眼就會看出來。
    for (const tx of data.transactions) {
      if (tx.priceCents === null || (tx.type !== 'BUY' && tx.type !== 'SELL')) continue;
      expect(isValidTick(tx.priceCents), `${tx.description} 的價格不在跳動點上`).toBe(true);
    }
  });
});

describe('buildSeedData() — 快照自洽性', () => {
  const data = buildSeedData('active', SEED, FIXED_TODAY);

  it('★ 每天的總資產 = 當天現金 + 當天持股市值', () => {
    for (const snapshot of data.snapshots) {
      expect(snapshot.totalValueCents).toBe(snapshot.cashCents + snapshot.marketValueCents);
    }
  });

  it('最後一天快照的現金，等於帳戶最終餘額', () => {
    expect(data.snapshots.at(-1)?.cashCents).toBe(data.cashBalanceCents);
  });

  it('快照日期由舊到新排列，且不含週末', () => {
    let previous = 0;
    for (const snapshot of data.snapshots) {
      const time = snapshot.date.getTime();
      expect(time).toBeGreaterThan(previous);
      previous = time;

      const weekday = snapshot.date.getUTCDay();
      expect(weekday, '快照落在週末，但台股週末不交易').not.toBe(0);
      expect(weekday).not.toBe(6);
    }
  });

  it('市值不為負', () => {
    for (const snapshot of data.snapshots) {
      expect(snapshot.marketValueCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildSeedData() — 各情境的規格', () => {
  it('new-user：有現金，但沒有任何持倉、明細與快照', () => {
    const data = buildSeedData('new-user', SEED, FIXED_TODAY);

    expect(data.cashBalanceCents).toBe(cents(100_000_000)); // 100 萬元
    expect(data.transactions).toHaveLength(0);
    expect(data.positions).toHaveLength(0);
    expect(data.snapshots).toHaveLength(0);
  });

  it('active：8–15 檔持倉，明細接近 3,000 筆', () => {
    const data = buildSeedData('active', SEED, FIXED_TODAY);

    expect(data.positions.length).toBeGreaterThanOrEqual(8);
    expect(data.positions.length).toBeLessThanOrEqual(15);
    // 產生器以「達到目標就停」的方式運作，所以會略少於或等於目標，
    // 但不該差太多 —— 差太多代表模擬提早卡住了（例如現金耗盡）。
    expect(data.transactions.length).toBeGreaterThan(2_500);
    expect(data.transactions.length).toBeLessThanOrEqual(3_010);
  });

  it('★ insufficient：最終現金恰好 500 元，用來測下單餘額不足', () => {
    const data = buildSeedData('insufficient', SEED, FIXED_TODAY);

    expect(data.cashBalanceCents).toBe(cents(50_000)); // 500 元 = 50000 分
    // 要有持倉，否則「餘額不足但有資產」的情境就不成立
    expect(data.positions.length).toBeGreaterThan(0);
  });

  it('heavy-history：明細接近 8,000 筆，用來壓測虛擬滾動', () => {
    const data = buildSeedData('heavy-history', SEED, FIXED_TODAY);

    expect(data.transactions.length).toBeGreaterThan(7_000);
    expect(data.transactions.length).toBeLessThanOrEqual(8_010);
  });

  it('所有情境都有涵蓋到的標的，其收盤價都是合法跳動點', () => {
    const scenarios: AccountScenario[] = ['new-user', 'active', 'insufficient', 'heavy-history'];

    for (const scenario of scenarios) {
      const data = buildSeedData(scenario, SEED, FIXED_TODAY);
      for (const [symbol, price] of data.closingPrices) {
        expect(isValidTick(price), `${scenario} 的 ${symbol} 收盤價不在跳動點上`).toBe(true);
      }
    }
  });
});
