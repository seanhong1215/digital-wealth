/**
 * shared/src/money.test.ts — 金額運算的測試
 *
 * 這支測試在驗證什麼：
 *   money.ts 的正確性，重點放在**邊界與失敗情境**，而不是「1 + 1 = 2」。
 *
 * 為什麼這支測試特別重要：
 *   金額運算是整個系統的地基。這裡錯一個捨入方向，
 *   後面所有的持倉成本、損益、對帳都會跟著錯，而且不會 crash ——
 *   只會靜靜地算出錯誤的數字。所以這是本專案覆蓋率該最高的檔案。
 *
 * 測試的組織方式：
 *   一個 describe 對應一個函式或一組概念，測試名稱直接寫成
 *   「這個函式在什麼情況下該怎樣」的句子，讓 verbose reporter
 *   的輸出讀起來像一份規格書。
 */

import { describe, it, expect } from 'vitest';
import {
  CENTS_PER_UNIT,
  MAX_SAFE_CENTS,
  MoneyError,
  ZERO_CENTS,
  abs,
  add,
  applyRate,
  cents,
  compare,
  fromMajorUnits,
  isInsufficient,
  isNegative,
  isPositive,
  isZero,
  multiply,
  negate,
  roundToMajorUnit,
  subtract,
  sum,
  toMajorUnits,
  weightedAverageCost,
} from '@digital-wealth/shared';

