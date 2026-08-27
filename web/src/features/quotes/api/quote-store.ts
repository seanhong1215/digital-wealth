/**
 * web/src/features/quotes/api/quote-store.ts — 報價連線與快取
 *
 * 這個檔案是什麼：
 *   一個「外部 store」—— 它活在 React 之外，自己管 WebSocket 連線、
 *   自己存最新報價、自己處理重連。React 元件透過 useSyncExternalStore
 *   訂閱它感興趣的那幾檔。
 *
 * 在架構的哪一層：
 *   feature 的 api 層。元件不直接碰 WebSocket，就像元件不直接碰 fetch。
 *
 * ── 為什麼報價不放 TanStack Query 或 useState ★ ─────────────────
 *
 *   TanStack Query 是為「請求 → 回應」設計的。報價是**伺服器主動推送**，
 *   沒有對應的請求；硬塞進 Query 要用 setQueryData 手動灌，
 *   等於只借用它的儲存空間，得不到快取、重試、失效那些好處。
 *
 *   放 useState / Context 則有效能問題：報價每秒十幾筆，如果每筆都
 *   讓 Context 重新 render，整棵樹都會跟著重畫 —— 明細列表捲到一半
 *   會卡頓，而使用者根本沒在看那個數字。
 *
 *   ✅ 外部 store + useSyncExternalStore：**每檔標的有自己的監聽清單**。
 *      2330 的報價進來，只有正在顯示 2330 的那一列會 re-render。
 *      持倉頁有 11 檔，一筆報價只重畫 1/11 的畫面。
 *
 *   useSyncExternalStore 是 React 18 為了這個情境加的官方 API，
 *   它同時解決了併發渲染下的「撕裂」（同一次渲染中不同元件讀到
 *   不同版本的資料）問題。自己用 useEffect + forceUpdate 兜是做不到的。
 *
 * 相關文件：docs/02-backend.md → WebSocket 協定、報價新鮮度狀態機
 */

import {
  CONNECTION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  QUOTES_WS_PATH,
  QUOTE_STALE_AFTER_MS,
  RECONNECT_BACKOFF_MS,
  RECONNECT_JITTER_MS,
  serverMessageSchema,
  type Quote,
} from '@fintech/shared';

// ============================================================================
// 型別
// ============================================================================

/** 連線狀態。 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * 單一標的的報價新鮮度。
 *
 *   live          剛收到報價，數字是即時的
 *   stale         連線正常，但這檔超過 5 秒沒有新報價 → 數字轉灰
 *   disconnected  連線斷了 → 保留最後的值，但標示為舊資料
 *
 * ★ stale 和 disconnected 是不同的事，不能合併：
 *   stale 是「這檔股票剛好沒人在交易」（正常現象，其他檔還在跳），
 *   disconnected 是「我們跟伺服器斷了」（全部的數字都不能信）。
 *   合併成一個狀態的話，使用者會以為冷門股讓整個系統掛掉了。
 */
export type QuoteFreshness = 'live' | 'stale' | 'disconnected';

/**
 * 整個報價來源的狀態（不是單一標的）。
 *
 * ── 為什麼需要這一層，逐檔的 freshness 還不夠 ★ ─────────────────
 *
 *   逐檔的 stale 是正常現象 —— 冷門股本來就可能五秒沒成交，
 *   旁邊那檔還在跳。所以它只配得上一個小標籤。
 *
 *   但如果 **每一檔都停了**，那不是冷門，是 market-feed 掛了。
 *   這時使用者看到的是一整頁靜止的數字，而每一列旁邊都掛著
 *   一個容易忽略的小「延遲」—— 他很可能根本沒注意到，
 *   以為那些就是現在的價格。
 *
 *   所以要區分兩種情況：
 *
 *     live         正常
 *     stalled      連線還在，但**完全沒有**報價進來 → market-feed 掛了
 *                  → 值得一條橫幅
 *     disconnected WebSocket 斷了 → 也是橫幅，但訊息不同
 *
 *   這正是 PROJECT.md 的 P2 完成判準要驗的東西：
 *   「關掉 feed 服務後 5 秒內顯示報價中斷」。
 */
export type FeedStatus = 'live' | 'stalled' | 'disconnected';

/** 存在 store 裡的報價，多帶一個「何時收到的」用來判斷新鮮度。 */
export interface StoredQuote {
  readonly quote: Quote;
  readonly receivedAt: number;
}

// ============================================================================
// Store
// ============================================================================

type Listener = () => void;

class QuoteStore {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';

  private readonly quotes = new Map<string, StoredQuote>();

  /**
   * 每檔標的的監聽者。
   *
   * 這個 Map 是整個效能設計的核心 —— 收到 2330 的報價時，
   * 只通知 `listeners.get('2330')` 裡的那幾個元件。
   */
  private readonly listeners = new Map<string, Set<Listener>>();

  /** 連線狀態的監聽者（橫幅元件用）。 */
  private readonly statusListeners = new Set<Listener>();

