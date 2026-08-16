/**
 * api/src/modules/auth/auth.repository.ts — 認證相關的資料存取
 *
 * 這個檔案是什麼：
 *   查詢使用者與其帳戶的 SQL。
 *
 * ── Repository 這一層在做什麼、不做什麼 ───────────────────────────
 *
 *   做：   寫 SQL、把資料庫的 row（snake_case）轉成應用層的物件（camelCase）
 *   不做： 任何業務判斷。密碼對不對、要不要簽 token 都是 Service 的事
 *
 * 這個分工來自 00-architecture.md 的硬性規則：
 *   **Controller → Service → Repository，Controller 不得直接碰資料庫。**
 *
 * 為什麼值得多這一層（而不是讓 Service 直接下 SQL）：
 *   1. SQL 集中在一起，要看「這個模組碰了哪些表」翻一個檔案就夠
 *   2. Service 的測試可以替換掉 Repository，不需要真的資料庫
 *   3. 未來要換資料來源（加快取、改用其他 DB）只動這一層
 *
 * 在架構的哪一層：資料存取層。
 */

import { Injectable } from '@nestjs/common';

import { cents } from '@fintech/shared';

import { DatabaseService } from '../../database/database.service.js';

/**
 * 使用者與其帳戶的合併查詢結果。
 *
 * ⚠️ 這個型別**含有 passwordHash**，因為登入流程需要比對它。
 *    它絕不可以直接回傳給前端 —— Service 層會挑出安全的欄位，
 *    而 shared 的 `userSchema` 根本沒有這個欄位（見那裡的說明）。
 */
export interface UserWithAccount {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  /** bcrypt 雜湊。⚠️ 只用於登入比對，絕不外流 */
  readonly passwordHash: string;
  readonly accountId: string;
  readonly accountNo: string;
  readonly cashBalanceCents: number;
  readonly currency: string;
}

/**
 * 資料庫查詢回來的原始 row 形狀。
 *
 * ── 為什麼欄位名是 snake_case ─────────────────────────────────────
 *
 * PostgreSQL 的慣例是 snake_case（`cash_balance_cents`），
 * TypeScript／JavaScript 的慣例是 camelCase（`cashBalanceCents`）。
 *
 * 兩邊各自遵守自己的慣例，**在 Repository 這一層做轉換**。
 * 這個轉換樣板碼是「不用 ORM」的代價之一（見 ADR 0010）——
 * ORM 會自動做這件事，但代價是多一套模型定義。
 *
 * ⚠️ 另外注意 `BIGINT` 欄位：`pg` 套件預設把 BIGINT 轉成**字串**，
 *    因為 BIGINT 的範圍超過 JavaScript 的安全整數。
 *    本專案的金額不會超過安全範圍（見 money.ts 的說明），
 *    所以在 SQL 裡直接用 `::int8` 取出後由下方 Number() 轉換。
 */
interface UserWithAccountRow {
  user_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  account_id: string;
  account_no: string;
  cash_balance_cents: string;
  currency: string;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 依 email 查出使用者與其帳戶。
   *
   * ── 為什麼用 JOIN 一次撈完，而不是查兩次 ──────────────────────
   *
   * 登入成功後要回傳 user 與 account 兩份資料。分成兩次查詢的話
   * 是兩次網路往返；JOIN 一次就好。
   *
   * 這是 N+1 查詢問題的簡單版本 —— 資料量小時感覺不出來，
   * 但養成「能一次撈完就不要分兩次」的習慣，
   * 到了持倉列表（每筆持倉都要標的資料）那種場景才不會出事。
   *
   * @param email 登入用的電子郵件
   * @returns 使用者與帳戶資料；查無此人時為 null
   */
  async findByEmail(email: string): Promise<UserWithAccount | null> {
    const { rows } = await this.db.query<UserWithAccountRow>(
      `SELECT
         u.id            AS user_id,
         u.email,
         u.display_name,
         u.password_hash,
         a.id            AS account_id,
         a.account_no,
         a.cash_balance_cents::text AS cash_balance_cents,
         a.currency
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       WHERE u.email = $1
       LIMIT 1`,
      // ★ 參數化查詢。email 的內容永遠不會被當成 SQL 解析，
      //   就算使用者輸入 `' OR 1=1 --` 也只是一個查不到東西的字串。
      [email],
    );

    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  /**
   * 依使用者 id 查出使用者與其帳戶。
   *
   * 用於 `GET /auth/me` —— 前端重整頁面後要重新取得當前身分。
   *
   * ★ 為什麼不直接用 token 裡的資料回傳就好：
   *   token 是登入當下簽的，裡面沒有餘額（而且也不該有 ——
   *   JWT 的 payload 沒有加密）。而且使用者名稱、餘額都會變動，
   *   每次都回資料庫查才拿得到最新值。
   *
   * @param userId 使用者 id（來自已驗證的 JWT）
   * @returns 使用者與帳戶資料；查無此人時為 null
   */
  async findByUserId(userId: string): Promise<UserWithAccount | null> {
    const { rows } = await this.db.query<UserWithAccountRow>(
      `SELECT
         u.id            AS user_id,
         u.email,
         u.display_name,
         u.password_hash,
         a.id            AS account_id,
         a.account_no,
         a.cash_balance_cents::text AS cash_balance_cents,
         a.currency
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [userId],
    );

    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  /**
   * 把資料庫 row 轉成應用層物件。
   *
   * 兩件事：snake_case → camelCase，以及字串金額 → Cents。
   *
   * `cents()` 會驗證數值是合法的整數分，所以如果資料庫裡有髒資料
   * （不該發生，但 CHECK 約束也可能被繞過），會在這裡就拋錯，
   * 而不是讓一個 NaN 一路傳到前端。
   */
  private toDomain(row: UserWithAccountRow): UserWithAccount {
    return {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      accountId: row.account_id,
      accountNo: row.account_no,
      cashBalanceCents: cents(Number(row.cash_balance_cents)),
      currency: row.currency,
    };
  }
}
