/**
 * shared/src/market-rules.test.ts — 台股交易規則的測試
 *
 * 這支測試在驗證什麼：
 *   三組規則的正確性 —— 跳動單位、交易成本、漲跌停。
 *
 * 為什麼值得寫得這麼細：
 *   這些是**業務規則**，不是程式邏輯。程式邏輯寫錯通常會爆炸，
 *   業務規則寫錯只會安靜地算出一個「看起來很合理」的錯誤數字。
 *   唯一能防的方式就是把規則本身寫成測試 ——
 *   下面每一個 expect 的預期值，都可以拿去對照證交所的公告驗證。
 */

import { describe, it, expect } from 'vitest';
import {
  BROKERAGE_FEE_RATE,
  MINIMUM_BROKERAGE_FEE,
  SECURITIES_TAX_RATE,
  alignToTick,
  calculateTradeCost,
  cents,
  isValidTick,
  isWithinPriceLimits,
  priceLimits,
  tickSize,
} from '@fintech/shared';

describe('tickSize() — 最小跳動單位', () => {
  // 每一列是「股價（元）→ 預期跳動單位（元）」，直接對照證交所級距表。
  it.each([
    { priceInUnits: 9.99, expectedTickInUnits: 0.01, tier: '未滿 10 元' },
    { priceInUnits: 10, expectedTickInUnits: 0.05, tier: '10 元' },
    { priceInUnits: 49.95, expectedTickInUnits: 0.05, tier: '未滿 50 元' },
    { priceInUnits: 50, expectedTickInUnits: 0.1, tier: '50 元' },
    { priceInUnits: 99.9, expectedTickInUnits: 0.1, tier: '未滿 100 元' },
    { priceInUnits: 100, expectedTickInUnits: 0.5, tier: '100 元' },
    { priceInUnits: 499.5, expectedTickInUnits: 0.5, tier: '未滿 500 元' },
    { priceInUnits: 500, expectedTickInUnits: 1, tier: '500 元' },
    { priceInUnits: 999, expectedTickInUnits: 1, tier: '未滿 1000 元' },
    { priceInUnits: 1000, expectedTickInUnits: 5, tier: '1000 元以上' },
    { priceInUnits: 1085, expectedTickInUnits: 5, tier: '1000 元以上' },
  ])('$priceInUnits 元（$tier）的跳動單位是 $expectedTickInUnits 元', ({
    priceInUnits,
    expectedTickInUnits,
  }) => {
    expect(tickSize(cents(Math.round(priceInUnits * 100)))).toBe(
      Math.round(expectedTickInUnits * 100),
    );
  });

  it('股價為零或負數時拋錯', () => {
    expect(() => tickSize(cents(0))).toThrow();
    expect(() => tickSize(cents(-100))).toThrow();
  });
});

describe('isValidTick() / alignToTick() — 價格對齊', () => {
  it('1085 元是合法價格（1000 元以上跳 5 元）', () => {
    expect(isValidTick(cents(108500))).toBe(true);
  });

  it('1086 元不是合法價格 —— 真實券商會直接退件', () => {
    expect(isValidTick(cents(108600))).toBe(false);
  });

  it('對齊會找到最近的合法跳動點', () => {
    expect(alignToTick(cents(108600))).toBe(108500); // 1086 → 1085
    expect(alignToTick(cents(108800))).toBe(109000); // 1088 → 1090
  });

  it('對齊後的價格必定通過 isValidTick', () => {
    // 隨機取樣驗證兩個函式互相自洽。
    for (const raw of [137, 1234, 9999, 50001, 123456]) {
      expect(isValidTick(alignToTick(cents(raw)))).toBe(true);
    }
  });
});