  /**
   * 「任何一檔有新報價」的監聽者，以及一個單調遞增的版本號。
   *
   * 為什麼需要這一組：總資產市值是**所有持倉的加總**，
   * 任何一檔跳動都要重算。逐檔訂閱做不到這件事 ——
   * hook 不能寫在迴圈裡，而且總和本來就是一個整體的值。
   *
   * 版本號是給 useSyncExternalStore 用的：它比對 getSnapshot 的
   * 回傳值決定要不要重畫，所以那個值必須是**穩定的原始型別**。
   * 回傳計算好的總和會每次都是新數字（浮點），回傳陣列或物件
   * 則每次都是新參考 —— 兩者都會造成無限重畫。
   * 一個遞增的整數是最省事也最正確的做法。
   */
  private readonly anyListeners = new Set<Listener>();
  private version = 0;

  /** 最後一次收到「任何一檔」報價的時間。用來判斷 market-feed 是否還活著。 */
  private lastQuoteAt = 0;

  /**
   * 訂閱引用計數。
   *
   * 為什麼需要計數而不是只記「有沒有人訂」：總覽頁顯示 2330，
   * 使用者點進 2330 的下單頁，兩個畫面同時訂閱同一檔。
   * 離開下單頁時如果直接 unsubscribe，總覽頁的數字就不會動了。
   * 計數歸零才真正送 unsubscribe。
   */
  private readonly subscriptionCounts = new Map<string, number>();

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private connectedAt = 0;

  // ── 對外 API ──────────────────────────────────────────────────

  /** 連線狀態。給 useSyncExternalStore 用的 getSnapshot。 */
  getStatus = (): ConnectionStatus => this.status;

  subscribeStatus = (listener: Listener): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  /** 報價版本號。任何一檔有新報價就 +1。 */
  getVersion = (): number => this.version;

  subscribeAny = (listener: Listener): (() => void) => {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  };

  /**
   * 整個報價來源的狀態。
   *
   * 判斷順序有意義：先看連線，再看有沒有資料流進來。
   * 連線都斷了就不必談報價新不新鮮。
   */
  getFeedStatus = (): FeedStatus => {
    if (this.status !== 'connected') return 'disconnected';

    // 還沒有任何訂閱時不算異常 —— 例如使用者停在一個沒有持倉的空狀態頁。
    if (this.subscriptionCounts.size === 0) return 'live';

    // 一筆都沒收過（剛連上），給它一個寬限期再判定，
    // 否則進站的頭幾秒一定會閃一次橫幅。
    const reference = this.lastQuoteAt === 0 ? this.connectedAt : this.lastQuoteAt;
    return Date.now() - reference > QUOTE_STALE_AFTER_MS ? 'stalled' : 'live';
  };

  /** 取得某檔的最新報價。沒有收過就是 undefined。 */
  getQuote = (symbol: string): StoredQuote | undefined => this.quotes.get(symbol);

  /** 判斷某檔的新鮮度。 */
  getFreshness = (symbol: string): QuoteFreshness => {
    if (this.status !== 'connected') return 'disconnected';

    const stored = this.quotes.get(symbol);
    if (!stored) return 'stale';

    return Date.now() - stored.receivedAt > QUOTE_STALE_AFTER_MS ? 'stale' : 'live';
  };

  /**
   * 訂閱一組標的，回傳取消訂閱的函式。
   *
   * 元件在 useEffect 裡呼叫這個，離開畫面時自動取消 ——
   * 這就是「只訂閱畫面上看得到的標的」的實作。
   */
  subscribeSymbols = (symbols: readonly string[]): (() => void) => {
    const added: string[] = [];

    for (const symbol of symbols) {
      const count = this.subscriptionCounts.get(symbol) ?? 0;
      this.subscriptionCounts.set(symbol, count + 1);
      if (count === 0) added.push(symbol);
    }

    if (added.length > 0) this.send({ type: 'subscribe', symbols: added });
    this.ensureConnected();

    return () => {
      const removed: string[] = [];

      for (const symbol of symbols) {
        const count = this.subscriptionCounts.get(symbol) ?? 0;
        if (count <= 1) {
          this.subscriptionCounts.delete(symbol);
          removed.push(symbol);
        } else {
          this.subscriptionCounts.set(symbol, count - 1);
        }
      }

      if (removed.length > 0) this.send({ type: 'unsubscribe', symbols: removed });
    };
  };

