/**
 * web/src/features/auth/api/session.ts — 認證的 query hooks
 *
 * 在架構的哪一層：
 *   feature 的 api/ 層。元件只能透過這裡跟後端說話。
 *
 * ── JWT 在 httpOnly cookie 裡，對前端意味著什麼 ★ ─────────────────
 *
 *   前端**看不到也摸不到** token。這帶來一個反直覺的後果：
 *
 *     沒有辦法在前端「檢查我有沒有登入」。
 *
 *   常見做法是把 token 存 localStorage，然後 `if (localStorage.token)`
 *   判斷登入狀態 —— 那正是 XSS 攻擊者最想要的東西：任何注入的
 *   JavaScript 都能把 token 讀走送到自己的伺服器。
 *
 *   httpOnly cookie 讀不到，所以判斷登入的唯一方式是**問後端**：
 *   打 /auth/me，200 就是登入中、401 就是沒有。這多一次往返，
 *   但換來的是 token 完全不暴露給 JS。
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import type { AuthSession, LoginRequest } from '@digital-wealth/shared';

import { ApiError, apiGet, apiPost } from '../../../shared/lib/api-client';
import { queryClient, queryKeys } from '../../../shared/lib/query-client';

/**
 * 目前的登入狀態。
 *
 * 未登入時回傳 `null` 而不是拋錯 —— 「沒登入」是這個 hook 的
 * 正常結果之一，不是異常。把它當錯誤處理會讓每個呼叫端都要
 * 寫一次 try/catch。
 */
export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: async (): Promise<AuthSession | null> => {
      try {
        return await apiGet<AuthSession>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.code === 'AUTH_REQUIRED') {
          return null;
        }
        throw error;
      }
    },
    // 401 不重試 —— 沒登入這件事不會因為多問幾次就改變。
    retry: false,
  });
}

/** 登入。成功後把 session 寫進快取，省去一次 /auth/me 往返。 */
export function useLogin() {
  return useMutation({
    mutationFn: (credentials: LoginRequest) =>
      apiPost<AuthSession>('/auth/login', credentials),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.session, session);
    },
  });
}

/**
 * 登出。
 *
 * `queryClient.clear()` 清空**所有**快取，不只是 session。
 * 少了這一行，登出後再登入（或換一個帳號）會先看到上一個使用者的
 * 餘額和持倉閃過去 —— 在金融 App 裡這是資安事件等級的 bug。
 */
export function useLogout() {
  return useMutation({
    mutationFn: () => apiPost<void>('/auth/logout'),
    onSuccess: () => {
      queryClient.clear();
    },
  });
}
