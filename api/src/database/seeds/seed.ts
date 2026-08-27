/**
 * api/src/database/seeds/seed.ts — 種子資料寫入器
 *
 * 這個檔案是什麼：
 *   一支 CLI 腳本。呼叫 factory 產生資料，然後寫進資料庫。
 *
 * 職責劃分（為什麼要跟 factory.ts 分開）：
 *   - `factory.ts` 是**純函式** —— 不碰資料庫、不碰時間以外的外部狀態，
 *     同樣的輸入必定得到同樣的輸出。所以它可以被直接單元測試
 *     （驗證「持倉成本真的等於歷史加權平均」這種性質）。
 *   - `seed.ts` 負責 I/O —— 連線、清資料、批次插入。
 *
 *   把「算什麼」和「寫到哪」分開，是本專案在每一層都會重複的模式：
 *   Service 算、Repository 寫；factory 算、seed 寫。
 *
 * 執行方式：
 *   npm run seed -w @digital-wealth/api                       # 預設 active 情境
 *   npm run seed -w @digital-wealth/api -- --scenario=new-user
 *   npm run seed -w @digital-wealth/api -- --scenario=active --seed=7
 *
 * 在架構的哪一層：
 *   維運工具，不屬於執行期的應用程式。
 */

import pg from 'pg';

import { env } from '../../config/env.js';
import { AuthService } from '../../modules/auth/auth.service.js';
// 模擬層住在 shared —— 三個地方共用同一份規則
// （api 的 seed、market-feed、瀏覽器的 MSW mock）。
import {
  DEFAULT_LOT_SIZE,
  INSTRUMENT_SEEDS,
  buildSeedData,
  type AccountScenario,
  type SeedData,
} from '@digital-wealth/shared/simulation';

const { Client } = pg;

/** demo 帳號的登入信箱。單元 1.1 的登入頁會預填這個值。 */
const DEMO_EMAIL = 'demo@digital-wealth.local';

/**
 * demo 使用者與帳戶的 **固定 UUID** ★
 *
 * ── 為什麼不讓資料庫用 gen_random_uuid() 產生 ────────────────────
 *
 *   因為 Demo 控制台會在服務執行中重建資料庫。而使用者的身分
 *   （JWT）裡存的正是 user id 與 account id ——
 *
 *     重建 → 新的 UUID → 舊的 JWT 指向一個不存在的使用者
 *          → 下一個請求 401 → 使用者被踢回登入頁
 *
 *   面試官切一次情境就被登出，還得重新登入才能看結果，
 *   那個「一鍵切換」的價值就沒了。（這是實測踩到的：
 *   切換情境後所有 API 立刻回 401。）
 *
 *   固定 id 之後，重建前後的身分是同一個，cookie 仍然有效。
 *
 *   這也更符合本專案的原則：**同一組（情境、種子）永遠產生
 *   一模一樣的資料**。id 是資料的一部分，隨機的 id 讓
 *   「一模一樣」變成只是「數字一樣」。
 *
 *   格式是合法的 v4 UUID（第 13 位是 4、變體位是 8），
 *   用全 0 開頭讓它一眼看得出是固定值而不是隨機產生的。
 */
const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';

/**
 * demo 帳號的密碼（明文）。
 *
 * ⚠️ **明文密碼寫在原始碼裡，一般情況下是嚴重的安全問題。**
 *
 *    這裡可以這麼做，前提非常明確：
 *      1. 這是**刻意公開**的示範帳號，本來就要讓面試官登入
 *      2. 專案不做線上部署（ADR 0004），只跑在本機
 *      3. 帳號沒有任何真實資料，也沒有任何真實權限
 *
 *    README 會寫明這組帳密。真實系統絕不可比照辦理。
 *
 * 雜湊在 seed 執行時才用 bcrypt 現算（見下方 main()），
 * 而不是寫死一串雜湊值 —— 這樣改密碼只要改這一行，
 * 而且雜湊用的 cost factor 永遠與 AuthService 一致。
 */
const DEMO_PASSWORD = 'demo1234';

/** 合法的情境名稱，用於驗證 CLI 參數。 */
const VALID_SCENARIOS: readonly AccountScenario[] = [
  'new-user',
  'active',
  'insufficient',
  'heavy-history',
];

