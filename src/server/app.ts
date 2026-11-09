// リソースサーバ：GET /jin/latest
// - 支払いが無ければ 402（PAYMENT-REQUIRED）。accepts は PR #3707 の形（auth-capture・card:visa・JPY・extra.psp・extra.paymentFlow）
// - 支払いがあれば、escrow の順（1 回目の /settle で与信 → ハンドラ → 2 回目の /settle で capture か void）
// - single：1 回の呼び出しで与信 50 円 → capture 50 円（実証4）
// - bundle：1 回目の 402 で与信 300 円。以後は facilitator の台帳から 1 回 2 円を差し引く。残りが 2 円を切ったら新しい与信を求める 402（実証5）
//   終了時の POST /admin/finalize で、与信ごとに使った合計を 1 回だけ capture（50 円未満なら void）
// テスト用の仕掛け（実験のサーバなのでヘッダで切り替える）：
//   x-test-fail: 1                ハンドラを失敗させる
//   x-test-drop-after-capture: 1  capture のあとクライアントへの応答を落とす（接続を切る）
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { IdMode, PaymentPayload, PaymentRequirements, SettleResponse } from '../facilitator/card.ts';

export interface ServerOptions {
  mode: 'single' | 'bundle';
  idMode: IdMode;
  facilitatorUrl: string;
  serverCredential: string;
  payTo: string;
  /** single：1 回の価格。bundle：1 回の与信額 */
  amount: number;
  /** bundle：1 回あたりに差し引く額 */
  unitAmount?: number;
  jinUrl?: string;
  fixturePath: string;
}

export interface ServerEvents {
  /** 1 回のリクエストの記録（実行スクリプトが集計に使う） */
  requests: { at: number; paymentId?: string; outcome: string; status: number; settle?: SettleResponse[] }[];
  /** bundle：見た与信の ID とその要件 */
  holds: Map<string, { payload: PaymentPayload; requirements: PaymentRequirements }>;
  /** bundle：与信ごとに、200 を返した呼び出しで差し引いた額の合計（サーバ側の数え） */
  usedByHold: Map<string, number>;
}

export function requirementsFor(o: ServerOptions): PaymentRequirements {
  const extra: Record<string, unknown> = { psp: 'payjp', paymentFlow: 'escrow' };
  if (o.mode === 'bundle') extra.unitAmount = String(o.unitAmount ?? 2); // 自前：仕様に無い項目（1 回あたりの差し引き額）
  return { scheme: 'auth-capture', network: 'card:visa', amount: String(o.amount), asset: 'JPY', payTo: o.payTo, maxTimeoutSeconds: 900, extra };
}