describe('calculateTradeCost() — 交易成本', () => {
  // 共同情境：買賣 1 張（1000 股）台積電，每股 1085 元。
  //
  //   股款 = 1085 元 × 1000 股 = 1,085,000 元 = 108,500,000 分
  //
  // ⚠️ docs/02-backend.md 的範例把股款寫成「108,500 元」，那是文件的
  //    算術筆誤（少了一位）。以這裡的計算為準，並已回報修正。
  it('買進：股款 + 手續費，不收證交稅', () => {
    // 手續費 1,085,000 × 0.1425% = 1546.125 元 → 捨到元 = 1546 元
    const cost = calculateTradeCost(cents(108500), 1000, 'BUY');

    expect(cost.gross).toBe(108_500_000); // 1,085,000 元
    expect(cost.fee).toBe(154_600); //         1,546 元
    expect(cost.tax).toBe(0); //               買進不收證交稅
    expect(cost.net).toBe(108_654_600); //  1,086,546 元 —— 要從餘額扣掉的金額
  });

  it('賣出：股款 − 手續費 − 證交稅', () => {
    // 證交稅 1,085,000 × 0.3% = 3255 元
    const cost = calculateTradeCost(cents(108500), 1000, 'SELL');

    expect(cost.gross).toBe(108_500_000); // 1,085,000 元
    expect(cost.fee).toBe(154_600); //         1,546 元
    expect(cost.tax).toBe(325_500); //         3,255 元
    expect(cost.net).toBe(108_019_900); //  1,080,199 元 —— 實際入帳的金額
  });

  it('同一筆交易，賣出的成本比買進高（多一道證交稅）', () => {
    // 這個關係比絕對數字更值得測 —— 就算未來費率調整，這條也該成立。
    const buy = calculateTradeCost(cents(108500), 1000, 'BUY');
    const sell = calculateTradeCost(cents(108500), 1000, 'SELL');

    expect(sell.tax).toBeGreaterThan(buy.tax);
    expect(sell.fee).toBe(buy.fee); // 手續費買賣同率
  });

  it('★ 小額交易套用 20 元手續費下限', () => {
    // 這是最容易漏掉的規則。
    // 買 1 股 20 元的股票，股款只有 20 元，
    // 按費率算手續費是 0.0285 元 —— 但實際仍要收 20 元。
    const cost = calculateTradeCost(cents(2000), 1, 'BUY');

    expect(cost.gross).toBe(2_000); //  20 元
    expect(cost.fee).toBe(MINIMUM_BROKERAGE_FEE); // 20 元，不是 0
    expect(cost.net).toBe(4_000); //    40 元 —— 手續費是本金的 100%
  });

  it('手續費恰好等於 20 元的臨界點不受下限影響', () => {
    // 手續費達到 20 元所需的股款：20 / 0.001425 ≈ 14,035.09 元
    // 取 14,036 元（× 0.1425% = 20.0013 → 捨到元 = 20 元）
    const cost = calculateTradeCost(cents(1_403_600), 1, 'BUY');
    expect(cost.fee).toBe(2_000);
  });

  it('費率常數與規格一致（改動時這裡會先失敗）', () => {
    expect(BROKERAGE_FEE_RATE).toBe(0.001425);
    expect(SECURITIES_TAX_RATE).toBe(0.003);
    expect(MINIMUM_BROKERAGE_FEE).toBe(2_000);
  });

  it('拒絕非正整數股數', () => {
    expect(() => calculateTradeCost(cents(108500), 0, 'BUY')).toThrow();
    expect(() => calculateTradeCost(cents(108500), -1, 'BUY')).toThrow();
    expect(() => calculateTradeCost(cents(108500), 1.5, 'BUY')).toThrow();
  });
});

describe('priceLimits() — 漲跌停', () => {
  it('漲跌停都往區間內側對齊，保證不超過法定的 ±10%', () => {
    // 昨收 1085 元 → 漲停 1193.5 元、跌停 976.5 元
    // 但 1000 元以上跳 5 元，所以漲停捨去到 1190 元
    const limits = priceLimits(cents(108500));

    expect(limits.upper).toBe(119_000); // 1190 元 ≤ 1193.5 元 ✅
    expect(limits.lower).toBe(97_700); //  977 元 ≥ 976.5 元 ✅

    // 用比率反推，確認兩邊都沒有越界。
    expect(limits.upper).toBeLessThanOrEqual(108500 * 1.1);
    expect(limits.lower).toBeGreaterThanOrEqual(108500 * 0.9);
  });

  it('漲跌停價本身必定落在合法跳動點上', () => {
    for (const prevClose of [500, 2500, 7500, 25000, 75000, 250000]) {
      const limits = priceLimits(cents(prevClose));
      expect(isValidTick(limits.upper)).toBe(true);
      expect(isValidTick(limits.lower)).toBe(true);
    }
  });

  it('isWithinPriceLimits 判斷委託價是否合法', () => {
    const prevClose = cents(108500);

    expect(isWithinPriceLimits(cents(110000), prevClose)).toBe(true); // 區間內
    expect(isWithinPriceLimits(cents(119000), prevClose)).toBe(true); // 漲停價本身合法
    expect(isWithinPriceLimits(cents(120000), prevClose)).toBe(false); // 超過漲停
    expect(isWithinPriceLimits(cents(90000), prevClose)).toBe(false); // 低於跌停
  });

  it('昨收價不為正時拋錯', () => {
    expect(() => priceLimits(cents(0))).toThrow();
  });
});
