/**
 * shared/src/index.test.ts — workspace 連接驗證
 *
 * 這支測試存在的目的不是測那幾個常數的值（那沒什麼好測的），
 * 而是**驗證 npm workspaces 有沒有真的接起來**。
 *
 * 關鍵在下面這行 import 的寫法：
 *
 *     import { APP_NAME } from '@digital-wealth/shared';
 *                              ^^^^^^^^^^^^^^^^^
 *                              套件名稱，不是相對路徑
 *
 * 如果 workspace 設定錯誤，這行會直接找不到模組而失敗。
 * 用相對路徑 './index' 的話就測不出這件事了。
 *
 * npm workspaces 的運作方式：
 *   執行 npm install 時，npm 會在根目錄的 node_modules/ 底下建立一個
 *   symlink（符號連結）：
 *
 *     node_modules/@digital-wealth/shared  →  ../../shared
 *
 *   之後任何 workspace 寫 import '@digital-wealth/shared'，Node 都會沿著這個
 *   連結找到 shared/ 目錄，再依 shared/package.json 的 "exports" 欄位
 *   決定實際載入哪個檔案。
 */

import { describe, it, expect } from 'vitest';
import { APP_NAME, CURRENCY, CENTS_PER_UNIT } from '@digital-wealth/shared';

describe('workspace 連接', () => {
  it('可以用套件名稱 @digital-wealth/shared 匯入，代表 workspace 已正確連結', () => {
    expect(APP_NAME).toBe('Shawn');
  });

  it('幣別常數為新台幣', () => {
    expect(CURRENCY).toBe('TWD');
  });

  it('一元等於一百分', () => {
    expect(CENTS_PER_UNIT).toBe(100);
  });
});
