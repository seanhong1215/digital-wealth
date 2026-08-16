/**
 * api/src/database/database.service.ts — PostgreSQL 連線與查詢的唯一入口
 *
 * 這個檔案是什麼：
 *   包裝 `pg` 套件的連線池（Pool），對外提供兩個能力：
 *     - `query()`  單一查詢
 *     - `transaction()` 在一個資料庫交易內執行多個查詢
 *
 * 為什麼存在：
 *   1. **連線池要有人管生命週期。** 服務啟動時建立、關閉時歸還，
 *      這正是 NestJS 生命週期鉤子（OnModuleInit / OnModuleDestroy）的用途。
 *   2. **交易的樣板碼只該寫一次。** BEGIN / COMMIT / ROLLBACK / release
 *      這四行如果散在每個 Service 裡，遲早會有人漏掉 release，
 *      連線池就會被耗盡（而且症狀是「服務隨機卡住」，超難查）。
 *
 * 在架構的哪一層：
 *   基礎設施層。上面是各 module 的 Repository，Repository 之上才是 Service。
 *   **Controller 絕對不會直接碰到這個類別**（見 00-architecture.md 的硬性分層規則）。
 *
 * 相關決策：docs/adr/0010-raw-sql-over-orm.md
 */

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';

import { env } from '../config/env.js';

/**
 * `pg` 是 CommonJS 套件，在 ESM 裡只能整包 default import，
 * 不能寫 `import { Pool } from 'pg'`（會在執行期變成 undefined）。
 * 所以這裡先整包進來再解構。
 */
const { Pool } = pg;

/**
 * 資料庫查詢的參數。
 *
 * 一律用陣列傳參，**永遠不要用字串拼接組 SQL**：
 *
 *   ❌ `SELECT * FROM users WHERE email = '${email}'`   ← SQL Injection
 *   ✅ `SELECT * FROM users WHERE email = $1`, [email]  ← 參數化查詢
 *
 * 參數化查詢是把 SQL 語句和資料**分開送**給資料庫，資料庫不會把
 * 參數內容當成 SQL 來解析。使用者就算輸入 `' OR 1=1 --` 也只是
 * 一個查不到東西的 email 字串。
 */
export type QueryParams = readonly unknown[];

/**
 * 在交易內執行查詢時拿到的介面。
 *
 * 刻意只暴露 `query` —— 不讓呼叫端拿到 client 本體，
 * 就不可能有人在交易中間偷偷呼叫 `client.release()` 把連線還掉。
 */
export interface TransactionClient {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<pg.QueryResult<Row>>;
}

