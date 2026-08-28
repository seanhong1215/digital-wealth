/**
 * api/src/modules/orders/orders.service.ts — 下單的業務邏輯 ★ 本專案最高價值的檔案
 *
 * 這個檔案是什麼：
 *   下單流程的編排者。它決定：檢查什麼、依什麼順序檢查、交易從哪裡開始
 *   到哪裡結束、失敗時怎麼收尾。
 *
 * 在架構的哪一層：
 *   Service（業務層）。上面是 Controller（只管 HTTP），下面是 Repository
 *   （只管 SQL）。所有「業務規則」都在這一層 —— 餘額夠不夠、能不能賣、
 *   費用怎麼算，都是這裡的事。
 *
 * ── 為什麼下單是整個專案最難的部分 ─────────────────────────────────
 *
 *   讀取路徑（查投組、查明細）錯了，使用者重新整理就好。
 *   寫入路徑錯了，錢就不見了 —— 而且是靜默不見，可能幾個月後對帳才發現。
 *
 *   下單要同時對抗三種問題，每一種都需要不同的機制：
 *
 *     問題              症狀                          機制
 *     ───────────────────────────────────────────────────────────────
 *     並行競態          兩個請求同時讀到舊餘額，       SELECT ... FOR UPDATE
 *     （lost update）   扣款互相覆蓋                   （行鎖）
 *
 *     部分失敗          扣了款但沒寫持倉，             BEGIN / COMMIT
 *                       錢憑空蒸發                     （原子性）
 *
 *     重複請求          使用者連點兩次，               冪等鍵
 *                       成立兩筆委託                   （Redis + DB UNIQUE）
 *
 *   三個機制互相獨立，缺一個就有一類 bug。這也是為什麼「下單」值得
 *   值得單獨拿出來談 —— 它不是 CRUD，是三個經典問題的交集。
 *
 * 相關文件：docs/02-backend.md → 交易一致性設計
 */

import { Injectable, Logger } from '@nestjs/common';

import {
  add,
  calculateTradeCost,
  cents,
  isInsufficient,
  isValidTick,
  isWithinPriceLimits,
  priceLimits,
  subtract,
  tickSize,
  weightedAverageCost,
  type Cents,
  type CreateOrderRequest,
  type Instrument,
  type OrderDraft,
  type OrderPreview,
  type OrderResult,
  type TradeCost,
} from '@digital-wealth/shared';

import { AppError, notFound } from '../../common/errors/app.error.js';
import { DatabaseService } from '../../database/database.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { OrdersRepository } from './orders.repository.js';

/**
 * 冪等鍵在 Redis 的存活時間（秒）。
 *
 * ── 為什麼是 5 分鐘 ─────────────────────────────────────────────
 *
 *   太短（5 秒）：使用者網路卡頓後重送，已超過視窗 → 變成重複下單
 *   太長（永久）：Redis 記憶體無限增長，而且「十分鐘後想再下一筆
 *                 一模一樣的單」這個合法行為會被誤擋
 *   5 分鐘：涵蓋所有合理的網路重試與連點情境，記憶體可控
 *
 *   注意這個 TTL 只影響「快速路徑」。真正的保證是資料庫
 *   `orders.idempotency_key` 的 UNIQUE 約束，那個是永久有效的。
 */
const IDEMPOTENCY_TTL_SECONDS = 300;

