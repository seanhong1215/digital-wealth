/**
 * web/src/App.tsx — 路由與版面
 *
 * 這個檔案是什麼：
 *   路由表、登入守衛、以及包住所有頁面的殼（導覽列、免責聲明）。
 *
 * ── 路由結構 ──────────────────────────────────────────────────────
 *
 *   /login                          登入
 *   /portfolio                      投組總覽 ＋ 持倉（合併單頁，見 adr/0007）
 *   /transactions                   交易明細
 *   /trade                          下單步驟 1：選標的
 *   /trade/:symbol                  下單步驟 2：填委託
 *   /trade/:symbol/confirm          下單步驟 3：確認
 *   /trade/:symbol/result?orderId=  下單步驟 4：結果
 *
 * ── 為什麼下單的每一步都是獨立路由 ★ ──────────────────────────────
 *
 *   四個步驟大可以做成同一頁的四個 state。做成路由的理由：
 *
 *     1. **返回鍵符合直覺** —— 手機使用者按返回，預期回到上一步，
 *        而不是整個跳出下單流程
 *     2. **結果頁可以分享** —— 「下單被拒」的畫面可以把連結直接
 *        貼給同事看，這是 Demo 情境的重要能力
 *     3. **重新整理不會卡在半路** —— 網址說明了現在在哪一步
 *
 *   但**表單資料刻意不放進 URL、也不持久化**：下單草稿本來就不該被
 *   還原。隔天打開瀏覽器跳出「要繼續昨天那筆台積電嗎」，價格早就
 *   不是昨天的價格了，那是危險而不是體貼。詳見 docs/adr/0008。
 */

import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { APP_NAME } from '@digital-wealth/shared';

import { useSession } from './features/auth/api/session';
import { DemoConsole } from './features/demo/components/DemoConsole';
import { LoginPage } from './routes/LoginPage';
import { PortfolioPage } from './routes/PortfolioPage';
import { TransactionsPage } from './routes/TransactionsPage';
import { OrderConfirm } from './routes/trade/OrderConfirm';
import { OrderForm } from './routes/trade/OrderForm';
import { OrderResult } from './routes/trade/OrderResult';
import { SelectInstrument } from './routes/trade/SelectInstrument';
import { TradeLayout } from './routes/trade/TradeLayout';
import { Card, ErrorState, Skeleton } from './shared/ui';

export default function App() {
  return (
    <>
      {/* ── Demo 控制台放在**路由之外** ★ ────────────────────────────
          
          一開始放在 AppShell 裡（也就是登入之後才會出現），結果踩到
          一個經典的自鎖：開啟「伺服器錯誤」故障 → /auth/me 回 500
          → 被判定未登入 → 導向登入頁 → 登入頁沒有控制台
          → **沒有任何 UI 能把故障關掉**，只能自己去改網址或重啟容器。

          放在最外層之後，控制台在任何畫面都在（登入頁、錯誤頁、
          載入中），永遠有路可以把故障關掉。 */}
      <DemoConsole />

      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<RequireAuth />}>
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />

        <Route path="/trade" element={<TradeLayout />}>
          <Route index element={<SelectInstrument />} />
          <Route path=":symbol" element={<OrderForm />} />
          <Route path=":symbol/confirm" element={<OrderConfirm />} />
          <Route path=":symbol/result" element={<OrderResult />} />
        </Route>
      </Route>

        <Route path="*" element={<Navigate to="/portfolio" replace />} />
      </Routes>
    </>
  );
}

/**
 * 登入守衛。
 *
 * ── 為什麼要有 `isLoading` 這個分支 ★ ────────────────────────────
 *
 *   判斷登入狀態要打 /auth/me，那是非同步的。在它回來之前，
 *   session 是 `undefined` —— 既不是「已登入」也不是「未登入」，
 *   而是「還不知道」。
 *
 *   少了這個分支，直接寫 `if (!session) return <Navigate to="/login" />`，
 *   會發生：使用者明明登入著，重新整理後**先被踢到登入頁**，
 *   /auth/me 回來後才跳回去。畫面閃一下，而且如果他當時在
 *   /transactions，跳回來會變成 /portfolio —— 位置也弄丟了。
 *
 *   「載入中」是一個獨立的狀態，不是「沒有資料」的同義詞。
 *   這是前端最常見的三態誤判。
 */
