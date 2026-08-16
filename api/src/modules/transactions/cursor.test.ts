/**
 * api/src/modules/transactions/cursor.test.ts — 分頁游標的測試
 *
 * 這支測試在驗證什麼：
 *   編碼與解碼互為反向操作，以及各種畸形輸入都會被擋下來。
 *
 * 為什麼值得測：
 *   游標是**使用者可控的輸入**（任何人都能在網址列亂改），
 *   而且它會直接變成 SQL 查詢的參數。這種「不可信資料進入資料層」
 *   的路徑，是最該有測試保護的地方。
 *
 *   另外，游標的正確性決定了無限捲動會不會出現重複或遺漏的項目 ——
 *   那種 bug 在開發時資料少，很難靠手動測試發現。
 */

import { describe, expect, it } from 'vitest';

import { AppError } from '../../common/errors/app.error.js';
import { decodeCursor, encodeCursor, type CursorPosition } from './cursor.js';

const SAMPLE: CursorPosition = {
  occurredAt: '2026-08-16T04:30:00.000Z',
  id: '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8',
};

describe('encodeCursor / decodeCursor — 往返一致性', () => {
  it('★ 編碼再解碼會得到原來的值', () => {
    // 這是游標最基本的性質：encode 與 decode 必須互為反向。
    // 不成立的話，翻到第二頁就會定位到錯誤的位置。
    expect(decodeCursor(encodeCursor(SAMPLE))).toEqual(SAMPLE);
  });

  it('編碼結果是 URL 安全的 —— 可以直接放進 query string', () => {
    const encoded = encodeCursor(SAMPLE);

    // base64url 不會產生 + / = 這三個在 URL 裡有特殊意義的字元。
    // 有的話就得額外做 URL encode，前端很容易漏掉。
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded).toBe(encodeURIComponent(encoded));
  });

  it('編碼結果看不出內部結構 —— 前端不會想自己組一個', () => {
    const encoded = encodeCursor(SAMPLE);

    // 這是「不透明權杖」的重點：時間與 id 都不該以明文出現。
    // （base64 不是加密，解得開；但它足以讓人不想自己拼。）
    expect(encoded).not.toContain(SAMPLE.id);
    expect(encoded).not.toContain('2026-08-16');
  });

  it('id 含有分隔符號時仍能正確還原', () => {
    // 目前 id 是 UUID 不會含 `|`，但編碼邏輯是用「第一個分隔符號」
    // 切開的，所以就算 id 裡有 `|` 也不會壞。
    // 這條測試是在保護那個實作決定 —— 有人改成 split('|') 就會失敗。
    const tricky: CursorPosition = { occurredAt: SAMPLE.occurredAt, id: 'a|b|c' };
    expect(decodeCursor(encodeCursor(tricky))).toEqual(tricky);
  });
});

describe('decodeCursor — 畸形輸入一律擋下', () => {
  it('拒絕空字串', () => {
    expect(() => decodeCursor('')).toThrow(AppError);
  });

  it('拒絕沒有分隔符號的內容', () => {
    const bad = Buffer.from('沒有分隔符號', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(AppError);
  });

  it('拒絕時間部分不是合法日期的游標', () => {
    const bad = Buffer.from('不是日期|some-id', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(AppError);
  });

  it('拒絕 id 為空的游標', () => {
    const bad = Buffer.from(`${SAMPLE.occurredAt}|`, 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(AppError);
  });

  it('拒絕使用者亂打的字串', () => {
    // 實際會發生的情況：使用者手動改網址、或前端傳了錯的東西。
    // 重點是它必須變成一個乾淨的 400，而不是讓資料庫收到怪參數後回 500。
    for (const garbage of ['!!!', 'hello-world', '../../etc/passwd', '{}']) {
      expect(() => decodeCursor(garbage), `"${garbage}" 應該被擋下`).toThrow(AppError);
    }
  });

  it('錯誤碼是 VALIDATION_FAILED（會回 400，不是 500）', () => {
    // 使用者輸入錯誤是 4xx 不是 5xx。
    // 回 500 的話，監控系統會以為服務壞了。
    try {
      decodeCursor('garbage');
      expect.unreachable('應該要拋錯');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
    }
  });
});