describe('cents() — 建構與驗證', () => {
  it('接受整數，回傳的值與輸入相同', () => {
    expect(cents(108500)).toBe(108500);
  });

  it('接受零與負數（負數代表出帳）', () => {
    expect(cents(0)).toBe(0);
    expect(cents(-500)).toBe(-500);
  });

  it('拒絕小數 —— 分是最小單位，不存在半分', () => {
    expect(() => cents(1085.5)).toThrow(MoneyError);
  });

  it('拒絕 NaN 與 Infinity', () => {
    expect(() => cents(Number.NaN)).toThrow(MoneyError);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it('拒絕超出 JavaScript 安全整數範圍的值', () => {
    // MAX_SAFE_CENTS 本身合法，再多 2 就不合法。
    // 用 +2 而不是 +1 是因為 MAX_SAFE_INTEGER + 1 在浮點表示下
    // 剛好還等於一個「看起來像整數」的值，+2 才會穩定超界。
    expect(() => cents(MAX_SAFE_CENTS)).not.toThrow();
    expect(() => cents(MAX_SAFE_CENTS + 2)).toThrow(MoneyError);
  });
});

describe('fromMajorUnits() / toMajorUnits() — 元與分的換算', () => {
  it('把整數元換算成分', () => {
    expect(fromMajorUnits(1085)).toBe(108500);
  });

  it('★ 把帶兩位小數的元換算成分，且不受浮點誤差影響', () => {
    // 這是整個 money.ts 存在的理由，用一個真實會出事的價格來驗證。
    //
    // 4.35 元是合理的低價股股價。但在 IEEE 754 雙精度浮點裡，
    // 4.35 無法被精確表示，所以：
    //
    //     4.35 * 100 === 434.99999999999994
    //
    // 少了 0.00000000000006 分。如果直接 `as Cents`，
    // 會被 assertValidCents 的整數檢查擋下（這是好事）；
    // 更糟的情況是有人用 Math.trunc 取整 —— 那會得到 434 分，
    // 也就是 4.34 元，**平白少了 1 分錢**。
    //
    // 一筆少 1 分沒人發現，三千筆之後對帳就對不起來了。
    expect(4.35 * CENTS_PER_UNIT).not.toBe(435); // 先證明浮點誤差真的存在
    expect(Math.trunc(4.35 * CENTS_PER_UNIT)).toBe(434); // 用 trunc 會少一分（錯誤示範）
    expect(fromMajorUnits(4.35)).toBe(435); // 我們用 round，結果正確
  });

  it('比「分」更小的精度會被四捨五入掉', () => {
    expect(fromMajorUnits(0.005)).toBe(1);
    expect(fromMajorUnits(0.004)).toBe(0);
  });

  it('分換回元', () => {
    expect(toMajorUnits(cents(108555))).toBeCloseTo(1085.55);
  });
});

describe('add / subtract / multiply — 四則運算', () => {
  it('相加', () => {
    expect(add(cents(10850000), cents(15400))).toBe(10865400);
  });

  it('相減的結果允許為負（帳務流水用正負表示進出）', () => {
    expect(subtract(cents(100), cents(300))).toBe(-200);
  });

  it('單價乘以股數', () => {
    expect(multiply(cents(108500), 1000)).toBe(108500000);
  });

  it('乘法拒絕小數倍數 —— 要乘費率請改用 applyRate', () => {
    expect(() => multiply(cents(1000), 0.5)).toThrow(MoneyError);
  });

  it('運算結果超界時拋錯，而不是靜默失去精度', () => {
    const huge = cents(MAX_SAFE_CENTS);
    expect(() => add(huge, cents(1000))).toThrow(MoneyError);
  });
});

describe('applyRate() — 乘以費率', () => {
  it('依費率計算並四捨五入', () => {
    // 108,500 元 × 0.1425% = 154.6125 元 = 15461.25 分
    expect(applyRate(cents(10850000), 0.001425, 'round')).toBe(15461);
  });

  it('floor 是往零的方向捨去，對正負數的語意一致（金額都變小）', () => {
    expect(applyRate(cents(1000), 0.155, 'floor')).toBe(155);
    expect(applyRate(cents(-1000), 0.155, 'floor')).toBe(-155);
  });

  it('ceil 是遠離零的方向進位', () => {
    expect(applyRate(cents(1000), 0.1551, 'ceil')).toBe(156);
    expect(applyRate(cents(-1000), 0.1551, 'ceil')).toBe(-156);
  });
});

describe('roundToMajorUnit() — 捨入到整數元', () => {
  it('捨去到整數元後，結果必為 100 的倍數', () => {
    expect(roundToMajorUnit(cents(15461), 'floor')).toBe(15400);
  });

  it('進位到整數元', () => {
    expect(roundToMajorUnit(cents(15401), 'ceil')).toBe(15500);
  });

  it('已經是整數元時不變', () => {
    expect(roundToMajorUnit(cents(15400), 'floor')).toBe(15400);
  });
});

describe('sum / abs / negate — 聚合與符號', () => {
  it('加總一串金額', () => {
    expect(sum([cents(100), cents(200), cents(-50)])).toBe(250);
  });

  it('空陣列的總和是零，不是錯誤 —— 「沒有交易」的總額本來就是 0', () => {
    expect(sum([])).toBe(ZERO_CENTS);
  });

  it('取絕對值（明細顯示用，正負號交給 UI）', () => {
    expect(abs(cents(-1234))).toBe(1234);
  });

  it('取相反數', () => {
    expect(negate(cents(1234))).toBe(-1234);
  });
});

describe('比較函式', () => {
  it('compare 的回傳值可直接餵給 Array.sort', () => {
    const values = [cents(300), cents(100), cents(200)];
    expect([...values].sort(compare)).toEqual([100, 200, 300]);
  });

  it('isZero / isNegative / isPositive', () => {
    expect(isZero(ZERO_CENTS)).toBe(true);
    expect(isNegative(cents(-1))).toBe(true);
    expect(isPositive(cents(1))).toBe(true);
    expect(isNegative(ZERO_CENTS)).toBe(false);
    expect(isPositive(ZERO_CENTS)).toBe(false);
  });

  it('餘額恰好等於所需金額時，視為足夠（不是不足）', () => {
    // 這是個容易寫錯成 <= 的邊界。剛好付得起就該付得起。
    expect(isInsufficient(cents(10865400), cents(10865400))).toBe(false);
    expect(isInsufficient(cents(10865399), cents(10865400))).toBe(true);
  });
});

describe('weightedAverageCost() — 加權平均成本', () => {
  it('第一次買進時，平均成本就是買入價', () => {
    expect(weightedAverageCost(0, ZERO_CENTS, 1000, cents(10000))).toBe(10000);
  });

  it('等量加碼時，平均成本是兩次價格的中點', () => {
    // 1000 股 @100 元 + 1000 股 @110 元 → 均價 105 元
    expect(weightedAverageCost(1000, cents(10000), 1000, cents(11000))).toBe(10500);
  });

  it('不等量加碼時，依股數加權而非單純平均', () => {
    // 3000 股 @100 元 + 1000 股 @200 元
    // → (3000×100 + 1000×200) / 4000 = 125 元，而不是 (100+200)/2 = 150 元
    expect(weightedAverageCost(3000, cents(10000), 1000, cents(20000))).toBe(12500);
  });

  it('除不盡時四捨五入到分', () => {
    // 1000 股 @100 元 + 1 股 @105 元 → 100015.../1001，四捨五入
    const result = weightedAverageCost(1000, cents(10000), 1, cents(10500));
    expect(result).toBe(Math.round((1000 * 10000 + 1 * 10500) / 1001));
  });

  it('拒絕非正的新增股數', () => {
    expect(() => weightedAverageCost(1000, cents(10000), 0, cents(10000))).toThrow(MoneyError);
    expect(() => weightedAverageCost(1000, cents(10000), -1, cents(10000))).toThrow(MoneyError);
  });

  it('拒絕負的目前股數', () => {
    expect(() => weightedAverageCost(-1, cents(10000), 100, cents(10000))).toThrow(MoneyError);
  });
});
