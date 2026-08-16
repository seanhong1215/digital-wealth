/**
 * api/src/database/database.module.ts — 資料庫模組
 *
 * 這個檔案是什麼：
 *   把 `DatabaseService` 包裝成一個 NestJS Module，讓其他模組能使用它。
 *
 * ── `@Module()` 是什麼（NestJS 核心概念，第一次出現）─────────────────
 *
 * NestJS 用 Module 來組織程式碼。每個 Module 宣告四件事：
 *
 *   providers  — 這個模組**自己擁有**的可注入類別（Service、Repository…）
 *   controllers— 這個模組處理的 HTTP 路由
 *   imports    — 這個模組**需要用到**的其他模組
 *   exports    — 這個模組**願意分享**給別人的 provider
 *
 * 關鍵在 `exports`：providers 預設是**私有的**。
 * 沒有寫進 exports 的 provider，別的模組就算 import 了這個模組也拿不到。
 * 這是刻意的封裝設計 —— 模組能控制自己暴露多少東西出去。
 *
 * 對照 Spring Boot：Module ≈ `@Configuration` + component scan 的範圍。
 * 但 NestJS 的邊界更明確：Spring 的 bean 預設全域可見，
 * NestJS 預設私有、必須明確 export。
 *
 * ── `@Global()` 為什麼用在這裡 ──────────────────────────────────────
 *
 * 正常情況下，每個要用資料庫的模組都得在自己的 `imports` 寫上
 * `DatabaseModule`。accounts、positions、orders、transactions…
 * 每一個都要寫，重複而且很容易漏。
 *
 * `@Global()` 讓這個模組的 exports 全域可見，只要在根模組 import 一次，
 * 其他模組直接注入 `DatabaseService` 就好。
 *
 * ⚠️ **但 @Global() 要非常節制地用。** 全域模組會讓相依關係從程式碼裡
 *    消失 —— 你看某個模組的 imports 看不出它用了資料庫。這裡願意付這個
 *    代價，是因為資料庫連線屬於「基礎設施」，幾乎每個模組都會用到，
 *    寫出來的資訊價值低於重複的成本。**業務模組一律不准加 @Global()。**
 *
 * 在架構的哪一層：基礎設施層。
 */

import { Global, Module } from '@nestjs/common';

import { DatabaseService } from './database.service.js';

@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
