/**
 * web/src/features/demo/components/DemoConsole.tsx — Demo 控制台面板
 *
 * 在架構的哪一層：feature 的元件層。
 *
 * ── 為什麼是浮動面板，不是一個路由 ★ ─────────────────────────────
 *
 *   做成 `/demo` 路由比較簡單，但那樣使用者得**離開他正在看的畫面**
 *   才能切換故障 —— 而控制台的價值正是「一邊看著持倉頁，
 *   一邊打開報價中斷，觀察它怎麼降級」。
 *
 *   離開再回來的話，那個瞬間的變化就看不到了。
 *
 * ── 視覺上刻意跟產品不一樣 ★ ─────────────────────────────────────
 *
 *   面板用深色、等寬字、方角。這不是偷懶，是要讓人一眼看出
 *   「這個東西不屬於產品本身」—— 面試官不會誤以為正式的財富管理
 *   App 裡面有一顆「讓所有 API 回 500」的按鈕。
 *
 *   同理，它也不使用產品的 design token（`bg-bg-surface` 那些），
 *   而是直接寫死顏色。開發工具不該進入設計系統的命名空間。
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  DEMO_QUERY_KEYS,
  FAULT_LABELS,
  SCENARIO_LABELS,
  faultKindSchema,
  accountScenarioSchema,
  type AccountScenarioValue,
  type FaultKindValue,
} from '@digital-wealth/shared';

import { useDemoState, useResetDemo, useSetFaults, useSetScenario } from '../api/queries';

export function DemoConsole() {
  const { data: state } = useDemoState();
  const [open, setOpen] = useState(false);

  const setScenario = useSetScenario();
  const setFaults = useSetFaults();
  const reset = useResetDemo();

  const [searchParams, setSearchParams] = useSearchParams();

  // ── 進站時，把網址上的設定套用到後端 ★ ────────────────────────
  //
  //   這是「情境連結可分享」的實作：面試官把
  //   `?_demo_scenario=insufficient&_demo_faults=order-rejected`
  //   貼給同事，同事打開就直接是那個情境。
  //
  //   `appliedRef` 確保只跑一次。少了它，每次 render 都會比對並
  //   POST 一次 —— 而 POST 會更新狀態、觸發 render、再 POST，
  //   變成無窮迴圈（而且每一次都在重建整個資料庫）。
  const appliedRef = useRef(false);

  useEffect(() => {
    if (!state || appliedRef.current) return;
    appliedRef.current = true;

    const urlScenario = accountScenarioSchema.safeParse(
      searchParams.get(DEMO_QUERY_KEYS.scenario),
    );
    const urlFaultsRaw = searchParams.get(DEMO_QUERY_KEYS.faults);

    // ── ⚠️ 兩個請求必須「依序」送出，不能平行 ★ ──────────────────
    //
    //   第一版是兩個 mutate() 並排呼叫，結果面板上的故障顯示成沒開，
    //   但故障其實是生效的 —— 典型的 race：
    //
    //     t1  POST /demo/scenario（重建資料庫，要 1–3 秒）
    //     t2  POST /demo/faults（很快）→ 回應 { faults: ['api-500'] }
    //         → setQueryData 寫入正確狀態
    //     t3  scenario 終於回來 → 但它的回應是在 t1 那一刻拍的快照，
    //         裡面 faults 還是空的 → **覆蓋掉 t2 的正確狀態**
    //
    //   兩個請求各自都成功，只有畫面是錯的。用 await 串起來之後，
    //   後一個請求的回應必然包含前一個的結果。
    void (async () => {
      if (urlScenario.success && urlScenario.data !== state.scenario) {
        const seedRaw = searchParams.get(DEMO_QUERY_KEYS.seed);
        const seed = seedRaw === null ? undefined : Number(seedRaw);
        await setScenario.mutateAsync({
          scenario: urlScenario.data,
          seed: Number.isInteger(seed) ? seed : undefined,
        });
      }

      if (urlFaultsRaw !== null) {
        // 逐項驗證，不認識的值直接丟掉 —— 網址是使用者可以亂打的地方，
        // 送一個後端不認識的故障名稱過去只會拿到 400。
        const parsed = urlFaultsRaw
          .split(',')
          .map((raw) => faultKindSchema.safeParse(raw.trim()))
          .filter((r) => r.success)
          .map((r) => r.data);

        if (parsed.length > 0) {
          await setFaults.mutateAsync(parsed);
          setOpen(true); // 從連結進來的人，直接把面板打開讓他知道發生什麼事
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意只在拿到 state 後跑一次
  }, [state]);

  /** 把當前狀態寫回網址。所有操作都經過這裡，網址與後端才不會分岔。 */
  const syncUrl = (next: { scenario: AccountScenarioValue; faults: FaultKindValue[]; seed: number }) => {
    const params = new URLSearchParams(searchParams);

    // 預設值不寫進網址 —— 否則每個連結都拖著一串沒有意義的參數，
    // 而「乾淨的網址」本身就是「現在是預設狀態」的訊號。
    if (next.scenario === 'active') params.delete(DEMO_QUERY_KEYS.scenario);
    else params.set(DEMO_QUERY_KEYS.scenario, next.scenario);

    if (next.faults.length === 0) params.delete(DEMO_QUERY_KEYS.faults);
    else params.set(DEMO_QUERY_KEYS.faults, next.faults.join(','));

    if (next.seed === 42) params.delete(DEMO_QUERY_KEYS.seed);
    else params.set(DEMO_QUERY_KEYS.seed, String(next.seed));

    // replace：切換故障不該塞滿瀏覽紀錄，否則按十次返回鍵才能離開。
    setSearchParams(params, { replace: true });
  };

  // 後端沒有這個路由（正式環境）→ 什麼都不畫。
  // 判斷依據來自伺服器，不是前端的環境變數（理由見 queries.ts）。
  if (!state) return null;

  const busy = setScenario.isPending || setFaults.isPending || reset.isPending;

  const toggleFault = (kind: FaultKindValue) => {
    const next = state.faults.includes(kind)
      ? state.faults.filter((f) => f !== kind)
      : [...state.faults, kind];

    setFaults.mutate(next);
    syncUrl({ scenario: state.scenario, faults: next, seed: state.seed });
  };

  const chooseScenario = (scenario: AccountScenarioValue) => {
    setScenario.mutate({ scenario });
    syncUrl({ scenario, faults: state.faults, seed: state.seed });
  };

  return (
    <>
      {/* 收合時的圓鈕。bottom-20 是為了避開手機版的底部 Tab Bar，
          lg 之後 Tab Bar 消失就可以往下移。 */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-20 right-4 z-20 flex items-center gap-2 rounded-full bg-slate-900 px-4 py-3 font-mono text-sm text-white shadow-lg lg:bottom-6"
        >
          <span aria-hidden="true">⚙</span>
          Demo
          {state.faults.length > 0 && (
            // 面板收起來時也要看得到「有故障開著」，
            // 否則面試官會忘記自己開過，然後以為系統壞了。
            <span className="rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900">
              {state.faults.length}
            </span>
          )}
        </button>
      )}

      {open && (
        <aside className="fixed bottom-20 right-4 z-20 max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg bg-slate-900 p-4 font-mono text-sm text-slate-100 shadow-lg lg:bottom-6">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Demo 控制台</h2>
            <button
              onClick={() => setOpen(false)}
              aria-label="關閉控制台"
              className="px-2 text-slate-400 hover:text-white"
            >
              ✕
            </button>
          </header>

          <p className="mb-4 text-xs leading-relaxed text-slate-400">
            這是開發工具，不屬於產品。故障注入發生在<strong className="text-slate-200">後端</strong>
            ，前端無法分辨真假。
          </p>

          {/* ── 帳戶情境 ────────────────────────────────────────── */}
          <section className="mb-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-slate-400">帳戶情境</h3>
            <div className="flex flex-col gap-1.5">
              {(Object.keys(SCENARIO_LABELS) as AccountScenarioValue[]).map((key) => {
                const active = state.scenario === key;
                return (
                  <button
                    key={key}
                    disabled={busy}
                    onClick={() => chooseScenario(key)}
                    className={`rounded px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                      active ? 'bg-indigo-600 text-white' : 'bg-slate-800 hover:bg-slate-700'
                    }`}
                  >
                    <span className="block">{SCENARIO_LABELS[key].name}</span>
                    <span className="block text-xs text-slate-400">
                      {SCENARIO_LABELS[key].hint}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500">切換會重建資料庫，已下的單會消失。</p>
          </section>

          {/* ── 故障注入 ────────────────────────────────────────── */}
          <section className="mb-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-slate-400">
              故障注入（可複選）
            </h3>
            <div className="flex flex-col gap-1.5">
              {(Object.keys(FAULT_LABELS) as FaultKindValue[]).map((kind) => {
                const active = state.faults.includes(kind);
                return (
                  <button
                    key={kind}
                    disabled={busy}
                    onClick={() => toggleFault(kind)}
                    aria-pressed={active}
                    className={`flex items-start gap-2 rounded px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                      active ? 'bg-amber-500 text-slate-900' : 'bg-slate-800 hover:bg-slate-700'
                    }`}
                  >
                    <span aria-hidden="true" className="mt-0.5">
                      {active ? '◉' : '○'}
                    </span>
                    <span>
                      <span className="block">{FAULT_LABELS[kind].name}</span>
                      <span
                        className={`block text-xs ${active ? 'text-slate-700' : 'text-slate-400'}`}
                      >
                        {FAULT_LABELS[kind].hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <button
            disabled={busy}
            onClick={() => {
              reset.mutate();
              syncUrl({ scenario: 'active', faults: [], seed: 42 });
            }}
            className="w-full rounded bg-slate-700 px-3 py-2 hover:bg-slate-600 disabled:opacity-40"
          >
            {busy ? '處理中…' : '全部重設'}
          </button>

          <p className="mt-3 text-xs text-slate-500">
            目前狀態會同步到網址（<code>_demo_</code> 前綴），可以直接把連結分享出去。
          </p>
        </aside>
      )}
    </>
  );
}