  /** 監聽單一標的的報價變動。 */
  subscribeQuote = (symbol: string, listener: Listener): (() => void) => {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
    }
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(symbol);
    };
  };

  // ── 連線管理 ──────────────────────────────────────────────────

  private ensureConnected(): void {
    if (this.socket || this.status === 'connecting') return;
    this.connect();
  }

  private connect(): void {
    this.setStatus('connecting');

    // ws:// 或 wss:// 由當前頁面的協定決定。寫死 ws:// 的話，
    // 未來若走 HTTPS，瀏覽器會擋掉「安全頁面連不安全的 WebSocket」。
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}${QUOTES_WS_PATH}`);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.connectedAt = Date.now();
      this.setStatus('connected');

      // ★ 重連之後必須重新訂閱 —— 伺服器不保存訂閱狀態。
      //
      // 少了這一段，斷線重連之後畫面會「連上了但數字不動」，
      // 而且連線狀態顯示正常，是最難查的那種 bug。
      const symbols = [...this.subscriptionCounts.keys()];
      if (symbols.length > 0) this.send({ type: 'subscribe', symbols });

      this.startHeartbeat();
      this.startFreshnessTicker();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      this.lastMessageAt = Date.now();
      this.onMessage(event.data);
    };

    socket.onclose = () => {
      this.teardown();
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onerror 之後一定會有 onclose，重連邏輯統一放在那裡。
      // 兩邊都寫會排兩次重連，退避時間就亂掉了。
      socket.close();
    };
  }

  /**
   * 排程重連 —— 指數退避 ＋ 隨機抖動。
   *
   * ── 為什麼要 jitter ★ ────────────────────────────────────────
   *
   *   後端重啟時，所有客戶端在同一瞬間斷線，也就會在同一瞬間重連。
   *   後端剛起來就被打爆，可能再倒一次 —— 這叫重連風暴
   *   （thundering herd）。加上 0–1000ms 的隨機抖動把它們打散。
   *
   *   一行程式碼的成本，換掉一個只在正式環境才會出現的災難。
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const base =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)] ??
      30_000;
    const delay = base + Math.random() * RECONNECT_JITTER_MS;

    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * 心跳。
   *
   * ── 為什麼 TCP 連線沒斷不代表連線是通的 ★ ─────────────────────
   *
   *   「半開連線」：手機從 Wi-Fi 切到行動網路、或中間的 NAT 逾時，
   *   本地的 socket 仍然是 OPEN 狀態，但送出去的封包永遠到不了。
   *   瀏覽器不會觸發 onclose —— 它不知道對面已經不見了。
   *
   *   結果是使用者盯著一個「連線正常」但數字凍住的畫面。
   *
   *   解法是主動送 ping 並要求回應。超過 45 秒（兩次心跳）
   *   沒收到任何訊息就自己斷開重連。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > CONNECTION_TIMEOUT_MS) {
        // 主動關閉會觸發 onclose → 重連流程。
        this.socket?.close();
        return;
      }
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 新鮮度計時器。
   *
   * 為什麼需要它：`live → stale` 這個轉換**不是由任何事件觸發的**，
   * 它是「時間過去了而什麼都沒發生」。沒有計時器定期喚醒，
   * 一檔冷門股會永遠停留在 live 狀態，數字不變但顯示為即時。
   *
   * 每秒喚醒一次所有監聽者重算新鮮度。成本很低，
   * 而且只有正在顯示報價的元件才有監聽者。
   */
  private startFreshnessTicker(): void {
    if (this.freshnessTimer) return;

    this.freshnessTimer = setInterval(() => {
      for (const listeners of this.listeners.values()) {
        for (const listener of listeners) listener();
      }

      // ★ 連線狀態的監聽者也要叫醒。
      //
      // `live → stalled` 這個轉換不是由任何事件觸發的 —— 它是
      // 「時間過去了而什麼都沒發生」。少了這一行，market-feed 掛掉時
      // 橫幅永遠不會出現，因為沒有任何東西促使那個元件重新渲染。
      for (const listener of this.statusListeners) listener();
    }, 1_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private teardown(): void {
    this.socket = null;
    this.stopHeartbeat();
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.freshnessTimer = null;
  }

  // ── 訊息 ──────────────────────────────────────────────────────

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const result = serverMessageSchema.safeParse(parsed);
    if (!result.success) return;

    const message = result.data;

    if (message.type === 'quote') {
      this.quotes.set(message.data.symbol, {
        quote: message.data,
        receivedAt: Date.now(),
      });

      // ★ 只通知這一檔的監聽者。這一行是整個效能設計的成果。
      const listeners = this.listeners.get(message.data.symbol);
      if (listeners) for (const listener of listeners) listener();

      // 需要「任何一檔變動就重算」的元件（總資產市值）另外通知。
      this.lastQuoteAt = Date.now();
      this.version += 1;
      for (const listener of this.anyListeners) listener();
    }

    // pong 不需要處理 —— 收到它就已經更新了 lastMessageAt，目的達成。
    // error 目前也只在連線被拒時出現，後續的 onclose 會處理重連。
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
    // 沒連上就直接丟掉。不做佇列是刻意的 —— 重連成功時
    // onopen 會用當下的 subscriptionCounts 重新訂閱一次，
    // 那才是正確的狀態。補送舊訊息反而可能訂到已經離開的畫面。
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) listener();
  }
}

/**
 * 全域唯一的 store。
 *
 * 為什麼是模組層級的單例而不是 React Context：
 *   一個瀏覽器分頁只該有**一條** WebSocket 連線。如果做成 Context
 *   並在多處建立 Provider，就會開出多條連線，伺服器端的訂閱管理
 *   也會亂掉。單例讓「只有一條」這件事由模組系統保證。
 *
 *   代價是測試時不好抽換 —— 但報價 store 的測試本來就該直接測
 *   這個類別，而不是透過元件。
 */
export const quoteStore = new QuoteStore();