/** CLI 參數。 */
interface CliOptions {
  readonly scenario: AccountScenario;
  readonly seed: number;
  /**
   * 只在資料庫是空的時候才寫入。
   *
   * 容器啟動時會自動跑 seed，但**不該每次重啟都把資料洗掉** ——
   * 那會讓 demo 過程中下的單、切換的情境全部消失。
   * 加上這個旗標之後，只有第一次啟動（或手動清空後）才會真的寫入。
   *
   * 想強制重建時，就不要帶這個旗標。
   */
  readonly ifEmpty: boolean;
}

/**
 * 解析命令列參數。
 *
 * 支援 `--key=value` 形式。不用 commander 之類的套件是因為只有兩個參數，
 * 為此多一個相依不划算。
 *
 * @throws {Error} 情境名稱不合法或種子不是整數時
 */
function parseArgs(argv: readonly string[]): CliOptions {
  const args = new Map<string, string>();
  const flags = new Set<string>();

  for (const arg of argv) {
    const match = /^--([\w-]+)=(.*)$/.exec(arg);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      args.set(match[1], match[2]);
    } else if (arg.startsWith('--')) {
      flags.add(arg.slice(2));
    }
  }

  const scenario = (args.get('scenario') ?? 'active') as AccountScenario;
  if (!VALID_SCENARIOS.includes(scenario)) {
    throw new Error(
      `不認識的情境 "${scenario}"。可用的情境：${VALID_SCENARIOS.join('、')}`,
    );
  }

  const seedRaw = args.get('seed') ?? '42';
  const seed = Number(seedRaw);
  if (!Number.isInteger(seed)) {
    throw new Error(`種子必須是整數，收到 "${seedRaw}"`);
  }

  return { scenario, seed, ifEmpty: flags.has('if-empty') };
}

/**
 * 資料庫是否已經有 seed 過的資料。
 *
 * 判斷依據是 `users` 表有沒有資料 —— 它是所有業務資料的根，
 * 有使用者就代表 seed 跑過了。
 */
async function hasExistingData(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ count: string }>('SELECT count(*)::text FROM users');
  return Number(rows[0]?.count ?? '0') > 0;
}

/**
 * 清空所有業務資料。
 *
 * ── 為什麼用 TRUNCATE 而不是 DELETE ────────────────────────────────
 *
 * `DELETE FROM users` 會逐列刪除並寫入 WAL（預寫日誌），三千筆要花不少時間。
 * `TRUNCATE` 直接把整張表的資料檔案丟掉，幾乎是瞬間完成。
 *
 * `CASCADE` 會連帶清掉所有透過外鍵參照它的表 —— 也就是說，
 * 清掉 users 就等於清掉 accounts、positions、orders、transactions…
 * 一行搞定，而且不用煩惱刪除順序。
 *
 * ⚠️ **TRUNCATE 在真實系統是危險指令**（不可回滾到逐列、會清空整張表）。
 *    這裡可以用，前提是「這個資料庫的所有資料都是 seed 產生的」。
 *    這個前提在 P0 成立，之後也必須維持 —— 一旦有使用者手動建立的資料，
 *    這支腳本就會毀掉它。
 *
 * 保留 `schema_migrations` 不清 —— 那是結構版本記錄，不是業務資料。
 */
async function truncateAll(client: Queryable): Promise<void> {
  await client.query('TRUNCATE users, instruments RESTART IDENTITY CASCADE');
}

/**
 * 寫入標的，並回傳 symbol → id 的對照表。
 *
 * 後續寫持倉與明細時要用 instrument_id（UUID），但 factory 產生的資料
 * 是用 symbol 識別的，所以需要這張對照表。
 *
 * @returns symbol 對應到資料庫產生的 UUID
 */