/** PostgreSQL 的「唯一性約束違反」錯誤碼。 */
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly ordersRepository: OrdersRepository,
  ) {}

  // ==========================================================================
  // 試算
  // ==========================================================================

  /**
   * 試算費用。純計算，無副作用。
   *
   * 確認頁要顯示「股款 1,085,000 ＋ 手續費 1,546 ＝ 總計 1,086,546」，
   * 這三個數字必須由後端算。前端當然也能 import 同一個
   * `calculateTradeCost()` 算出一樣的結果 —— 但**權威來源只能有一個**。
   *
   * 如果讓前端算完把總金額送給後端照扣，那就是把金額計算的信任邊界
   * 交給瀏覽器，改個 JS 變數就能一塊錢買台積電。
   *
   * @throws {AppError} 標的不存在、停止交易、或價格不合法
   */
  async preview(draft: OrderDraft): Promise<OrderPreview> {
    const instrument = await this.requireTradableInstrument(draft.symbol);
    this.assertPriceIsLegal(draft.limitPriceCents, instrument);

    const cost = calculateTradeCost(draft.limitPriceCents, draft.quantity, draft.side);

    return {
      grossCents: cost.gross,
      feeCents: cost.fee,
      taxCents: cost.tax,
      netCents: cost.net,
    };
  }

  // ==========================================================================
  // 下單 ★
  // ==========================================================================

  /**
   * 送出委託。
   *
   * ── 完整流程 ───────────────────────────────────────────────────
   *
   *   [交易外] 1. Redis 冪等檢查：SET idem:{key} NX EX 300
   *               → 已存在則直接回傳 DUPLICATE_REQUEST
   *            2. 標的檢查（存在、可交易、價格合法）
   *
   *   BEGIN;
   *            3. 鎖住帳戶：SELECT ... FOR UPDATE   ★
   *            4. 賣出時鎖住持倉並檢查股數
   *            5. 計算費用，買進時檢查餘額
   *            6. INSERT orders (PENDING)
   *            7. INSERT executions
   *            8. UPDATE accounts（餘額）
   *            9. UPSERT / DELETE positions
   *           10. INSERT transactions（成交 ＋ 手續費 ＋ 稅，各一列）
   *           11. UPDATE orders → FILLED
   *   COMMIT;
   *
   *   [失敗時] 釋放 Redis 冪等鍵，讓使用者修正後能重送
   *
   * ── 為什麼「標的檢查」在交易外，「餘額檢查」在交易內 ★ ──────────
   *
   *   判準是：**這個值在交易期間會不會被別人改掉？**
   *
   *     標的是否可交易 → 不會（管理者才能改，且極少發生）
   *                      → 放交易外，早點失敗，不必浪費一個連線
   *
   *     餘額是否足夠   → **會**（同一個帳戶的另一筆下單隨時在改）
   *                      → 必須在鎖住之後檢查，否則檢查等於沒檢查
   *
   *   把不會變的東西放進交易只會拉長持鎖時間，降低並行度。
   *
   * @param accountId 從 JWT 取得，前端無法指定（防 IDOR）
   * @param request 下單請求，已經過 zod 驗證
   * @throws {AppError} DUPLICATE_REQUEST / INSUFFICIENT_FUNDS / INSUFFICIENT_POSITION 等
   */
  async create(accountId: string, request: CreateOrderRequest): Promise<OrderResult> {
    // ── 步驟 1：冪等檢查（交易外）────────────────────────────────
    //
    // `SET key value NX EX 300` 是一個**原子操作**：
    //   NX = 只在 key 不存在時才設定
    //   EX = 設定存活秒數
    //
    // 原子性是關鍵。如果寫成「先 GET 看有沒有、沒有再 SET」，
    // 兩個請求可能同時 GET 到 null，然後都認為自己是第一個 ——
    // 這就是冪等機制自己踩到 TOCTOU，非常諷刺但很常見。
    //
    // 回傳 null 代表 key 已存在 → 這是重複請求。
    const claimed = await this.redis
      .getClient()
      .set(`idem:${request.idempotencyKey}`, accountId, {
        NX: true,
        EX: IDEMPOTENCY_TTL_SECONDS,
      });

    if (claimed === null) {
      throw new AppError('DUPLICATE_REQUEST', undefined, {
        idempotencyKey: request.idempotencyKey,
      });
    }

    try {
      // ── 步驟 2：標的檢查（交易外，理由見上方說明）─────────────
      const instrument = await this.requireTradableInstrument(request.symbol);
      this.assertPriceIsLegal(request.limitPriceCents, instrument);

      return await this.executeInTransaction(accountId, request, instrument);
    } catch (error) {
      // ── 失敗時釋放冪等鍵 ────────────────────────────────────
      //
      // 為什麼要釋放：使用者餘額不足被擋下，補錢之後想重送 ——
      // 如果 key 還鎖著，他會收到「這筆委託已經送出過了」，
      // 但明明一筆都沒成立。那是比原本的錯誤更難理解的錯誤。
      //
      // 釋放之後會不會有漏洞？不會。冪等鍵防的是「同一筆請求被重複執行」，
      // 而這裡的前提是**它一次都沒有執行成功**（交易已回滾，
      // orders 表裡連一列都沒有）。讓它可以重試才是正確行為。
      await this.releaseIdempotencyKey(request.idempotencyKey);
      throw error;
    }
  }

  /**
   * 交易內的 9 個步驟。抽成獨立方法純粹是為了讓 `create()` 的
   * 「交易外 / 交易內」邊界一眼看得出來。
   */
  private async executeInTransaction(
    accountId: string,
    request: CreateOrderRequest,
    instrument: Instrument,
  ): Promise<OrderResult> {
    return this.db.transaction(async (tx) => {
      // ── 步驟 3：鎖住帳戶 ★ ────────────────────────────────────
      //
      // 這一行之後，同一個帳戶的其他下單請求會卡在這裡等待，
      // 直到本交易結束。這正是我們要的 —— 餘額的檢查與扣款
      // 之間，不允許任何人插隊。
      const account = await this.ordersRepository.lockAccount(tx, accountId);
      if (!account) throw notFound('帳戶');

      // ── 步驟 4：賣出時檢查持股 ────────────────────────────────
      //
      // 鎖的順序固定為「先帳戶、後持倉」。所有寫入路徑都遵守同一個順序，
      // 否則兩個請求交錯上鎖就會死鎖。
      const position = await this.ordersRepository.lockPosition(tx, accountId, instrument.id);

      if (request.side === 'SELL') {
        const held = position?.quantity ?? 0;
        if (held < request.quantity) {
          throw new AppError('INSUFFICIENT_POSITION', undefined, {
            requiredQuantity: request.quantity,
            availableQuantity: held,
          });
        }
      }

      // ── 步驟 5：算錢，並檢查餘額 ──────────────────────────────
      //
      // calculateTradeCost() 來自 shared/market-rules.ts —— 前端試算、
      // 後端扣款、seed 產生歷史資料，三個地方用的是同一個函式。
      // 費率規則只寫一次，就不可能對不齊。
      const cost = calculateTradeCost(request.limitPriceCents, request.quantity, request.side);

      if (request.side === 'BUY' && isInsufficient(account.cashBalanceCents, cost.net)) {
        throw new AppError('INSUFFICIENT_FUNDS', undefined, {
          requiredCents: cost.net,
          availableCents: account.cashBalanceCents,
          // 差額直接算好給前端 —— 「還差 12,345 元」比讓前端自己減有用，
          // 也避免前端算錯（例如忘記這是分不是元）。
          shortfallCents: subtract(cost.net, account.cashBalanceCents),
        });
      }

      // ── 步驟 6：建立委託 ──────────────────────────────────────
      const orderId = await this.insertOrderHandlingDuplicate(tx, {
        accountId,
        instrumentId: instrument.id,
        side: request.side,
        quantity: request.quantity,
        limitPriceCents: request.limitPriceCents,
        idempotencyKey: request.idempotencyKey,
      });

      // ── 步驟 7：模擬撮合 ──────────────────────────────────────
      //
      // 本專案的「撮合」是：以限價全額成交，立刻。
      //
      // 為什麼不模擬部分成交或排隊等待：那需要一個假的市場深度，
      // 而憑空捏造的成交邏輯反而降低可信度。誠實的簡化 ——
      // 「限價單、全額成交」—— 比華麗的假撮合好，而且資料模型
      // （orders / executions 分表）已經為真實撮合預留了空間。
      const execution = await this.ordersRepository.insertExecution(tx, {
        orderId,
        quantity: request.quantity,
        priceCents: request.limitPriceCents,
        feeCents: cost.fee,
        taxCents: cost.tax,
      });

      // ── 步驟 8：更新餘額 ──────────────────────────────────────
      const balanceAfter =
        request.side === 'BUY'
          ? subtract(account.cashBalanceCents, cost.net)
          : add(account.cashBalanceCents, cost.net);

      await this.ordersRepository.updateAccountBalance(tx, accountId, balanceAfter);

      // ── 步驟 9：更新持倉 ──────────────────────────────────────
      if (request.side === 'BUY') {
        // 加權平均成本用「成交價」算，不含手續費。
        // 這是台股券商 App 的慣例 —— 手續費另計為費用，不併入成本。
        const nextAvgCost = weightedAverageCost(
          position?.quantity ?? 0,
          position?.avgCostCents ?? cents(0),
          request.quantity,
          request.limitPriceCents,
        );

        await this.ordersRepository.upsertPosition(tx, {
          accountId,
          instrumentId: instrument.id,
          quantity: (position?.quantity ?? 0) + request.quantity,
          avgCostCents: nextAvgCost,
        });
      } else {
        // 賣出：position 一定存在（步驟 4 已經檢查過股數足夠）
        await this.ordersRepository.reducePosition(
          tx,
          position!.id,
          position!.quantity - request.quantity,
        );
      }

      // ── 步驟 10：寫流水帳 ─────────────────────────────────────
      await this.writeLedger(tx, {
        accountId,
        orderId,
        instrument,
        side: request.side,
        quantity: request.quantity,
        priceCents: request.limitPriceCents,
        cost,
        openingBalance: account.cashBalanceCents,
      });

      // ── 步驟 11：委託完成 ─────────────────────────────────────
      await this.ordersRepository.markOrderFilled(tx, orderId);

      return {
        order: {
          id: orderId,
          instrument,
          side: request.side,
          orderType: 'LIMIT' as const,
          quantity: request.quantity,
          limitPriceCents: request.limitPriceCents,
          status: 'FILLED' as const,
          rejectReason: null,
          createdAt: execution.executedAt,
        },
        execution,
        cashBalanceCents: balanceAfter,
      };
    });
  }

  // ==========================================================================
  // 查詢
  // ==========================================================================

  /**
   * 查詢單一委託。結果頁重新整理後要靠這個把畫面還原。
   *
   * @param accountId 來自 JWT。Repository 會把它放進 WHERE，防 IDOR
   */
  async findById(accountId: string, orderId: string) {
    const result = await this.ordersRepository.findOrderById(orderId, accountId);
    if (!result) throw notFound('委託');
    return result;
  }

  // ==========================================================================
  // 私有輔助
  // ==========================================================================

  /**
   * 寫入這筆成交產生的所有流水。
   *
   * ── 為什麼一筆買進要寫「兩列」流水（成交 ＋ 手續費）★ ──────────
   *
   *   直覺會想寫一列「買進台積電，−1,086,546 元」就好。但實務上要分開，
   *   因為股款與費用在會計上是不同科目：股款轉成資產（持倉），
   *   手續費是費用（直接損失）。對帳、報稅、算真實報酬率都需要區分。
   *
   *   賣出則是三列：成交（＋股款）、手續費（−）、證交稅（−）。
   *
   *   每一列都帶著**當下的結餘**，而且結餘必須嚴格連續：
   *
   *     起始 1,000,000
   *     BUY  −800,000 → balance_after 200,000
   *     FEE  −1,140   → balance_after 198,860   ← 接續上一列
   *
   *   seed 產生的歷史資料用的是同一套規則，所以使用者現在下的單
   *   和三個月前的歷史明細，在明細頁上看起來完全一致。
   */
  private async writeLedger(
    tx: Parameters<Parameters<DatabaseService['transaction']>[0]>[0],
    params: {
      accountId: string;
      orderId: string;
      instrument: Instrument;
      side: 'BUY' | 'SELL';
      quantity: number;
      priceCents: Cents;
      cost: TradeCost;
      openingBalance: Cents;
    },
  ): Promise<void> {
    const { accountId, orderId, instrument, side, quantity, priceCents, cost } = params;
    const qtyLabel = quantity.toLocaleString('en-US');

    // 三列流水各相隔 1 秒，讓明細頁的排序穩定（理由見 insertTransaction 的說明）。
    const baseTime = Date.now();
    const at = (indexInTrade: number) => new Date(baseTime + indexInTrade * 1000);

    // 第一列：成交本身
    let running =
      side === 'BUY'
        ? subtract(params.openingBalance, cost.gross)
        : add(params.openingBalance, cost.gross);

    await this.ordersRepository.insertTransaction(tx, {
      accountId,
      type: side,
      instrumentId: instrument.id,
      quantity,
      priceCents,
      amountCents: side === 'BUY' ? cents(-cost.gross) : cost.gross,
      balanceAfterCents: running,
      orderId,
      description: `${side === 'BUY' ? '買進' : '賣出'} ${instrument.name} ${qtyLabel} 股`,
      occurredAt: at(0),
    });

    // 第二列：手續費（買賣都有）
    running = subtract(running, cost.fee);
    await this.ordersRepository.insertTransaction(tx, {
      accountId,
      type: 'FEE',
      instrumentId: instrument.id,
      quantity: null,
      priceCents: null,
      amountCents: cents(-cost.fee),
      balanceAfterCents: running,
      orderId,
      description: `手續費 — ${instrument.name}`,
      occurredAt: at(1),
    });

    // 第三列：證交稅（只有賣出才收）
    if (cost.tax > 0) {
      running = subtract(running, cost.tax);
      await this.ordersRepository.insertTransaction(tx, {
        accountId,
        type: 'TAX',
        instrumentId: instrument.id,
        quantity: null,
        priceCents: null,
        amountCents: cents(-cost.tax),
        balanceAfterCents: running,
        orderId,
        description: `證券交易稅 — ${instrument.name}`,
        occurredAt: at(2),
      });
    }
  }

  /**
   * 建立委託，並把資料庫的唯一性違反翻譯成業務錯誤。
   *
   * ── 為什麼 Redis 已經擋過了還需要這一層 ★ ────────────────────────
   *
   *   Redis 是**快速路徑**，不是保證。它會在這些情況失手：
   *
   *     · Redis 重啟 → 記憶體資料全沒了
   *     · 超過 5 分鐘 TTL → key 已過期
   *     · Redis 連不上 → 這一層等於不存在
   *
   *   資料庫的 `UNIQUE (idempotency_key)` 是**永久且不會失手**的那一層。
   *   兩層互補：99% 的重複請求被 Redis 擋在交易外（便宜），
   *   漏網的被資料庫擋住（可靠）。
   *
   *   這就是「快速路徑 ＋ 正確性後盾」的典型模式。
   */
  private async insertOrderHandlingDuplicate(
    tx: Parameters<Parameters<DatabaseService['transaction']>[0]>[0],
    params: Parameters<OrdersRepository['insertOrder']>[1],
  ): Promise<string> {
    try {
      return await this.ordersRepository.insertOrder(tx, params);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
      ) {
        this.logger.warn(`冪等鍵在資料庫層撞重複：${params.idempotencyKey}（Redis 那層漏了）`);
        throw new AppError('DUPLICATE_REQUEST', undefined, {
          idempotencyKey: params.idempotencyKey,
        });
      }
      throw error;
    }
  }

  /** 標的必須存在且可交易。 */
  private async requireTradableInstrument(symbol: string): Promise<Instrument> {
    const instrument = await this.ordersRepository.findInstrument(symbol);
    if (!instrument) throw notFound('標的');

    if (!instrument.isActive) {
      throw new AppError('INSTRUMENT_NOT_TRADABLE', undefined, { symbol });
    }

    return instrument;
  }

  /**
   * 價格必須落在合法跳動點上，且在今日漲跌停之內。
   *
   * ── 為什麼兩種違規共用同一個錯誤碼 ────────────────────────────
   *
   *   「1085.03 不是合法報價」與「1300 超過漲停」在使用者眼中是同一件事：
   *   價格欄位填錯了。前端的處理也一樣 —— 把訊息顯示在價格欄位下方。
   *
   *   需要區分時看 `details.reason`。錯誤碼的粒度應該對應
   *   「前端要做的事」，不是「後端的判斷分支」—— 分太細只會讓
   *   前端寫出一堆長得一樣的 switch 分支。
   */
  private assertPriceIsLegal(price: Cents, instrument: Instrument): void {
    if (!isValidTick(price)) {
      throw new AppError('PRICE_OUT_OF_RANGE', '委託價格不是合法的升降單位', {
        reason: 'INVALID_TICK',
        priceCents: price,
        tickCents: tickSize(price),
      });
    }

    if (!isWithinPriceLimits(price, instrument.prevCloseCents)) {
      const limits = priceLimits(instrument.prevCloseCents);
      throw new AppError('PRICE_OUT_OF_RANGE', undefined, {
        reason: 'DAILY_LIMIT',
        priceCents: price,
        upperLimitCents: limits.upper,
        lowerLimitCents: limits.lower,
      });
    }
  }

  /**
   * 釋放冪等鍵。刻意吞掉錯誤 ——
   * 這是清理動作，不該蓋掉使用者真正該看到的那個錯誤。
   */
  private async releaseIdempotencyKey(key: string): Promise<void> {
    try {
      await this.redis.getClient().del(`idem:${key}`);
    } catch (error) {
      this.logger.warn(`釋放冪等鍵失敗（5 分鐘後會自動過期）：${key}`, error);
    }
  }
}
