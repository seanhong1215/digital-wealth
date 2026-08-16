/**
 * api/src/modules/accounts/accounts.module.ts — 帳戶模組
 *
 * 它重用 AuthService 的 getSession()，因為「查出使用者與其帳戶」
 * 這件事在登入與查帳戶時是同一個查詢。
 *
 * AuthModule 是 @Global() 的，所以這裡不需要 imports。
 *
 * 在架構的哪一層：業務模組。
 */

import { Module } from '@nestjs/common';

import { AuthService } from '../auth/auth.service.js';
import { AccountsController } from './accounts.controller.js';

@Module({
  controllers: [AccountsController],
  providers: [AuthService],
})
export class AccountsModule {}