/**
 * ── `@Injectable()` 是什麼（NestJS 第一次出現，完整說明）─────────────
 *
 * NestJS 用「依賴注入（Dependency Injection, DI）」來組裝物件：
 * 你不自己 `new DatabaseService()`，而是在需要的地方宣告
 * 「我需要一個 DatabaseService」，由框架負責建立並傳進來。
 *
 *     constructor(private readonly db: DatabaseService) {}
 *                                      ^^^^^^^^^^^^^^^
 *                                      不用自己 new，框架會給
 *
 * `@Injectable()` 這個裝飾器就是在跟框架說「這個類別可以被注入」。
 * 框架會在啟動時建立**一個**實例（預設是單例），所有需要它的地方
 * 共用同一個 —— 這正是連線池該有的行為，全服務只該有一個池。
 *
 * 對照 Spring Boot：`@Injectable()` ≈ `@Component` / `@Service`。
 * 觀念是一樣的，只是名字不同。
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  /**
   * NestJS 內建的 Logger。用它而不是 `console.log` 的理由是輸出會帶上
   * 時間戳與來源名稱（這裡是 'DatabaseService'），在多模組的日誌裡
   * 一眼就能看出訊息是誰印的。
   */
  private readonly logger = new Logger(DatabaseService.name);

  /**
   * 連線池。
   *
   * ── 為什麼需要連線池 ────────────────────────────────────────────
   *
   * 建立一條 PostgreSQL 連線要經過 TCP 握手與認證，成本大約幾十毫秒。
   * 如果每個 HTTP 請求都開一條新連線，光是建立連線就比查詢本身還慢。
   *
   * 連線池的做法是**預先開好幾條連線重複使用**：請求進來時借一條，
   * 用完還回去。`max: 10` 表示最多同時存在 10 條。
   *
   * 為什麼是 10：PostgreSQL 每條連線在伺服器端都是一個獨立行程，
   * 開太多反而會拖垮資料庫。本專案是單人 demo，10 條綽綽有餘。
   */
  private readonly pool = new Pool({
    host: env.postgres.host,
    port: env.postgres.port,
    user: env.postgres.user,
    password: env.postgres.password,
    database: env.postgres.database,
    max: 10,

    /**
     * 連線閒置超過 30 秒就關掉，把資源還給資料庫。
     * 下次要用時再開一條，反正閒置代表沒有流量壓力。
     */
    idleTimeoutMillis: 30_000,

    /**
     * 借連線超過 5 秒還借不到就放棄。
     *
     * 沒有這個設定的話，資料庫掛掉時請求會**永遠卡著**不回應 ——
     * 對使用者來說「一直轉圈圈」比「明確報錯」糟糕得多，
     * 而且卡住的請求會佔著 Node 的資源不放。
     */
    connectionTimeoutMillis: 5_000,
  });

  /**
   * NestJS 生命週期鉤子：模組初始化完成時呼叫。
   *
   * 在這裡做一次連線測試，讓「資料庫沒開」這種問題在**啟動時**就爆炸，
   * 而不是等到第一個請求進來。快速失敗（fail fast）永遠比慢慢失敗好。
   *
   * @throws 連線失敗時直接讓服務啟動失敗
   */
  async onModuleInit(): Promise<void> {
    const { rows } = await this.pool.query<{ version: string }>('SELECT version()');
    this.logger.log(`PostgreSQL 連線成功：${rows[0]?.version.split(',')[0] ?? '未知版本'}`);
  }

  /**
   * NestJS 生命週期鉤子：模組銷毀時呼叫（服務正常關閉時）。
   *
   * 關閉連線池，讓 PostgreSQL 那端也能立刻釋放資源。
   * 沒有這步的話，重啟服務時舊連線會留在資料庫端直到逾時。
   */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    this.logger.log('PostgreSQL 連線池已關閉');
  }

  /**
   * 執行單一查詢。
   *
   * 每次呼叫會自動從池裡借一條連線、用完自動還。
   * **同一次呼叫內的查詢有交易保證，跨呼叫則沒有** ——
   * 需要多個查詢一起成功或一起失敗時，必須用 `transaction()`。
   *
   * @param sql SQL 語句，參數用 `$1`、`$2` 佔位
   * @param params 參數值，順序對應 `$1`、`$2`
   * @returns 查詢結果，`rows` 是資料列陣列
   *
   * @example
   *   const { rows } = await db.query<{ id: string }>(
   *     'SELECT id FROM accounts WHERE user_id = $1',
   *     [userId],
   *   );
   */
  async query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: QueryParams,
  ): Promise<pg.QueryResult<Row>> {
    return this.pool.query<Row>(sql, params as unknown[] | undefined);
  }

  /**
   * 在單一資料庫交易內執行多個查詢。
   *
   * ── 交易（transaction）在做什麼 ────────────────────────────────────
   *
   * 交易保證一組操作是**全部成功或全部沒發生**，不會停在中間。
   * 下單流程就是典型例子：扣款、更新持倉、寫流水帳這三件事，
   * 如果扣了款但持倉沒更新，使用者的錢就憑空消失了。
   *
   * 這個方法做的事：
   *   1. 從池裡借一條**專屬**連線（交易必須在同一條連線上，這點很關鍵）
   *   2. `BEGIN` 開始交易
   *   3. 執行你的 callback
   *   4. callback 正常結束 → `COMMIT` 讓變更生效
   *      callback 拋出任何錯誤 → `ROLLBACK` 讓變更全部消失，再把錯誤往上拋
   *   5. **無論成功失敗都把連線還回池裡**（`finally` 區塊）
   *
   * 第 5 步是最容易寫錯的地方 —— 漏掉 `release()` 不會立刻出事，
   * 但每次錯誤都會漏掉一條連線，跑一陣子之後連線池空了，
   * 整個服務就會卡在「等待連線」直到逾時。
   *
   * @param work 要在交易內執行的工作。收到的 `client` 只能用來下查詢
   * @returns `work` 的回傳值
   * @throws `work` 拋出的任何錯誤（此時交易已回滾）
   *
   * @example
   *   // 下單：扣款與寫流水帳必須一起成功
   *   await db.transaction(async (tx) => {
   *     await tx.query('UPDATE accounts SET cash_balance_cents = $1 WHERE id = $2', [next, id]);
   *     await tx.query('INSERT INTO transactions (...) VALUES (...)', [...]);
   *   });
   */
  async transaction<T>(work: (client: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // 回滾本身也可能失敗（例如連線已經斷了）。
      // 如果回滾的錯誤蓋掉原始錯誤，就會完全查不出真正的原因，
      // 所以這裡只記錄、不拋出，讓原始錯誤能傳到上層。
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        this.logger.error('交易回滾失敗', rollbackError);
      });
      throw error;
    } finally {
      // 這一行是整個檔案最重要的一行，理由見上方說明。
      client.release();
    }
  }

  /**
   * 健康檢查用的輕量查詢。
   *
   * 用 `SELECT 1` 而不是查真實資料表，是因為健康檢查該驗證的是
   * 「連線通不通」，不是「資料對不對」。查真表會讓健康檢查
   * 受到資料量與索引狀態影響，失去它該有的即時性。
   *
   * @returns 連線正常時為 true，任何錯誤都回傳 false（不拋出）
   */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