function RequireAuth() {
  const { data: session, isLoading, error, refetch } = useSession();
  const location = useLocation();

  if (isLoading) {
    return (
      <AppShell>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </AppShell>
    );
  }

  // ── 「查不到身分」和「沒有登入」是兩件事 ★ ────────────────────
  //
  //   useSession 只把 401 轉成 `null`（＝確定沒登入）。其他錯誤
  //   （500、逾時、網路不通）會拋出來 —— 那代表「**不知道**有沒有登入」。
  //
  //   把後者也當成「沒登入」而導向登入頁是錯的，而且會很難用：
  //   伺服器掛掉時使用者被踢到登入頁，然後登入也失敗（同樣掛著），
  //   看起來像是「我的密碼錯了」。真正的問題完全被藏住。
  //
  //   正確做法是顯示錯誤與重試按鈕，並且**留在原本的網址上** ——
  //   後端恢復後按重試就能繼續，不會弄丟他原本在看的頁面。
  if (error) {
    return (
      <AppShell>
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      </AppShell>
    );
  }

  if (!session) {
    // state 帶上原本要去的位置，登入成功後送他回去，
    // 而不是一律丟到首頁。
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * 全站外殼：導覽 ＋ 內容 ＋ 免責聲明。
 *
 * 響應式策略：< 1024px 用底部 Tab Bar（拇指可及），
 * ≥ 1024px 改成頂部導覽。這是 mobile-first 的具體實作 ——
 * 桌機版是手機版的放大，不是另一套版型。
 */
function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg-page">
      <TopNav />

      {/* pb-24 是給底部 Tab Bar 讓位。少了它，最後一筆明細會被蓋住 —— */}
      {/* 這是行動版最常見的版面 bug。 */}
      <main className="mx-auto w-full max-w-5xl px-4 pb-24 pt-4 lg:pb-8">{children}</main>

      <BottomTabBar />
      <Disclaimer />
    </div>
  );
}

const NAV_ITEMS = [
  { to: '/portfolio', label: '投資總覽', icon: '◈' },
  { to: '/transactions', label: '交易明細', icon: '☰' },
  { to: '/trade', label: '下單', icon: '＋' },
] as const;

function TopNav() {
  const { data: session } = useSession();

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg-surface">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-baseline gap-3">
          {/* 品牌字串一律從 shared 的 APP_NAME 取，不寫死 ——
              改名時只需要動一個地方。 */}
          <span className="text-xl font-bold text-navy-900">{APP_NAME}</span>
          <span className="hidden text-sm text-text-secondary sm:inline">數位財富管理</span>
        </div>

        {/* 桌機版導覽。手機版靠底部 Tab Bar，所以這裡 lg 以下隱藏。 */}
        <nav className="hidden gap-1 lg:flex">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-base font-medium transition-colors ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-text-secondary hover:bg-bg-subtle'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {session && (
          <span className="hidden text-sm text-text-secondary sm:inline">
            {session.user.displayName}
            <span className="tnum ml-2 text-text-placeholder">{session.account.accountNo}</span>
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * 底部 Tab Bar（手機）。
 *
 * `pb-[env(safe-area-inset-bottom)]` 是為了避開 iPhone 底部的
 * Home Indicator。沒有它，最下面那排字會被那條橫線壓到。
 */
function BottomTabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="mx-auto flex max-w-5xl">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-sm font-medium ${
                isActive ? 'text-indigo-600' : 'text-text-secondary'
              }`
            }
          >
            <span aria-hidden="true" className="text-lg leading-none">
              {item.icon}
            </span>
            {item.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/**
 * 免責聲明。
 *
 * ★ 這不是裝飾，是合規紅線：
 *
 *   1. 使用虛構品牌，避免任何真實金融機構的商標問題
 *   2. **介面只陳述事實，不提供投資建議** —— 投資建議在台灣屬於
 *      金管會的投顧特許業務，一個作品集網站說「建議買進」是
 *      實質的法遵問題，而面試官扣的會是判斷力的分數
 *
 *   所以整個介面裡不會出現任何「推薦」「看好」「應該買」。
 */
function Disclaimer() {
  return (
    <p className="mx-auto w-full max-w-5xl px-4 pb-28 pt-4 text-center text-xs leading-relaxed text-text-placeholder lg:pb-8">
      本站為技術示範用的虛構品牌，與任何真實金融機構無關。
      <br />
      所有資料皆由程式產生，不構成任何投資建議。
    </p>
  );
}
