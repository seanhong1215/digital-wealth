/**
 * web/src/routes/LoginPage.tsx — 登入頁
 *
 * 在架構的哪一層：路由層（頁面）。
 *
 * ── 為什麼 demo 帳密直接印在畫面上 ────────────────────────────────
 *
 *   因為這是示範網站，不是真實產品。打開網站的第一個動作是想進去看，
 *   如果要回頭翻 README 找帳密，有一部分的人就直接關掉了。
 *
 *   把「一鍵填入」做成按鈕而不是自動登入，是為了讓登入流程本身
 *   （JWT、httpOnly cookie、Guard）仍然被實際走過一次 ——
 *   那是這一頁真正要展示的東西。
 */

import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { APP_NAME } from '@digital-wealth/shared';

import { useLogin, useSession } from '../features/auth/api/session';
import { ApiError } from '../shared/lib/api-client';
import { Button, Card, Field } from '../shared/ui';

const DEMO_EMAIL = 'demo@digital-wealth.local';
const DEMO_PASSWORD = 'demo1234';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isLoading } = useSession();
  const login = useLogin();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // 已經登入的人不該看到登入頁 —— 直接送去他原本要去的地方。
  if (!isLoading && session) {
    const from = (location.state as { from?: string } | null)?.from ?? '/portfolio';
    return <Navigate to={from} replace />;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    login.mutate(
      { email, password },
      {
        onSuccess: () => {
          const from = (location.state as { from?: string } | null)?.from ?? '/portfolio';
          // replace 而不是 push —— 登入成功後按返回鍵，不該回到登入頁。
          navigate(from, { replace: true });
        },
      },
    );
  };

  // 帳密錯誤要顯示在表單上，不是全頁錯誤 ——
  // 這是「使用者輸入錯誤」而不是「系統故障」，兩者的 UI 位置不同。
  const credentialError =
    login.error instanceof ApiError && login.error.code === 'AUTH_INVALID_CREDENTIALS'
      ? login.error.message
      : null;

  // 其他錯誤（伺服器掛掉、網路不通）才是全域錯誤。
  const systemError =
    login.error instanceof ApiError && login.error.code !== 'AUTH_INVALID_CREDENTIALS'
      ? login.error.message
      : null;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-page px-4 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-navy-900">{APP_NAME}</h1>
        <p className="mt-1 text-base text-text-secondary">數位財富管理</p>
      </div>

      <Card className="w-full max-w-sm">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field
            id="email"
            label="電子郵件"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />

          <Field
            id="password"
            label="密碼"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={credentialError}
            required
          />

          {systemError && (
            <p role="alert" className="rounded-md bg-error-bg px-3 py-2 text-base text-error">
              {systemError}
            </p>
          )}

          <Button type="submit" fullWidth loading={login.isPending}>
            登入
          </Button>
        </form>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-sm text-text-secondary">示範帳號</p>
          <p className="tnum mt-1 text-sm text-text-primary">
            {DEMO_EMAIL} / {DEMO_PASSWORD}
          </p>
          <Button
            variant="secondary"
            fullWidth
            className="mt-3"
            onClick={() => {
              setEmail(DEMO_EMAIL);
              setPassword(DEMO_PASSWORD);
            }}
          >
            一鍵填入
          </Button>
        </div>
      </Card>

      <p className="max-w-sm text-center text-xs leading-relaxed text-text-placeholder">
        本站為技術示範用的虛構品牌，與任何真實金融機構無關。
        所有資料皆由程式產生，不構成任何投資建議。
      </p>
    </div>
  );
}
