// 実証4：最初の /settle で与信、ハンドラ成功で確定、失敗で取り消し。ID の 2 方式（A：paymentId、B：payment-identifier）を比べる
// 使い方：node --experimental-strip-types scripts/run-4.ts [A|B ...] [--mock]
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { CardBuyer, type CallResult } from '../src/client/card-client.ts';
import type { IdMode } from '../src/facilitator/card.ts';
import { JIN_LATEST, boot, commit, pickPsp, redact, runnerRegion, stamp, stats, tally, writeJson } from './common.ts';

const modes = (process.argv.slice(2).filter((a) => a === 'A' || a === 'B') as IdMode[]);
const runStamp = stamp();

for (const idMode of modes.length ? modes : (['A', 'B'] as IdMode[])) {
  const psp = pickPsp();
  const runId = `${runStamp}-4-${idMode}`;
  const startedAt = new Date();
  const since = Math.floor(startedAt.getTime() / 1000) - 60;
  const env = await boot({ psp, idMode, runId, server: { mode: 'single', amount: 50, jinUrl: JIN_LATEST } });
  const buyer = new CardBuyer({ psp, idMode, url: env.url, maxAmount: 50 });
  const caseOf = new Map<string, string>();
  const calls: (CallResult & { case: string; step: string })[] = [];
  const record = (c: string, step: string, r: CallResult) => {
    if (r.paymentId) caseOf.set(r.paymentId, c);
    calls.push({ ...r, body: undefined, case: c, step });
  };
  let example402: unknown;
  let exampleResponse: unknown;
  let exampleSignature: unknown;

  // 通常 20 回
  for (let i = 0; i < 20; i++) {
    const r = await buyer.call();
    record('normal', 'call', r);
    if (i === 0) {
      example402 = buyer.lastPaymentRequired;
      exampleResponse = r.paymentResponse;
      exampleSignature = redact(decodePaymentSignatureHeader(Object.values(buyer.lastSignature ?? {})[0] as string));
    }
  }
  // ハンドラ失敗 3 回
  for (let i = 0; i < 3; i++) record('handler_fail', 'call', await buyer.call({ headers: { 'x-test-fail': '1' } }));
  // 同じ支払いの再送 3 回（同じ PAYMENT-SIGNATURE を 2 回送る）
  for (let i = 0; i < 3; i++) {
    record('resend', 'first', await buyer.call());
    record('resend', 'same_signature', await buyer.call({ resendSame: true }));
  }
  // 確定後の応答の欠落 3 回（確定のあと接続を切り、クライアントが同じ支払いで再送する）
  for (let i = 0; i < 3; i++) {
    record('drop_after_capture', 'dropped', await buyer.call({ headers: { 'x-test-drop-after-capture': '1' } }));
    record('drop_after_capture', 'retry_same', await buyer.call({ resendSame: true }));
  }
  env.close();

  // PSP の記録を run_id と paymentId で突き合わせる
  const charges = (await psp.listCharges(since)).filter((c) => c.metadata?.run_id === runId);
  const byCase: Record<string, ReturnType<typeof tally> & { chargeIds: string[] }> = {};
  for (const c of ['normal', 'handler_fail', 'resend', 'drop_after_capture']) {
    const cs = charges.filter((ch) => caseOf.get(ch.metadata.x402_payment_id) === c);
    byCase[c] = { ...tally(cs), chargeIds: cs.map((ch) => ch.id) };
  }
  const timings = env.facilitator.timings;
  const normalIds = new Set(calls.filter((c) => c.case === 'normal').map((c) => c.paymentId));
  const holds = [...env.facilitator.holds.values()];

  writeJson(`${psp.name === "payjp" ? "docs/runs" : "state/mock-runs"}/${runId}.json`, {
    run: runId,
    experiment: 4,
    idMode,
    idTransport: idMode === 'A' ? 'payload.paymentId' : 'extensions["payment-identifier"].info.id',
    psp: psp.name,
    commit: commit(),
    runner: await runnerRegion(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    price: { amount: 50, asset: 'JPY' },
    calls: calls.map((c) => ({ case: c.case, step: c.step, status: c.status, paymentId: c.paymentId, ms402toFinal: c.ms402toFinal, msTotal: c.msTotal, newPayments: c.newPayments, error: c.error })),
    summary: {
      normal: {
        status200: calls.filter((c) => c.case === 'normal' && c.status === 200).length,
        ms402to200: stats(calls.filter((c) => c.case === 'normal' && c.status === 200).map((c) => c.ms402toFinal!)),
        msAuthorizeAtPsp: stats(timings.filter((t) => normalIds.has(t.id)).map((t) => t.authorizeMs)),
        msAuthorizeToCapture: stats(timings.filter((t) => normalIds.has(t.id) && t.closedAt).map((t) => t.closedAt! - t.authorizedAt)),
      },
      statusByCase: Object.fromEntries(['normal', 'handler_fail', 'resend', 'drop_after_capture'].map((c) => [c, calls.filter((x) => x.case === c).map((x) => `${x.step}:${x.status}`)])),
      facilitator: env.facilitator.stats,
      literalPaymentIdentifierConflicts: holds.reduce((a, h) => a + h.literalConflicts, 0),
      pspCalls: psp.calls,
    },
    psp_reconciliation: byCase,
  });
  if (psp.name === 'payjp') {
    writeJson(`docs/examples/${runId}-402-payment-required.json`, example402);
    writeJson(`docs/examples/${runId}-payment-signature.json`, exampleSignature);
    writeJson(`docs/examples/${runId}-payment-response.json`, exampleResponse);
  }
}
