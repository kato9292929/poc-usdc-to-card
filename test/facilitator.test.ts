import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockPayjp } from '../src/psp/mock.ts';
import { CardFacilitator, containsPan, type PaymentPayload, type PaymentRequirements } from '../src/facilitator/card.ts';

const req: PaymentRequirements = { scheme: 'auth-capture', network: 'card:visa', amount: '50', asset: 'JPY', payTo: 'acct_t', maxTimeoutSeconds: 900, extra: { psp: 'payjp', paymentFlow: 'escrow' } };
const pid = 'pay_0123456789abcdef';
const pay = (payload: Record<string, unknown>): PaymentPayload => ({ x402Version: 2, accepted: req, payload });

test('authorize → capture, and a resend returns the stored results without new PSP calls', async () => {
  const psp = new MockPayjp();
  const f = new CardFacilitator({ psp, idMode: 'A', runId: 't' });
  const token = await psp.createToken();
  const a1 = await f.settle(pay({ token, paymentId: pid }), req);
  const a2 = await f.settle(pay({ token, paymentId: pid }), req);
  assert.equal(a1.success, true);
  assert.equal(a2.transaction, a1.transaction);
  const c1 = await f.settle(pay({ type: 'capture', paymentId: pid, amount: '50' }), req);
  const c2 = await f.settle(pay({ type: 'capture', paymentId: pid, amount: '50' }), req);
  assert.deepEqual(c2, c1);
  assert.equal(psp.calls.authorize, 1);
  assert.equal(psp.calls.capture, 1);
});

test('same paymentId with a different token is rejected; a closed payment rejects a different lifecycle', async () => {
  const psp = new MockPayjp();
  const f = new CardFacilitator({ psp, idMode: 'A', runId: 't' });
  await f.settle(pay({ token: await psp.createToken(), paymentId: pid }), req);
  const other = await f.settle(pay({ token: await psp.createToken(), paymentId: pid }), req);
  assert.equal(other.errorReason, 'payment_id_conflict');
  await f.settle(pay({ type: 'void', paymentId: pid }), req);
  const cap = await f.settle(pay({ type: 'capture', paymentId: pid, amount: '50' }), req);
  assert.equal(cap.errorReason, 'payment_closed');
});

test('B reads the id from payment-identifier and counts literal-rule conflicts', async () => {
  const psp = new MockPayjp();
  const f = new CardFacilitator({ psp, idMode: 'B', runId: 't' });
  const ext = { 'payment-identifier': { info: { required: true, id: pid } } };
  await f.settle({ ...pay({ token: await psp.createToken() }), extensions: ext }, req);
  const c = await f.settle({ ...pay({ type: 'capture', amount: '50' }), extensions: ext }, req);
  assert.equal(c.success, true);
  assert.equal([...f.holds.values()][0].literalConflicts, 1);
});

test('payloads with a Luhn-valid card number are rejected', async () => {
  assert.equal(containsPan({ token: '4242424242424242' }), true);
  assert.equal(containsPan({ token: 'tok_abc' }), false);
  const f = new CardFacilitator({ psp: new MockPayjp(), idMode: 'A', runId: 't' });
  const r = await f.settle(pay({ token: '4242424242424242', paymentId: pid }), req);
  assert.equal(r.errorReason, 'invalid_payload_card_data');
});

test('usage debits the hold without PSP calls and refuses beyond the hold', async () => {
  const psp = new MockPayjp();
  const f = new CardFacilitator({ psp, idMode: 'A', runId: 't' });
  const r300 = { ...req, amount: '300' };
  await f.settle({ ...pay({ token: await psp.createToken(), paymentId: pid }), accepted: r300 }, r300);
  for (let i = 0; i < 150; i++) assert.equal((await f.settle(pay({ type: 'usage', paymentId: pid, amount: '2' }), r300)).success, true);
  assert.equal((await f.settle(pay({ type: 'usage', paymentId: pid, amount: '2' }), r300)).errorReason, 'hold_exhausted');
  assert.equal(psp.calls.authorize, 1);
  assert.equal(psp.calls.capture ?? 0, 0);
});
