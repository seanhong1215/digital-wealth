/**
 * market-feed/src/main.ts — 報價產生器
 *
 * 這個檔案是什麼：
 *   一個獨立的常駐程序。它從 PostgreSQL 讀出標的清單，
 *   然後每隔一段時間產生新的 tick 並 publish 到 Redis。
 *
 * 在架構的哪一層：
 *   獨立服務。它不屬於 api，也不被 api 呼叫 ——
 *   兩者唯一的關係是「一個 publish、一個 subscribe」。
 *
 * ── 為什麼要獨立成一個服務，不直接塞進 api 裡 ★ ──────────────────
 *
 *   塞進 api 用 setInterval 也能動，但那會失去這個服務最重要的價值：
 *
 *     **它可以被單獨關掉。**
 *
 *   PROJECT.md 的 P2 完成判準寫得很明確：
 *   「關掉 feed 服務後 5 秒內顯示『報價中斷』」。
 *
 *   這是一個必須能演示的降級情境 —— 面試官可以親眼看到
 *   `docker compose stop market-feed` 之後，報價轉灰、橫幅出現，
 *   但持倉、明細、下單通通還能用。如果報價邏輯住在 api 裡，
 *   要演這一段就得把整個後端關掉，那什麼都不能用了，
 *   證明不了「降級是設計的一部分」。
 *
 *   附帶好處：這個程序崩潰不會影響下單。
 *
 * ── 為什麼要連資料庫 ────────────────────────────────────────────
 *
 *   標的清單與昨收價是 seed 產生的，寫死在這裡會有兩份資料，
 *   遲早對不上。而且 `prev_close_cents` 決定漲跌停範圍 ——
 *   算錯的話 market-feed 會產生「使用者根本不能下單」的價格。
 *
 *   只在啟動時讀一次，之後全在記憶體裡跑。
 */

import pg from 'pg';
import { createClient } from 'redis';

import { QUOTE_CHANNEL, cents, type Quote } from '@digital-wealth/shared';

import { step, type WalkerState } from '@digital-wealth/shared/simulation';

// ============================================================================
// 設定
// ============================================================================

/**
 * 每一輪推送的間隔。
 *
 * 800ms 的取捨：低於 500ms 畫面會閃到讓人不舒服（而且真實個股
 * 也不會每半秒成交一次）；高於 2 秒則感覺不出「這是即時的」。
 */
const TICK_INTERVAL_MS = Number(process.env.FEED_TICK_INTERVAL_MS ?? 800);

/**
 * 每一輪更新幾檔標的。
 *
 * 不是每輪都更新全部 —— 真實市場裡，同一秒內只有一小部分標的
 * 有成交。每輪隨機挑幾檔，看起來比「所有數字同時跳動」自然得多。
 */
const SYMBOLS_PER_TICK = Number(process.env.FEED_SYMBOLS_PER_TICK ?? 12);

const config = {
  postgres: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'digital_wealth',
    password: process.env.POSTGRES_PASSWORD ?? 'digital_wealth',
    database: process.env.POSTGRES_DB ?? 'digital_wealth',
  },
  redisUrl: `redis://${process.env.REDIS_HOST ?? 'localhost'}:${process.env.REDIS_PORT ?? 6379}`,
};

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  log('啟動中…');

  // ── 讀標的清單 ────────────────────────────────────────────────
  const pool = new pg.Pool(config.postgres);
  const { rows } = await pool.query<{ symbol: string; prev_close_cents: string }>(
    `SELECT symbol, prev_close_cents::text AS prev_close_cents
       FROM instruments
      WHERE is_active = true
      ORDER BY symbol`,
  );
  await pool.end(); // 讀完就關 —— 這個服務之後不再需要資料庫

  if (rows.length === 0) {
    log('資料庫裡沒有任何可交易標的。是不是還沒跑 npm run seed？');
    process.exit(1);
  }

  const states: WalkerState[] = rows.map((row) => ({
    symbol: row.symbol,
    prevCloseCents: cents(Number(row.prev_close_cents)),
    // 開盤價 = 昨收價。真實市場會有跳空缺口，但那需要模擬隔夜消息，
    // 對本專案沒有加分，反而讓「漲跌 = 現價 − 昨收」的驗算變複雜。
    priceCents: cents(Number(row.prev_close_cents)),
    rawPriceCents: Number(row.prev_close_cents),
    volume: 0,
  }));

  log(`載入 ${states.length} 檔標的`);

  // ── 連 Redis ──────────────────────────────────────────────────
  const redis = createClient({ url: config.redisUrl });

  // 沒有這個監聽器的話，Redis 斷線會拋出未處理的錯誤事件，
  // 整個程序直接崩掉。node-redis 內建重連，我們只要別讓它炸掉。
  redis.on('error', (error) => log(`Redis 錯誤：${String(error)}`));
  redis.on('reconnecting', () => log('Redis 重新連線中…'));

  await redis.connect();
  log(`已連上 Redis：${config.redisUrl}`);
  log(`開始推送報價，每 ${TICK_INTERVAL_MS}ms 更新 ${SYMBOLS_PER_TICK} 檔`);

  // ── 主迴圈 ────────────────────────────────────────────────────
  const timer = setInterval(() => {
    void publishTick(redis, states);
  }, TICK_INTERVAL_MS);

  // ── 收工 ──────────────────────────────────────────────────────
  //
  // 沒有這一段的話，`docker compose stop` 會等 10 秒逾時再 SIGKILL。
  // 處理 SIGTERM 讓容器可以「乾淨地」停止 —— 這正是要演示的
  // 「關掉 feed 服務」情境，停得越乾脆，演示越流暢。
  const shutdown = async (signal: string): Promise<void> => {
    log(`收到 ${signal}，停止推送`);
    clearInterval(timer);
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * 推送一輪報價。
 *
 * 每次隨機挑 SYMBOLS_PER_TICK 檔更新，而不是全部 —— 理由見上方常數說明。
 */
async function publishTick(
  redis: ReturnType<typeof createClient>,
  states: WalkerState[],
): Promise<void> {
  const now = new Date().toISOString();

  for (let i = 0; i < SYMBOLS_PER_TICK; i += 1) {
    const state = states[Math.floor(Math.random() * states.length)];
    if (!state) continue;

    step(state);

    const quote: Quote = {
      symbol: state.symbol,
      priceCents: state.priceCents,
      prevCloseCents: state.prevCloseCents,
      volume: state.volume,
      at: now,
    };

    try {
      await redis.publish(QUOTE_CHANNEL, JSON.stringify(quote));
    } catch (error) {
      // 單筆發布失敗不該中斷整個服務 —— 下一輪就會補上新的價格。
      // 報價是「即時快照」而不是「事件流」，漏掉一筆沒有後果，
      // 這正是 docs/02-backend.md 說「重連期間的報價直接丟棄」的同一個道理。
      log(`發布失敗（已略過）：${String(error)}`);
    }
  }
}

function log(message: string): void {
  console.log(`[market-feed] ${new Date().toISOString()} ${message}`);
}

main().catch((error: unknown) => {
  log(`啟動失敗：${String(error)}`);
  process.exit(1);
});
