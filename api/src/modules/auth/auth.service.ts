/**
 * api/src/modules/auth/auth.service.ts — 認證業務邏輯
 *
 * 這個檔案是什麼：
 *   驗證密碼、簽發 JWT、組出安全的回應資料。
 *
 * 在架構的哪一層：
 *   業務邏輯層。上面是 Controller（處理 HTTP），下面是 Repository（碰資料庫）。
 *   **這一層完全不知道 HTTP 的存在** —— 沒有 request、response、cookie，
 *   所以它可以被排程、CLI、測試直接呼叫。
 */

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';

import {
  cents,
  type AuthSession,
  type JwtPayload,
  type LoginRequest,
} from '@fintech/shared';

import { invalidCredentials } from '../../common/errors/app.error.js';
import { AuthRepository, type UserWithAccount } from './auth.repository.js';

/**
 * bcrypt 的 cost factor（工作因子）。
 *
 * ── 這個數字在控制什麼 ────────────────────────────────────────────
 *
 * bcrypt 刻意設計成「算得慢」，慢的程度由 cost factor 決定。
 * 它是**指數**的：cost 12 的運算量是 cost 11 的兩倍。
 *
 * 為什麼雜湊要故意慢：
 *   如果資料庫外洩，攻擊者會拿字典去暴力破解。
 *   用 SHA-256 這種快速雜湊，現代 GPU 一秒可以試幾十億組；
 *   用 cost 12 的 bcrypt，一秒只能試幾百組 —— 差了七個數量級。
 *
 * 為什麼是 12 而不是更高：
 *   cost 12 在一般硬體上約 200–300ms。這是「使用者登入時感覺不到、
 *   但攻擊者破解成本極高」的平衡點。設到 16 的話，
 *   使用者每次登入要等好幾秒，而且你的伺服器會變成自己的 DoS 目標。
 *
 * 業界建議每隔幾年往上調一級（硬體會變快）。
 */
const BCRYPT_COST = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 驗證帳密並簽發 JWT。
   *
   * @param credentials 登入請求（已通過 zod 驗證）
   * @returns 簽好的 token 與可以安全回傳給前端的身分資料
   * @throws {AppError} 帳號不存在或密碼錯誤時（AUTH_INVALID_CREDENTIALS）
   */
  async login(credentials: LoginRequest): Promise<{ token: string; session: AuthSession }> {
    const user = await this.repository.findByEmail(credentials.email);

    // ── 為什麼「查無此人」與「密碼錯誤」回同一個錯誤 ────────────
    //
    // 如果分開回報，攻擊者可以拿一堆 email 來試：
    //   回「帳號不存在」→ 這個 email 沒註冊
    //   回「密碼錯誤」  → **這個 email 有註冊**
    //
    // 這叫 user enumeration，等於免費送給攻擊者一份有效帳號清單。
    // 統一回同一個錯誤就分不出來了。
    if (!user) {
      // ⚠️ 這裡還有一個細節：查無此人時我們**沒有**執行 bcrypt 比對，
      //    所以這條路徑會比「帳號存在但密碼錯」快很多。
      //    理論上攻擊者可以用回應時間差來判斷帳號是否存在
      //    （這叫 timing attack）。
      //
      //    本專案只有一個 demo 帳號、不對外開放，所以接受這個風險。
      //    真實系統的做法是：查無此人時也跑一次 bcrypt 比對一個假雜湊，
      //    讓兩條路徑的耗時一致。
      throw invalidCredentials();
    }

    // bcrypt.compare 會從雜湊字串裡讀出當初用的 salt 與 cost，
    // 用同樣的參數重算一次再比對 —— 所以不需要另外存 salt。
    const passwordMatches = await bcrypt.compare(credentials.password, user.passwordHash);

    if (!passwordMatches) {
      throw invalidCredentials();
    }

    const payload: JwtPayload = {
      sub: user.userId,
      accountId: user.accountId,
    };

    // signAsync 會自動填入 iat（簽發時間）與 exp（到期時間），
    // exp 由 AuthModule 設定的 expiresIn 決定。
    const token = await this.jwtService.signAsync(payload);

    return { token, session: this.toSession(user) };
  }

  /**
   * 取得當前登入者的身分資料。
   *
   * 用於 `GET /auth/me` —— 前端重整頁面後，cookie 還在但記憶體裡的
   * 使用者狀態沒了，需要重新取得。
   *
   * @param userId 使用者 id，來自已驗證的 JWT
   * @returns 身分資料
   * @throws {AppError} 使用者已被刪除時（AUTH_INVALID_CREDENTIALS）
   */
  async getSession(userId: string): Promise<AuthSession> {
    const user = await this.repository.findByUserId(userId);

    if (!user) {
      // token 有效但使用者不存在 —— 帳號在 token 有效期內被刪掉了。
      // 這種情況要讓前端把 cookie 清掉重新登入。
      throw invalidCredentials();
    }

    return this.toSession(user);
  }

  /**
   * 產生密碼雜湊。
   *
   * 目前只有 seed 腳本會用到（建立 demo 帳號時）。
   * 未來若加上註冊或改密碼功能，也會走這裡。
   *
   * @param plainPassword 明文密碼
   * @returns bcrypt 雜湊字串（含 salt 與 cost，共 60 字元）
   */
  static async hashPassword(plainPassword: string): Promise<string> {
    return bcrypt.hash(plainPassword, BCRYPT_COST);
  }

  /**
   * 把含有密碼雜湊的內部物件，轉成可以安全回傳給前端的形狀。
   *
   * ★ **這個方法是密碼雜湊不外流的最後一道關卡。**
   *
   * 注意它是明確地一個一個欄位挑出來，而不是用
   * `const { passwordHash, ...rest } = user; return rest;`。
   *
   * 為什麼要笨一點的寫法：解構排除是「黑名單」—— 未來 Repository
   * 多查一個敏感欄位（例如 `two_factor_secret`），它會自動被包進 rest
   * 然後洩漏出去。明確列舉是「白名單」，新欄位預設不會外流。
   *
   * **安全設計一律用白名單。**
   */
  private toSession(user: UserWithAccount): AuthSession {
    return {
      user: {
        id: user.userId,
        email: user.email,
        displayName: user.displayName,
      },
      account: {
        id: user.accountId,
        accountNo: user.accountNo,
        cashBalanceCents: cents(user.cashBalanceCents),
        currency: user.currency,
      },
    };
  }
}
