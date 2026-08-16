/**
 * api/src/config/env.ts — 環境變數的讀取與驗證
 *
 * 這個檔案是什麼：
 *   把 `process.env` 裡那一堆 `string | undefined` 轉換成一個
 *   型別明確、值保證存在的設定物件。
 *
 * 為什麼存在（為什麼不直接在需要的地方讀 process.env）：
 *   1. `process.env.FOO` 的型別永遠是 `string | undefined`，
 *      每個使用的地方都要處理 undefined，很快就會有人寫 `!` 混過去
 *   2. **設定錯誤要在啟動時就爆炸，而不是在第一個請求進來時**。
 *      少設一個 JWT_SECRET，寧可服務起不來，也不要跑了三小時之後
 *      才在某個端點噴 500
 *   3. 集中管理，看這一個檔案就知道這個服務需要哪些設定
 *
 * 在架構的哪一層：
 *   最外層的邊界。它是「作業系統」與「應用程式」之間的轉接頭，
 *   下面所有模組拿到的都是已驗證的值。
 *
 * ⚠️ 未來會改用 zod（單元 0.4 起 shared/ 會有 zod）。
 *    現在手寫是為了不讓 P0 的相依變複雜；改寫時介面不變。
 */

/**
 * 讀取必填的環境變數。
 *
 * @param key 變數名稱
 * @returns 變數的值
 * @throws {Error} 變數未設定或為空字串時。錯誤訊息會指向 .env.example，
 *                 讓看到這個錯誤的人知道去哪裡查該設什麼
 */
function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `缺少必要的環境變數 ${key}。` +
        `請參考專案根目錄的 .env.example，複製一份成 .env 並填入值。`,
    );
  }
  return value;
}

/**
 * 讀取選填的環境變數，未設定時回傳預設值。
 *
 * @param key 變數名稱
 * @param fallback 未設定時使用的預設值
 */
function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * 讀取數字型的環境變數。
 *
 * 環境變數永遠是字串，`PORT=abc` 這種錯誤如果不檢查，
 * 會變成 `NaN` 一路往下傳，最後在某個看不出關聯的地方爆炸。
 *
 * @param key 變數名稱
 * @param fallback 未設定時使用的預設值
 * @throws {Error} 值無法解析成整數時
 */
function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`環境變數 ${key} 必須是整數，收到 "${raw}"`);
  }
  return parsed;
}

/**
 * 應用程式設定。
 *
 * 在模組載入時就完成讀取與驗證 —— 也就是說，只要有任何一個必填變數
 * 沒設定，`import` 這個檔案的當下就會拋錯，服務根本起不來。
 * 這是刻意的：**設定錯誤要用最大的音量、在最早的時間點被發現。**
 */
export const env = {
  /**
   * 執行環境。
   *
   * 影響：Demo 控制台是否掛載（Phase 4）、錯誤回應是否含 stack trace。
   * 預設 `development` 而不是 `production` —— 預設值要往「安全但囉唆」
   * 的方向倒，忘記設定時頂多是多印一些日誌，不會意外把 debug 資訊
   * 洩漏到正式環境。
   */
  nodeEnv: optional('NODE_ENV', 'development'),

  /** API 服務監聽的 port。 */
  port: optionalInt('API_PORT', 3000),

  /** PostgreSQL 連線設定。 */
  postgres: {
    /**
     * 主機位址。
     *
     * 這個值會因為「你從哪裡連」而不同，是新手最常卡住的地方：
     *   - 從 Docker 容器內連 → `postgres`（Docker Compose 的服務名稱，
     *     Docker 內建的 DNS 會解析成該容器的 IP）
     *   - 從你的電腦連（npm run start:dev）→ `localhost`
     *
     * 預設值取 `localhost`，因為本機開發是比較常見的情況；
     * docker-compose.yml 裡會明確覆寫成 `postgres`。
     */
    host: optional('POSTGRES_HOST', 'localhost'),
    port: optionalInt('POSTGRES_PORT', 5432),
    user: required('POSTGRES_USER'),
    password: required('POSTGRES_PASSWORD'),
    database: required('POSTGRES_DB'),
  },

  /** Redis 連線設定。 */
  redis: {
    /** 同 postgres.host 的說明：容器內用 `redis`，本機用 `localhost`。 */
    host: optional('REDIS_HOST', 'localhost'),
    port: optionalInt('REDIS_PORT', 6379),
  },

  /**
   * JWT 簽章密鑰。★ 本專案最敏感的設定
   *
   * 這把密鑰決定「誰能簽出有效的 token」。任何人拿到它就能偽造出
   * 任意身分的 token —— 整套認證直接失效。
   *
   * 所以它用 `required()` 而不是 `optional()` 給預設值：
   *   **寧可服務起不來，也不要用一把大家都知道的預設密鑰在跑。**
   *
   *   如果給了預設值（例如 'dev-secret'），很容易發生的事是：
   *   有人忘了設，服務照常啟動、功能全部正常，沒有任何人發現 ——
   *   直到某天這個專案被部署到別的地方，而攻擊者知道原始碼裡
   *   那把預設密鑰是什麼。
   *
   * 產生方式：openssl rand -base64 32
   */
  jwtSecret: required('JWT_SECRET'),
} as const;

/** 是否為正式環境。用在錯誤回應要不要帶 stack trace 之類的判斷。 */
export const isProduction = env.nodeEnv === 'production';