export function startServer(o: ServerOptions, port = 0): Promise<{ server: Server; url: string; events: ServerEvents }> {
  const events: ServerEvents = { requests: [], holds: new Map(), usedByHold: new Map() };
  const fixture = readFileSync(o.fixturePath, 'utf8');
  const requirements = requirementsFor(o);
  const unit = o.unitAmount ?? 2;

  const settle = async (paymentPayload: PaymentPayload): Promise<SettleResponse> => {
    const r = await fetch(`${o.facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.serverCredential}` },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
    });
    return (await r.json()) as SettleResponse;
  };

  /** ライフサイクルの payload（§4.6）。A は payload.paymentId、B は payment-identifier 拡張で ID を運ぶ */
  const lifecycle = (client: PaymentPayload, id: string, body: Record<string, unknown>): PaymentPayload => {
    const p: PaymentPayload = { x402Version: 2, accepted: requirements, payload: { ...body } };
    if (o.idMode === 'A') p.payload.paymentId = id;
    else p.extensions = { 'payment-identifier': { info: { required: true, id } } };
    return p;
  };

  const paymentRequired = (error: string) => {
    const pr: Record<string, unknown> = {
      x402Version: 2,
      error,
      resource: { url: '/jin/latest', description: 'Japan Inflation Nowcast latest (proxied from jin.x402jp.com)', mimeType: 'application/json' },
      accepts: [requirements],
    };
    if (o.idMode === 'B') pr.extensions = { 'payment-identifier': { info: { required: true } } };
    return pr;
  };

  const send402 = (res: ServerResponse, error: string) => {
    res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired(error) as any) });
    res.end(JSON.stringify({ error }));
  };

  const runHandler = async (req: IncomingMessage): Promise<string> => {
    if (req.headers['x-test-fail'] === '1') throw new Error('handler failure (injected)');
    if (o.jinUrl) {
      try {
        const r = await fetch(o.jinUrl, { signal: AbortSignal.timeout(5000) });
        if (r.ok) return await r.text();
      } catch {
        /* 固定の JSON に落とす */
      }
    }
    return fixture;
  };

  const server = createServer(async (req, res) => {
    const rec: ServerEvents['requests'][number] = { at: Date.now(), outcome: '', status: 0 };
    events.requests.push(rec);
    const finish = (status: number, outcome: string) => {
      rec.status = status;
      rec.outcome = outcome;
    };
    try {
      if (req.method === 'POST' && req.url === '/admin/finalize' && req.headers.authorization === `Bearer ${o.serverCredential}`) {
        const out = [];
        for (const [id, h] of events.holds) {
          const used = events.usedByHold.get(id) ?? 0;
          // 使った合計で 1 回だけ capture。PAY.JP の最小額（50 円）未満は capture できないので void
          const r = used >= 50
            ? await settle(lifecycle(h.payload, id, { type: 'capture', amount: String(used) }))
            : await settle(lifecycle(h.payload, id, { type: 'void' }));
          out.push({ id, used, action: used >= 50 ? 'capture' : 'void', response: r });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return finish(200, 'finalize');
      }
      if (req.method !== 'GET' || req.url !== '/jin/latest') {
        res.writeHead(404).end();
        return finish(404, 'not_found');
      }
      const header = req.headers['payment-signature'];
      if (typeof header !== 'string') {
        send402(res, 'payment required');
        return finish(402, 'no_payment');
      }
      const payload = decodePaymentSignatureHeader(header) as unknown as PaymentPayload;
      const id = o.idMode === 'A' ? (payload.payload?.paymentId as string) : payload.extensions?.['payment-identifier']?.info?.id;
      rec.paymentId = id;
      rec.settle = [];
      // 1 回目の /settle：与信（同じ支払いの再送なら既存の与信が返る）
      const auth = await settle(payload);
      rec.settle.push(auth);
      if (!auth.success) {
        send402(res, auth.errorReason ?? 'settle failed');
        return finish(402, `authorize_failed:${auth.errorReason}`);
      }
      if (o.mode === 'bundle') {
        events.holds.set(id, { payload, requirements });
        if (Number(auth.remaining ?? 0) < unit) {
          send402(res, 'hold_exhausted');
          return finish(402, 'hold_exhausted');
        }
      }
      let body: string;
      try {
        body = await runHandler(req);
      } catch {
        if (o.mode === 'single') rec.settle.push(await settle(lifecycle(payload, id, { type: 'void' })));
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'handler_failed' }));
        return finish(502, 'handler_failed');
      }
      // 2 回目の /settle
      const second = o.mode === 'single'
        ? await settle(lifecycle(payload, id, { type: 'capture', amount: String(o.amount) }))
        : await settle(lifecycle(payload, id, { type: 'usage', amount: String(unit) }));
      rec.settle.push(second);
      if (!second.success) {
        if (o.mode === 'bundle' && second.errorReason === 'hold_exhausted') {
          send402(res, 'hold_exhausted');
          return finish(402, 'hold_exhausted');
        }
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'settle_failed', reason: second.errorReason }));
        return finish(502, `settle_failed:${second.errorReason}`);
      }
      if (o.mode === 'bundle') events.usedByHold.set(id, (events.usedByHold.get(id) ?? 0) + unit);
      if (req.headers['x-test-drop-after-capture'] === '1') {
        req.socket.destroy();
        return finish(0, 'dropped_after_capture');
      }
      res.writeHead(200, { 'content-type': 'application/json', 'PAYMENT-RESPONSE': encodePaymentResponseHeader(second as any) });
      res.end(body);
      finish(200, 'ok');
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'server_error', detail: (e as Error).message }));
      }
      finish(500, `error:${(e as Error).message}`);
    }
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${a.port}`, events });
  }));
}