async function insertInstruments(
  client: Queryable,
  data: SeedData,
): Promise<Map<string, string>> {
  const idBySymbol = new Map<string, string>();

  for (const instrument of INSTRUMENT_SEEDS) {
    const prevClose = data.closingPrices.get(instrument.symbol);
    if (prevClose === undefined) continue;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO instruments (symbol, name, market, lot_size, prev_close_cents)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [instrument.symbol, instrument.name, instrument.market, DEFAULT_LOT_SIZE, prevClose],
    );

    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error(`寫入標的 ${instrument.symbol} 後沒有拿到 id`);
    }
    idBySymbol.set(instrument.symbol, id);
  }

  return idBySymbol;
}

/**
 * 分批寫入大量資料列。
 *
 * ── 為什麼要分批 ──────────────────────────────────────────────────
 *
 * 8,000 筆明細如果一列一個 INSERT，就是 8,000 次來回 ——
 * 每次都要等網路往返，光是等待就會花掉數十秒。
 *
 * 把多列合併成一個 INSERT（`VALUES ($1,$2), ($3,$4), ...`）可以大幅減少往返。
 * 但也不能全部塞成一個 —— PostgreSQL 的單一查詢有**參數數量上限 65535**，
 * 超過會直接報錯。所以要分批。
 *
 * 每批的列數 = 上限 / 每列欄位數，這裡取保守值。
 *
 * @param client 資料庫連線
 * @param table 資料表名稱
 * @param columns 欄位名稱陣列
 * @param rows 資料列，每列是與 columns 對應的值陣列
 */
