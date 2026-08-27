/**
 * market-feed/src/walker.test.ts — 價格漫步的不變式
 *
 * 這裡測的不是「價格會變成多少」（那是隨機的，測不了），
 * 而是「無論隨機怎麼走，都必須成立的性質」：
 *
 *   · 永遠落在合法跳動點上
 *   · 永遠不超出漲跌停
 *   · 高價股必須真的會動（★ 這一條是實測踩到坑之後補的）
 *
 * 這種「性質測試」比逐一比對數值有用得多 —— 它涵蓋的是
 * 所有可能的隨機序列，而不是某一組固定輸入。
 */

import { describe, expect, it } from 'vitest';

import { cents, isValidTick, priceLimits } from '@fintech/shared';

import { step, type WalkerState } from './walker.js';

/** 建一個起始狀態。 */
function makeState(prevCloseMajorUnits: number): WalkerState {
  const price = cents(prevCloseMajorUnits * 100);
  return {
    symbol: 'TEST',
    prevCloseCents: price,
    priceCents: price,
    rawPriceCents: price,
    volume: 0,
  };
}

/** 走 n 步，回傳每一步公布的價格。 */
function walk(state: WalkerState, steps: number): number[] {
  const prices: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    step(state);
    prices.push(state.priceCents);
  }
  return prices;
}

describe('step() — 價格必須永遠合法', () => {
  // 這四個價位分別落在不同的跳動單位級距上：
  //   9.5 元 → 0.01｜88 元 → 0.1｜888 元 → 1｜1645 元 → 5
  const PRICE_TIERS = [9.5, 88, 888, 1645];

  it.each(PRICE_TIERS)('★ %s 元的股票，走 2000 步都落在合法跳動點上', (prevClose) => {
    const state = makeState(prevClose);

    for (const price of walk(state, 2000)) {
      expect(isValidTick(cents(price))).toBe(true);
    }
  });

  it.each(PRICE_TIERS)('★ %s 元的股票，走 2000 步都不超出漲跌停', (prevClose) => {
    const state = makeState(prevClose);
    const limits = priceLimits(state.prevCloseCents);

    for (const price of walk(state, 2000)) {
      expect(price).toBeGreaterThanOrEqual(limits.lower);
      expect(price).toBeLessThanOrEqual(limits.upper);
    }
  });

  it('價格永遠是整數分 —— 不可以出現浮點誤差', () => {
    const state = makeState(888);

    for (const price of walk(state, 500)) {
      expect(Number.isInteger(price)).toBe(true);
    }
  });
});

describe('step() — 價格必須真的會動 ★', () => {
  /**
   * 這一條測試是實測踩到坑之後補的。
   *
   * 原本的實作每次都拿「對齊後」的價格當下一步的起點。
   * 1645 元的股票跳動單位是 5 元，而單筆波動只有約 2 元 ——
   * 不到半檔，對齊時被四捨五入掉，價格永遠停在 1645。
   *
   * 這個 bug 只發生在跳動單位相對於波動幅度太大的高價股，
   * 888 元的股票完全正常，所以很容易在開發時漏掉。
   */
  it.each([9.5, 88, 888, 1645])('★ %s 元的股票，200 步內至少變動過一次', (prevClose) => {
    const state = makeState(prevClose);
    const start = state.priceCents;

    const prices = walk(state, 200);

    expect(prices.some((p) => p !== start)).toBe(true);
  });

  it('★ 1645 元的高價股，200 步內至少出現 3 個不同的價格', () => {
    // 「動過一次」還不夠 —— 要證明它是持續在動，不是動一下就卡住。
    const state = makeState(1645);
    const distinct = new Set(walk(state, 200));

    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });
});

describe('step() — 均值回歸', () => {
  it('價格不會長期貼在漲停或跌停', () => {
    // 沒有均值回歸的純隨機漫步，最終會飄到邊界然後被 clamp 壓在那裡。
    // 走一萬步之後，貼在漲跌停的比例應該很低。
    const state = makeState(888);
    const limits = priceLimits(state.prevCloseCents);

    const prices = walk(state, 10_000);
    const atBoundary = prices.filter((p) => p === limits.upper || p === limits.lower).length;

    expect(atBoundary / prices.length).toBeLessThan(0.05);
  });
});

describe('step() — 成交量', () => {
  it('累計成交量只增不減', () => {
    const state = makeState(888);
    let previous = state.volume;

    for (let i = 0; i < 200; i += 1) {
      step(state);
      expect(state.volume).toBeGreaterThan(previous);
      previous = state.volume;
    }
  });
});
