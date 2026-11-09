// facilitator の HTTP の口：POST /settle（x402 の SettleRequest の形 { paymentPayload, paymentRequirements }）
// §4.6：ライフサイクルの操作への同意は、facilitator が発行した資格情報でリソースサーバを認証して確かめる
import { createServer, type Server } from 'node:http';
import type { CardFacilitator } from './card.ts';

export function startFacilitator(f: CardFacilitator, serverCredential: string, port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/settle') return send(404, { error: 'not_found' });
    if (req.headers.authorization !== `Bearer ${serverCredential}`) return send(401, { error: 'unauthorized' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const { paymentPayload, paymentRequirements } = JSON.parse(raw);
      send(200, await f.settle(paymentPayload, paymentRequirements));
    } catch (e) {
      send(500, { success: false, errorReason: 'facilitator_error', detail: (e as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${a.port}` });
  }));
}
