/**
 * api/src/main.ts — 服務啟動點
 *
 * 這個檔案是什麼：
 *   Node 執行 api 時的第一個檔案。負責建立 NestJS 應用實例、
 *   套用全域設定，然後開始監聽 HTTP。
 *
 * 為什麼要獨立成一個檔案（而不是寫在 app.module.ts）：
 *   Module 描述的是「有哪些東西」，main.ts 描述的是「怎麼跑起來」。
 *   分開之後，測試可以只載入 AppModule 而不真的開 port。
 *
 * 在架構的哪一層：最外層的入口。
 */

/**
 * ⚠️ **這一行必須是整個程式的第一個 import，順序不能動。**
 *
 * NestJS 的依賴注入靠 `Reflect.getMetadata()` 讀取 SWC 產生的型別資訊。
 * 但 `Reflect.getMetadata` 不是 JavaScript 內建的 —— 它來自
 * reflect-metadata 這個 polyfill，必須在任何裝飾器被執行**之前**載入。
 *
 * 如果放到後面，載入順序會變成「先執行 @Injectable() → 才有 Reflect」，
 * 啟動時會噴 `Reflect.getMetadata is not a function`。
 */
import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { env } from './config/env.js';

/**
 * 啟動服務。
 *
 * @throws 資料庫連不上、port 被佔用等情況會讓啟動失敗（刻意的快速失敗）
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    /**
     * 日誌等級。
     *
     * 開發時要看到 `debug`（包含 NestJS 印出的路由註冊清單，
     * 對確認「我的端點到底有沒有掛上去」很有用）；
     * 正式環境只留 warn 以上，避免日誌被淹沒。
     */
    logger:
      env.nodeEnv === 'production'
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  /**
   * 全域路由前綴。
   *
   * 所有 Controller 的路徑前面都會自動加上 `api/v1`，
   * 例如 `@Controller('health')` → `/api/v1/health`。
   *
   * 為什麼要有版本號：API 是對外契約，改了會弄壞已經上線的前端。
   * 有了 `/v1`，未來需要不相容的改動時可以並存 `/v2`，讓舊版慢慢退場。
   * MVP 不會真的做 v2，但**前綴要一開始就留好** —— 事後要加，
   * 所有前端呼叫都得改一遍。
   */
  app.setGlobalPrefix('api/v1');

  /**
   * CORS（跨來源資源共用）。
   *
   * 瀏覽器的同源政策預設會擋掉「從 localhost:5173 的網頁去呼叫
   * localhost:3000 的 API」—— 因為 port 不同就算不同來源。
   * 這裡明確允許前端的來源。
   *
   * `credentials: true` 是必要的：本專案的 JWT 放在 httpOnly cookie 裡
   * （見 docs/02-backend.md 的認證設計），沒有這個設定，
   * 瀏覽器不會把 cookie 帶上，登入後每個請求都會是未認證狀態。
   *
   * ⚠️ 開了 credentials 就**不能**把 origin 設成 `*`，
   *    瀏覽器規格明文禁止這個組合。所以這裡列出具體來源。
   */
  app.enableCors({
    origin: ['http://localhost:5173', 'http://localhost:5174'],
    credentials: true,
  });

  /**
   * 優雅關閉（graceful shutdown）。
   *
   * 開啟之後，收到 SIGTERM / SIGINT（`docker compose down` 或 Ctrl+C）時，
   * NestJS 會依序呼叫各模組的 `onModuleDestroy` —— 也就是
   * DatabaseService 會關閉連線池、RedisService 會關閉連線。
   *
   * 沒有這行的話，行程會直接被砍掉，資料庫端要等到連線逾時
   * 才會發現對方不見了。
   */
  app.enableShutdownHooks();

  await app.listen(env.port, '0.0.0.0');

  logger.log(`API 已啟動：http://localhost:${env.port}/api/v1`);
  logger.log(`健康檢查：http://localhost:${env.port}/api/v1/health`);
}

/**
 * 啟動失敗時要讓行程以非零狀態碼結束。
 *
 * 為什麼重要：Docker 靠結束碼判斷容器是正常結束還是崩潰。
 * 如果啟動失敗卻回 0，Docker 會以為服務「正常執行完畢了」，
 * `restart: unless-stopped` 就不會重啟它 —— 服務悄悄死掉而沒人發現。
 */
bootstrap().catch((error: unknown) => {
  // 這裡不能用 NestJS 的 Logger —— 如果失敗發生在 NestFactory.create()
  // 之前（例如 env.ts 驗證失敗），Logger 可能還沒初始化。
  console.error('API 啟動失敗：', error);
  process.exit(1);
});