async function insertBatch(
  client: Queryable,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  if (rows.length === 0) return;

  // 留一點餘裕，不要卡在 65535 的邊緣。
  const maxRowsPerBatch = Math.floor(60_000 / columns.length);

  for (let start = 0; start < rows.length; start += maxRowsPerBatch) {
    const batch = rows.slice(start, start + maxRowsPerBatch);

    // 組出 ($1, $2, $3), ($4, $5, $6), ... 的佔位符字串。
    // 注意這裡拼接的是**佔位符**不是資料 —— 資料仍然透過參數陣列傳送，
    // 所以不存在 SQL Injection 的風險。
    const placeholders = batch
      .map(
        (_, rowIndex) =>
          `(${columns.map((__, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`).join(', ')})`,
      )
      .join(', ');

    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
      batch.flat() as unknown[],
    );
  }
}

/**
 * 主流程。
 */
/** `applySeed()` 寫完之後回報的摘要。Demo 控制台會把它顯示在畫面上。 */
export interface SeedSummary {
  readonly scenario: AccountScenario;
  readonly seed: number;
  readonly transactionCount: number;
  readonly positionCount: number;
  readonly snapshotCount: number;
  readonly cashBalanceCents: number;
}

/**
 * 能下查詢的東西。pg.Client、pg.PoolClient、以及 DatabaseService 的
 * TransactionClient 都符合這個形狀。
 *
 * 用結構型別而不是直接寫 `pg.Client`，是為了讓這個函式同時服務
 * CLI（自己開一條 Client）與 NestJS（連線池的交易）。
 */
interface Queryable {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
}

/**
 * 把指定情境的資料寫進資料庫（會先清空）。
 *
 * ── 為什麼要從 CLI 的 main() 裡抽出來 ★ ─────────────────────────
 *
 *   原本這段邏輯整個包在 `main()` 裡，只有指令列能用。但 Demo 控制台
 *   要在**服務執行中**切換情境（`POST /demo/scenario`），需要呼叫
 *   同一段邏輯。
 *
 *   複製一份到 demo 模組是最快的做法，也是最糟的 —— 兩份 seed 邏輯
 *   遲早會分岔，然後「用 CLI 灌的資料」和「用控制台切的資料」
 *   形狀不一樣，而這種 bug 只有在對照兩者時才會發現。
 *
 * ── ⚠️ 這個函式**不管理交易**，由呼叫端負責 ★ ────────────────────
 *
 *   跟 orders.repository.ts 同一個慣例：誰開交易誰負責傳連線進來。
 *
 *   原因是 NestJS 那一側會用 `db.transaction()` 包起來，那個方法
 *   自己會下 BEGIN / COMMIT。如果這裡也下一次，就會變成巢狀交易 ——
 *   PostgreSQL 不支援，內層的 COMMIT 會直接把外層一起提交掉，
 *   之後外層若要回滾就回不了了。
 *
 *   代價是呼叫端不能忘記包交易。忘了的話每一句 INSERT 都會
 *   autocommit，中途失敗就留下一半的資料 —— 而「一半的 seed 資料」
 *   比「沒有資料」難查得多，因為畫面看起來是有東西的，只是數字對不上。
 *
 * @param client 已經在交易中的連線
 */
export async function applySeed(
  client: Queryable,
  options: { scenario: AccountScenario; seed: number },
): Promise<SeedSummary> {
  const data = buildSeedData(options.scenario, options.seed);

  {
    await truncateAll(client);

    // 使用者與帳戶
    // id 明確給定（理由見 DEMO_USER_ID 的說明），不讓資料庫隨機產生。
    const userId = DEMO_USER_ID;
    const accountId = DEMO_ACCOUNT_ID;

    await client.query(
      `INSERT INTO users (id, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)`,
      [userId, DEMO_EMAIL, await AuthService.hashPassword(DEMO_PASSWORD), '示範帳戶'],
    );

    await client.query(
      `INSERT INTO accounts (id, user_id, account_no, cash_balance_cents, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [accountId, userId, '1234-5678', data.cashBalanceCents, 'TWD'],
    );

    // 標的
    const instrumentIds = await insertInstruments(client, data);

    // 持倉
    await insertBatch(
      client,
      'positions',
      ['account_id', 'instrument_id', 'quantity', 'avg_cost_cents'],
      data.positions.map((position) => [
        accountId,
        instrumentIds.get(position.symbol),
        position.quantity,
        position.avgCostCents,
      ]),
    );

    // 明細
    await insertBatch(
      client,
      'transactions',
      [
        'account_id',
        'type',
        'instrument_id',
        'quantity',
        'price_cents',
        'amount_cents',
        'balance_after_cents',
        'description',
        'occurred_at',
      ],
      data.transactions.map((tx) => [
        accountId,
        tx.type,
        tx.symbol === null ? null : (instrumentIds.get(tx.symbol) ?? null),
        tx.quantity,
        tx.priceCents,
        tx.amountCents,
        tx.balanceAfterCents,
        tx.description,
        tx.occurredAt.toISOString(),
      ]),
    );

    // 快照
    await insertBatch(
      client,
      'portfolio_snapshots',
      ['account_id', 'snapshot_date', 'cash_cents', 'market_value_cents', 'total_value_cents'],
      data.snapshots.map((snapshot) => [
        accountId,
        snapshot.date.toISOString().slice(0, 10), // DATE 欄位只要 YYYY-MM-DD
        snapshot.cashCents,
        snapshot.marketValueCents,
        snapshot.totalValueCents,
      ]),
    );

    return {
      scenario: options.scenario,
      seed: options.seed,
      transactionCount: data.transactions.length,
      positionCount: data.positions.length,
      snapshotCount: data.snapshots.length,
      cashBalanceCents: Number(data.cashBalanceCents),
    };
  }
}

/** 指令列進入點：解析參數 → 開連線 → 呼叫 applySeed → 印摘要。 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const client = new Client({
    host: env.postgres.host,
    port: env.postgres.port,
    user: env.postgres.user,
    password: env.postgres.password,
    database: env.postgres.database,
  });

  await client.connect();

  try {
    if (options.ifEmpty && (await hasExistingData(client))) {
      console.log('資料庫已有資料，略過 seed（要強制重建請拿掉 --if-empty）');
      return;
    }

    console.log(`情境：${options.scenario}｜種子：${options.seed}`);
    console.log('產生資料中…');

    // CLI 自己負責交易邊界（理由見 applySeed 的說明）。
    await client.query('BEGIN');
    let summary;
    try {
      summary = await applySeed(client, options);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    console.log(
      `  明細 ${summary.transactionCount} 筆｜` +
        `持倉 ${summary.positionCount} 檔｜` +
        `快照 ${summary.snapshotCount} 天`,
    );
    console.log('\n寫入完成。');
    console.log(`  帳戶餘額：NT$ ${(summary.cashBalanceCents / 100).toLocaleString('en-US')}`);
    console.log(`  demo 帳號：${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nSeed 失敗：');
  console.error(error);
  process.exit(1);
});
