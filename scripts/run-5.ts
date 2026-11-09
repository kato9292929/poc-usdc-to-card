// 実証5：1 回の与信（300 円）から 1 回 2 円を台帳で差し引き、最後に与信ごとに 1 回だけ確定する
// 使い方：node --experimental-strip-types scripts/run-5.ts [--mock]
import { CardBuyer, type CallResult } from '../src/client/card-client.ts';
import { JIN_LATEST, boot, commit, pickPsp, runnerRegion, stamp, stats, tally, writeJson } from './common.ts';

const HOLD = 300;
const UNIT = 2;
const CALLS = 160;
const runStamp = stamp();

async function runCase(name: string, failAt: Set<number>) {
  const psp = pickPsp();
  const idMode = 'A' as const;
  const runId = `${runStamp}-5-${name}`;
  const startedAt = new Date();
  const since = Math.floor(startedAt.getTime() / 1000) - 60;
  const env = await boot({ psp, idMode, runId, server: { mode: 'bundle', amount: HOLD, unitAmount: UNIT, jinUrl: JIN_LATEST } });
  const buyer = new CardBuyer({ psp, idMode, url: env.url, maxAmount: HOLD });
  const calls: (CallResult & { i: number; injectedFail: boolean; at: number })[] = [];
  for (let i = 0; i < CALLS; i++) {
    const injectedFail = failAt.has(i);
    const r = await buyer.call({ reuse: true, headers: injectedFail ? { 'x-test-fail': '1' } : {} });
    calls.push({ ...r, body: undefined, paymentResponse: undefined, i, injectedFail, at: Date.now() });
  }
  // 終了処理：与信ごとに使った合計で 1 回だけ確定（50 円未満は取り消し）
  const fin = await fetch(env.url.replace('/jin/latest', '/admin/finalize'), { method: 'POST', headers: { authorization: `Bearer ${env.credential}` } });
  const finalize = (await fin.json()) as { id: string; used: number; action: string; response: unknown }[];
  env.close();

  const charges = (await psp.listCharges(since)).filter((c) => c.metadata?.run_id === runId);
  const holds = [...env.facilitator.holds.values()];
  const ok = calls.filter((c) => c.status === 200);
  // 与信ごとの呼び出し数と所要時間
  const perHold = holds.map((h) => {
    const cs = calls.filter((c) => c.paymentId === h.id && c.status === 200);
    return {
      paymentId: h.id,
      chargeId: h.chargeId,
      authorized: h.amount,
      ledgerUsed: h.used,
      ledgerCalls: h.usageCalls,
      calls200: cs.length,
      msFirstToLast: cs.length ? cs[cs.length - 1].at - cs[0].at : 0,
      finalize: finalize.find((f) => f.id === h.id)?.action,
    };
  });
  const ledgerTotal = holds.reduce((a, h) => a + h.used, 0);
  const t = tally(charges);
  return {
    run: runId,
    experiment: 5,
    case: name,
    idMode,
    psp: psp.name,
    commit: commit(),
    runner: await runnerRegion(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    params: { hold: HOLD, unit: UNIT, calls: CALLS, injectedFailures: [...failAt].sort((a, b) => a - b), asset: 'JPY' },
    summary: {
      status200: ok.length,
      status502: calls.filter((c) => c.status === 502).length,
      otherStatus: calls.filter((c) => c.status !== 200 && c.status !== 502).map((c) => ({ i: c.i, status: c.status, error: c.error })),
      newHoldsDuringRun: calls.reduce((a, c) => a + c.newPayments, 0),
      autoRehold: calls.filter((c) => c.newPayments > 0 && c.i > 0).map((c) => ({ i: c.i, status: c.status })),
      msPerCall: stats(ok.map((c) => c.msTotal)),
      msTotal: calls.length ? calls[calls.length - 1].at - startedAt.getTime() : 0,
      perHold,
      pspCalls: psp.calls,
    },
    reconciliation: {
      ledgerTotal,
      status200TimesUnit: ok.length * UNIT,
      pspCapturedAmount: t.capturedAmount,
      pspCharges: t,
      ledgerEquals200: ledgerTotal === ok.length * UNIT,
      ledgerEqualsCaptured: ledgerTotal === t.capturedAmount,
      chargeIds: charges.map((c) => c.id),
    },
  };
}

const failAt = new Set(Array.from({ length: 10 }, (_, k) => 7 + k * 16));
for (const [name, fails] of [['continuous', new Set<number>()], ['with_failures', failAt]] as const) {
  const r = await runCase(name, fails);
  writeJson(`${r.psp === "payjp" ? "docs/runs" : "state/mock-runs"}/${r.run}.json`, r);
}
