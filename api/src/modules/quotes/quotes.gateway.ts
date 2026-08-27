/**
 * api/src/modules/quotes/quotes.gateway.ts — 報價 WebSocket Gateway
 *
 * 這個檔案是什麼：
 *   `ws://localhost:3000/ws/quotes` 的處理者。它做三件事：
 *     1. 連線時驗證 JWT（從 cookie）
 *     2. 維護「誰訂閱了哪些標的」
 *     3. 從 Redis 收到報價後，只推給有訂閱的連線
 *
 * 在架構的哪一層：
 *   介面層，跟 Controller 平行。差別是 Controller 處理一次性的
 *   請求／回應，Gateway 處理長連線。
 *
 * ── 為什麼是 WebSocket，不是 SSE 或輪詢 ★ ────────────────────────
 *
 *     輪詢     每 2 秒打一次 API。延遲最差 2 秒，而且 90% 的請求
 *              回傳「沒有變化」—— 純浪費。使用者一多就是 DDoS 自己。
 *
 *     SSE      單向推送，比輪詢好。但**沒有 client → server 的通道**，
 *              而本專案需要 client 告訴 server「我現在在看哪幾檔」。
 *              用 SSE 就得再開一個 REST 端點管訂閱，兩個通道的
 *              狀態要同步，反而更複雜。
 *
 *     ✅ WS    雙向。訂閱、心跳、報價走同一條連線，狀態只有一份。
 *
 * ── 訂閱模型：Map<symbol, Set<client>> ──────────────────────────
 *
 *   不做全域廣播。持有 8 檔的使用者不該收到 500 檔的報價 ——
 *   那是 60 倍的頻寬浪費，而且前端還得自己過濾。
 *
 *   反向索引（symbol → clients）而不是 (client → symbols)，是因為
 *   熱路徑是「收到一筆報價，要推給誰」，每秒執行十幾次；
 *   而「這個 client 訂了什麼」只在斷線清理時才需要。
 *   照最頻繁的查詢方向建索引。
 *
 * 相關文件：docs/02-backend.md → WebSocket 協定
 */

import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

import {
  AUTH_COOKIE_NAME,
  QUOTES_WS_PATH,
  QUOTE_CHANNEL,
  clientMessageSchema,
  jwtPayloadSchema,
  quoteSchema,
  type ServerMessage,
} from '@digital-wealth/shared';

import { RedisService } from '../../redis/redis.service.js';

/** 每個連線最多能訂閱的標的數。防止有人送一萬檔把記憶體吃光。 */
const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;

