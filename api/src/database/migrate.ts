/**
 * api/src/database/migrate.ts — Migration 執行器
 *
 * 這個檔案是什麼：
 *   一支獨立的 CLI 腳本，把 `migrations/` 目錄下的 .sql 依序套用到資料庫，
 *   並記錄哪些已經執行過，避免重複執行。
 *
 * 為什麼要自己寫（而不是用 node-pg-migrate 之類的套件）：
 *   migration 執行器的核心邏輯只有四十行 —— 列出檔案、比對已執行清單、
 *   在交易內執行、記錄結果。自己寫的好處是**你完全知道它在做什麼**，
 *   而這正是本專案的學習目標。第三方套件會帶來自己的設定檔格式、
 *   up/down 的 DSL、以及一堆你用不到的功能。
 *
 *   ⚠️ 這個判斷有適用範圍。多人團隊、需要 rollback、需要跨環境同步時，
 *      成熟的 migration 工具是值得的。這裡的取捨前提是「單人、本機、
 *      且 migration 只會往前不會回頭」。
 *
 * 為什麼不做 down（rollback）：
 *   本專案的資料全部由 seed 產生，重建的成本趨近於零 ——
 *   出錯時直接砍掉資料庫重來，比維護一套 down migration 划算得多。
 *   真實系統有生產資料就完全不是這樣了。
 *
 * 在架構的哪一層：
 *   建置／維運工具，不屬於執行期的應用程式。它不依賴 NestJS，
 *   直接用 pg 連線 —— 因為為了跑 SQL 而啟動整個 DI 容器沒有意義。
 *
 * 執行方式：
 *   npm run migrate -w @fintech/api
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { env } from '../config/env.js';

const { Client } = pg;

/**
 * migrations 目錄的絕對路徑。
 *
 * ESM 沒有 CommonJS 的 `__dirname`，要從 `import.meta.url` 推導。
 * 用相對於這個檔案的路徑（而不是 `process.cwd()`），
 * 這樣不管從哪個目錄執行都能找到 SQL 檔。
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * 記錄已執行 migration 的資料表。
 *
 * 這張表本身不由 migration 建立（先有雞還是先有蛋的問題），
 * 而是由執行器在每次啟動時用 `IF NOT EXISTS` 確保存在。
 */
const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * 確保記錄表存在。
 *
 * `IF NOT EXISTS` 讓這個操作是冪等的 —— 執行幾次結果都一樣，
 * 不需要先查詢再判斷。
 */
async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version    TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 取得所有 migration 檔名，依檔名排序。
 *
 * **排序決定執行順序**，所以檔名的數字前綴必須補零對齊
 * （001、002…而不是 1、2…）—— 字串排序下 "10" 會排在 "2" 前面，
 * 補零可以避免這個經典陷阱。
 *
 * @returns 排序後的 .sql 檔名陣列
 */
async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/**
 * 取得已執行過的 migration 版本集合。
 *
 * 回傳 Set 而不是陣列，是為了後面的 `has()` 查詢是 O(1)。
 * migration 數量少的時候差別不大，但這是好習慣。
 */
async function getAppliedVersions(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    `SELECT version FROM ${MIGRATIONS_TABLE}`,
  );
  return new Set(rows.map((row) => row.version));
}

/**
 * 執行單一 migration。
 *
 * ── 為什麼整個 migration 要包在一個交易裡 ──────────────────────────
 *
 * 如果一份 migration 建了三張表，執行到第二張時語法錯誤 ——
 * 沒有交易的話，第一張表會留在資料庫裡，但 `schema_migrations` 沒有記錄。
 * 下次再跑會從頭開始，然後在第一張表卡住（already exists）。
 * 資料庫就此進入一個「不上不下」的狀態，只能手動清理。
 *
 * 包在交易裡之後，失敗就是全部沒發生，修好 SQL 再跑一次即可。
 *
 * **PostgreSQL 支援 DDL（CREATE TABLE 等）的交易回滾**，這點很關鍵 ——
 * MySQL 就不行，DDL 會隱式提交，所以 MySQL 的 migration 工具
 * 必須用完全不同的策略。這是選 PostgreSQL 的一個隱藏好處。
 *
 * @param client 資料庫連線
 * @param filename migration 檔名，同時作為版本識別碼
 * @throws SQL 執行失敗時（此時交易已回滾）
 */
async function applyMigration(client: pg.Client, filename: string): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');

  await client.query('BEGIN');
  try {
    await client.query(sql);

    // 記錄也在同一個交易內 —— 「SQL 執行了」與「記錄下來了」
    // 必須一起成功，否則就會有上面說的不一致狀態。
    await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (version) VALUES ($1)`, [filename]);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * 主流程。
 */
async function main(): Promise<void> {
  const client = new Client({
    host: env.postgres.host,
    port: env.postgres.port,
    user: env.postgres.user,
    password: env.postgres.password,
    database: env.postgres.database,
  });

  await client.connect();
  console.log(`已連線至 ${env.postgres.host}:${env.postgres.port}/${env.postgres.database}`);

  try {
    await ensureMigrationsTable(client);

    const files = await listMigrationFiles();
    const applied = await getAppliedVersions(client);
    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log(`沒有待執行的 migration（已套用 ${applied.size} 份）`);
      return;
    }

    console.log(`待執行 ${pending.length} 份 migration：`);
    for (const file of pending) {
      process.stdout.write(`  ${file} … `);
      await applyMigration(client, file);
      console.log('完成');
    }

    console.log(`\n全部完成，資料庫結構已是最新。`);
  } finally {
    // 無論成功失敗都要關連線，否則腳本會因為連線還開著而不結束。
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nMigration 失敗：');
  console.error(error);
  // 非零結束碼讓 CI 或 shell 腳本能偵測到失敗。
  process.exit(1);
});
