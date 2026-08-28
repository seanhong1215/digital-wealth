# ADR 0002 — 後端採用 NestJS + TypeScript

**狀態**：已採納｜**日期**：2026-08-13

## 背景

決定改用真實後端（[ADR 0001](0001-real-backend-over-msw.md)）後，需要選定語言與框架。選型判準是「業界會想看的」，而非學習成本高低。

候選：NestJS（TypeScript）、Fastify（TypeScript）、Spring Boot（Java）。

## 決策

採用 **NestJS + TypeScript**。

## 理由

1. **型別共用是全端定位的核心訊號** —— zod schema 定義在 `shared/`，後端做執行期驗證、前端推導型別，契約只有一份。改一個欄位，兩邊同時編譯失敗。
2. **架構觀念與 Spring Boot 一對一** —— DI 容器、Module、Guard、Pipe、Interceptor、Exception Filter。學 NestJS 等於同時累積 Spring 心智模型。
3. **一套語言一套 tooling** —— 學習時間花在交易一致性、連線管理、冪等這些值錢的邏輯上，而非兩套生態的環境問題。

## 替代方案

| 方案 | 捨棄理由 |
|---|---|
| **Java + Spring Boot** | 失去前後端型別共用 —— 契約會變成兩份，改一個欄位得記得改兩邊。Docker image 大、記憶體成本高 |
| **Fastify / Express 裸寫** | 學不到框架分層的設計意圖。Express 什麼都要自己拼，無法展示對架構模式的理解 |

## 何時該推翻這個決策

**若團隊既有技術棧是 Java**（多數傳統金融機構的 IT 部門），應改用 Spring Boot。與既有系統一致的價值，壓過型別共用的優勢。

本專案假設目標為**金融科技新創、第三方支付、SaaS**，故選 NestJS。

## 後果

**正面**：`shared/` 成為架構樞紐；DI 與模組化結構清晰，適合逐層閱讀學習。

**負面**：NestJS 的裝飾器與 DI 對新手有學習曲線；樣板碼比 Fastify 多。