@WebSocketGateway({ path: QUOTES_WS_PATH })
export class QuotesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(QuotesGateway.name);

  /**
   * 反向索引：標的 → 訂閱它的連線。
   *
   * 用 Set 而不是陣列：同一個 client 重複送 subscribe 不該被塞兩次，
   * 而且斷線時要 O(1) 刪除。
   */
  private readonly subscribers = new Map<string, Set<WebSocket>>();

  /**
   * 正向索引：連線 → 它訂閱的標的。
   *
   * 只在斷線清理時用到。沒有它的話，要清掉一個斷線的 client
   * 就得掃過 subscribers 裡的每一個 Set —— 500 檔標的就是 500 次掃描。
   *
   * 兩份索引要同步維護，這是典型的「用記憶體換時間」。
   */
  private readonly clientSubscriptions = new WeakMap<WebSocket, Set<string>>();

  constructor(
    private readonly redis: RedisService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 訂閱 Redis 的報價頻道。
   *
   * ── 為什麼要 `duplicate()` 一條新連線 ★ ────────────────────────
   *
   *   Redis 的連線一旦進入 subscribe 模式，就**只能下 subscribe 相關的指令**。
   *   如果直接拿 RedisService 那條共用連線來訂閱，OrdersService 的
   *   冪等鍵 `SET NX` 就會失敗，而且錯誤訊息（"only (P)SUBSCRIBE..."）
   *   完全看不出跟報價有關 —— 這是 Redis pub/sub 最經典的坑。
   *
   *   所以 pub/sub 一定要有自己的連線。
   *
   *   這也是 docs/adr/0003「Redis 只承擔兩個職責」在實作上的樣子：
   *   兩個職責、兩條連線，物理上就分開。
   */
  async onModuleInit(): Promise<void> {
    try {
      const subscriber = this.redis.getClient().duplicate();
      subscriber.on('error', (error: unknown) =>
        this.logger.warn(`報價訂閱連線錯誤：${String(error)}`),
      );

      await subscriber.connect();
      await subscriber.subscribe(QUOTE_CHANNEL, (raw: string) => this.onQuote(raw));

      this.logger.log(`已訂閱 Redis 頻道「${QUOTE_CHANNEL}」`);
    } catch (error) {
      // Redis 掛掉不該讓整個 API 起不來 —— 沒有報價時，
      // 持倉、明細、下單全都還能用。降級是設計的一部分。
      this.logger.warn(`報價訂閱失敗，即時報價將無法使用：${String(error)}`);
    }
  }

  // ==========================================================================
  // 連線生命週期
  // ==========================================================================

  /**
   * 連線建立。
   *
   * ── WebSocket 的認證跟 REST 不一樣 ★ ──────────────────────────
   *
   *   REST 有 Guard 可以掛，每個請求都會被攔一次。WebSocket 只有
   *   **握手時**是一個 HTTP 請求 —— 之後的訊息不再經過 HTTP 層，
   *   所以 Guard 那套完全用不上。
   *
   *   驗證只有這一次機會。通過之後這條連線就一直是認證過的，
   *   直到它斷開（或 token 過期，但我們不主動踢 —— 24 小時的
   *   token 撐得過任何一次瀏覽）。
   *
   *   cookie 在握手的 HTTP 請求 header 裡，所以這裡要自己 parse ——
   *   cookie-parser 中介層只作用在 Express 的路由上，不會碰到
   *   WebSocket 的握手請求。
   */
  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME);

    if (!token) {
      this.reject(client, 'AUTH_REQUIRED', '請先登入');
      return;
    }

    try {
      const payload = jwtPayloadSchema.parse(await this.jwtService.verifyAsync(token));
      this.logger.debug(`連線建立：帳戶 ${payload.accountId}`);
    } catch {
      this.reject(client, 'AUTH_REQUIRED', '登入已過期');
      return;
    }

    this.clientSubscriptions.set(client, new Set());

    // NestJS 的 ws 轉接層會把 message 事件轉成 @SubscribeMessage 處理器，
    // 但那需要訊息有固定的 { event, data } 形狀。本專案的協定是
    // { type, ... }（見 docs/02-backend.md），所以直接掛原生監聽器，
    // 契約由 shared 的 zod schema 保證。
    client.on('message', (raw: Buffer) => this.onClientMessage(client, raw));
  }

  /**
   * 連線關閉。
   *
   * ★ 這個方法漏掉任何一步都會造成記憶體洩漏 —— 而且是那種
   *   「開發時完全正常，跑三天之後記憶體爆掉」的洩漏。
   *   每一條斷掉的連線如果還留在 subscribers 裡，
   *   之後每一筆報價都會嘗試往一個死掉的 socket 寫入。
   */
  handleDisconnect(client: WebSocket): void {
    const symbols = this.clientSubscriptions.get(client);
    if (!symbols) return;

    for (const symbol of symbols) {
      const set = this.subscribers.get(symbol);
      if (!set) continue;

      set.delete(client);
      // 沒人訂閱的標的要把整個 Set 刪掉，否則 Map 會無限長大 ——
      // 留著一堆空 Set 也是洩漏，只是漏得比較慢。
      if (set.size === 0) this.subscribers.delete(symbol);
    }

    this.clientSubscriptions.delete(client);
  }

  // ==========================================================================
  // 訊息處理
  // ==========================================================================

  private onClientMessage(client: WebSocket, raw: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      this.send(client, { type: 'error', code: 'VALIDATION_FAILED', message: '訊息不是合法 JSON' });
      return;
    }

    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.send(client, {
        type: 'error',
        code: 'VALIDATION_FAILED',
        message: '不認識的訊息格式',
      });
      return;
    }

    const message = result.data;

    switch (message.type) {
      case 'ping':
        // 心跳。這個 pong 同時證明了兩件事：連線還在、後端還活著。
        this.send(client, { type: 'pong' });
        return;

      case 'subscribe':
        this.subscribe(client, message.symbols);
        return;

      case 'unsubscribe':
        this.unsubscribe(client, message.symbols);
        return;
    }
  }

  private subscribe(client: WebSocket, symbols: string[]): void {
    const current = this.clientSubscriptions.get(client);
    if (!current) return;

    if (current.size + symbols.length > MAX_SUBSCRIPTIONS_PER_CLIENT) {
      this.send(client, {
        type: 'error',
        code: 'SUBSCRIPTION_LIMIT',
        message: `單一連線最多訂閱 ${MAX_SUBSCRIPTIONS_PER_CLIENT} 檔標的`,
      });
      return;
    }

    for (const symbol of symbols) {
      current.add(symbol);

      let set = this.subscribers.get(symbol);
      if (!set) {
        set = new Set();
        this.subscribers.set(symbol, set);
      }
      set.add(client);
    }
  }

  private unsubscribe(client: WebSocket, symbols: string[]): void {
    const current = this.clientSubscriptions.get(client);
    if (!current) return;

    for (const symbol of symbols) {
      current.delete(symbol);

      const set = this.subscribers.get(symbol);
      if (!set) continue;

      set.delete(client);
      if (set.size === 0) this.subscribers.delete(symbol);
    }
  }

  /**
   * 收到 Redis 推來的報價 → 扇出給有訂閱的連線。
   *
   * 這是整個 Gateway 的熱路徑，每秒執行十幾次。所以：
   *   · 先查 Map（O(1)），沒人訂閱就直接 return，連 JSON.parse 都省
   *   · payload 只序列化一次，重複用於所有訂閱者
   */
  private onQuote(raw: string): void {
    let quote;
    try {
      quote = quoteSchema.parse(JSON.parse(raw));
    } catch {
      // market-feed 送來壞資料時記一筆就好。這是內部服務之間的
      // 訊息，壞掉代表版本不一致，不是使用者能修的問題。
      this.logger.warn('收到無法解析的報價訊息');
      return;
    }

    const targets = this.subscribers.get(quote.symbol);
    if (!targets || targets.size === 0) return;

    const payload = JSON.stringify({ type: 'quote', data: quote } satisfies ServerMessage);

    for (const client of targets) {
      // readyState 1 = OPEN。連線正在關閉的瞬間仍然在 Set 裡，
      // 對它寫入會拋錯 —— 檢查一下比包 try/catch 便宜。
      if (client.readyState === 1) client.send(payload);
    }
  }

  // ==========================================================================
  // 小工具
  // ==========================================================================

  private send(client: WebSocket, message: ServerMessage): void {
    if (client.readyState === 1) client.send(JSON.stringify(message));
  }

  /**
   * 拒絕連線。
   *
   * 先送出錯誤訊息再關閉，而不是直接 close —— 前端才能分辨
   * 「密碼錯了（不要重連）」和「網路斷了（該重連）」。
   * 直接關閉的話兩者在前端看起來一模一樣。
   */
  private reject(client: WebSocket, code: string, message: string): void {
    this.send(client, { type: 'error', code, message });
    client.close(4001, code);
  }
}

/**
 * 從 Cookie header 取出指定的值。
 *
 * 只做這一件事，所以不引入 cookie 套件。header 長這樣：
 *   `access_token=eyJhb...; other=value`
 *
 * ⚠️ `split('=')` 不能用 —— JWT 的 base64 padding 就是 `=`，
 *    切下去會把 token 尾巴砍掉。所以用 indexOf 只切第一個。
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    if (trimmed.slice(0, separator) === name) {
      return decodeURIComponent(trimmed.slice(separator + 1));
    }
  }

  return undefined;
}
