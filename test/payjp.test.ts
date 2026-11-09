import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Payjp } from '../src/psp/payjp.ts';
import { AuthenticationRequired } from '../src/psp/types.ts';

function fake(responses: { status: number; body: unknown }[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

test('refuses a live key', () => {
  assert.throws(() => new Payjp({ secretKey: 'sk_live_x' }));
});

test('token request uses basic auth, the direct-token header and the test card', async () => {
  const { f, seen } = fake([{ status: 200, body: { id: 'tok_1' } }]);
  const p = new Payjp({ secretKey: 'sk_test_abc', fetch: f, sleep: async () => {} });
  assert.equal(await p.createToken(), 'tok_1');
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h.authorization, 'Basic ' + Buffer.from('sk_test_abc:').toString('base64'));
  assert.equal(h['X-Payjp-Direct-Token-Generate'], 'true');
  assert.match(String(seen[0].init.body), /card%5Bnumber%5D=4242424242424242/);
});

test('authorize sends capture=false and metadata, retries 429', async () => {
  const { f, seen } = fake([
    { status: 429, body: { error: { code: 'over_capacity' } } },
    { status: 200, body: { id: 'ch_1', amount: 50, amount_refunded: 0, captured: false, refunded: false, metadata: {}, created: 1 } },
  ]);
  const p = new Payjp({ secretKey: 'sk_test_abc', fetch: f, sleep: async () => {} });
  const c = await p.authorize({ amount: 50, token: 'tok_1', metadata: { x402_payment_id: 'pay_x' } });
  assert.equal(c.id, 'ch_1');
  assert.equal(seen.length, 2);
  const body = new URLSearchParams(String(seen[1].init.body));
  assert.equal(body.get('capture'), 'false');
  assert.equal(body.get('metadata[x402_payment_id]'), 'pay_x');
});

test('a charge waiting for 3-D Secure stops with AuthenticationRequired', async () => {
  const { f } = fake([{ status: 200, body: { id: 'ch_2', three_d_secure_status: 'unverified' } }]);
  const p = new Payjp({ secretKey: 'sk_test_abc', fetch: f, sleep: async () => {} });
  await assert.rejects(p.authorize({ amount: 50, token: 't', metadata: {} }), AuthenticationRequired);
});
