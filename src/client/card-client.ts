// buyer のエージェント役。SDK の x402Client に card:* のスキーム（PR #3707 §5.2 の CardScheme）を登録して支払う
// - 402 を受けたら PAY.JP のトークンを作り、PAYMENT-SIGNATURE を付けて再送する
// - bundle（実証5）では同じ PAYMENT-SIGNATURE を使い回し、新しい与信を求める 402 が来たら作り直して進む
import { randomBytes } from 'node:crypto';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { Psp } from '../psp/types.ts';
import type { IdMode } from '../facilitator/card.ts';

export class CardScheme {
  readonly scheme = 'auth-capture';
  private readonly psp: Psp;
  private readonly idMode: IdMode;
  lastPaymentId?: string;
  constructor(psp: Psp, idMode: IdMode) {
    this.psp = psp;
    this.idMode = idMode;
  }
  async createPaymentPayload(x402Version: number, req: any) {
    if (req.extra?.psp !== 'payjp') throw new Error(`unsupported psp ${req.extra?.psp}`);
    const token = await this.psp.createToken();
    const paymentId = `pay_${randomBytes(16).toString('hex')}`;
    this.lastPaymentId = paymentId;
    if (this.idMode === 'A') return { x402Version, payload: { token, paymentId } };
    return { x402Version, payload: { token }, extensions: { 'payment-identifier': { info: { required: true, id: paymentId } } } };
  }
}

export interface CallResult {
  status: number;
  paymentId?: string;
  /** 402 を受けてから最後の応答（200 など）まで */
  ms402toFinal?: number;
  msTotal: number;
  paymentRequired?: unknown;
  paymentResponse?: unknown;
  body?: string;
  error?: string;
  /** 新しい与信のために PAYMENT-SIGNATURE を作り直した回数 */
  newPayments: number;
}

export class CardBuyer {
  readonly scheme: CardScheme;
  private readonly client: x402Client;
  private readonly http: x402HTTPClient;
  private readonly url: string;
  /** bundle で使い回す PAYMENT-SIGNATURE */
  signature?: Record<string, string>;
  lastSignature?: Record<string, string>;
  lastPaymentRequired?: unknown;

  constructor(o: { psp: Psp; idMode: IdMode; url: string; maxAmount?: number }) {
    this.scheme = new CardScheme(o.psp, o.idMode);
    // SDK の支払い上限は既定で USD の既定資産だけを通すので、card:visa の JPY を上限付きで許可する
    this.client = x402Client.fromConfig({
      schemes: [{ network: 'card:*' as any, client: this.scheme as any }],
      spendControls: { allowedAssets: [{ network: 'card:visa' as any, asset: 'JPY', maxAmountPerPayment: String(o.maxAmount ?? 300) }] },
    });
    this.http = new x402HTTPClient(this.client);
    this.url = o.url;
  }

  private async newSignature(res: Response): Promise<Record<string, string>> {
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const pr = this.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
    this.lastPaymentRequired = pr;
    const payload = await this.client.createPaymentPayload(pr);
    return this.http.encodePaymentSignatureHeader(payload) as Record<string, string>;
  }

  /** 1 回の呼び出し。reuse=true なら手元の PAYMENT-SIGNATURE を先に使う（実証5） */
  async call(o: { reuse?: boolean; headers?: Record<string, string>; resendSame?: boolean } = {}): Promise<CallResult> {
    const t0 = Date.now();
    let t402: number | undefined;
    let newPayments = 0;
    let sig = o.reuse ? this.signature : undefined;
    if (o.resendSame) sig = this.lastSignature;
    for (let round = 0; round < 3; round++) {
      let res: Response;
      try {
        res = await fetch(this.url, { headers: { ...(sig ?? {}), ...(o.headers ?? {}) } });
      } catch (e) {
        return { status: 0, msTotal: Date.now() - t0, ms402toFinal: t402 ? Date.now() - t402 : undefined, error: (e as Error).message, newPayments, paymentId: this.scheme.lastPaymentId };
      }
      if (res.status === 402) {
        t402 ??= Date.now();
        sig = await this.newSignature(res);
        newPayments++;
        this.signature = sig;
        this.lastSignature = sig;
        continue;
      }
      const prh = res.headers.get('payment-response');
      let paymentResponse: unknown;
      try {
        paymentResponse = prh ? this.http.getPaymentSettleResponse((n) => res.headers.get(n)) : undefined;
      } catch {
        paymentResponse = undefined;
      }
      const body = await res.text();
      return {
        status: res.status,
        paymentId: this.scheme.lastPaymentId,
        ms402toFinal: t402 ? Date.now() - t402 : undefined,
        msTotal: Date.now() - t0,
        paymentResponse,
        body,
        newPayments,
      };
    }
    return { status: 402, msTotal: Date.now() - t0, error: 'still 402 after new payments', newPayments, paymentId: this.scheme.lastPaymentId };
  }
}
