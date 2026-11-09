// PAY.JP のテストモードの API（https://api.pay.jp/v1）。キーは環境変数からだけ受け取り、ログには出さない
import { AuthenticationRequired, PspError, type Charge, type Psp } from './types.ts';

const BASE = 'https://api.pay.jp/v1';
// テストモードの流量は秒間 2 リクエスト。少し余裕をみて 1 リクエストあたり 550ms 空ける
const MIN_INTERVAL_MS = 550;

export interface PayjpOptions {
  secretKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class Payjp implements Psp {
  readonly name = 'payjp';
  readonly calls: Record<string, number> = {};
  private readonly auth: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: PayjpOptions) {
    if (!/^sk_test_/.test(o.secretKey)) throw new Error('PAYJP_SECRET_KEY must be a test-mode key (sk_test_...)');
    this.auth = 'Basic ' + Buffer.from(`${o.secretKey}:`).toString('base64');
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 1 本ずつ順に投げ、間隔を空け、429 は待って再送する */
  private request<T>(kind: string, method: 'GET' | 'POST', path: string, form?: Record<string, string>, headers: Record<string, string> = {}): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const wait = this.last + MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await this.sleep(wait);
        this.last = Date.now();
        this.calls[kind] = (this.calls[kind] ?? 0) + 1;
        const res = await this.f(`${BASE}${path}`, {
          method,
          headers: { authorization: this.auth, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
          body: form ? new URLSearchParams(form).toString() : undefined,
        });
        const body = (await res.json().catch(() => ({}))) as any;
        if (res.status === 429 && attempt < 8) {
          await this.sleep(1000 * 2 ** Math.min(attempt, 4));
          continue;
        }
        if (!res.ok) {
          const e = body?.error ?? {};
          throw new PspError(res.status, e.code, `payjp ${kind} ${res.status}${e.code ? ` ${e.code}` : ''}${e.message ? `: ${e.message}` : ''}`);
        }
        return body as T;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async createToken(): Promise<string> {
    const now = new Date();
    const t = await this.request<{ id: string }>(
      'token',
      'POST',
      '/tokens',
      { 'card[number]': '4242424242424242', 'card[exp_month]': '12', 'card[exp_year]': String(now.getUTCFullYear() + 3), 'card[cvc]': '123' },
      { 'X-Payjp-Direct-Token-Generate': 'true' },
    );
    return t.id;
  }

  async authorize(o: { amount: number; token: string; metadata: Record<string, string> }): Promise<Charge> {
    const form: Record<string, string> = { amount: String(o.amount), currency: 'jpy', card: o.token, capture: 'false' };
    for (const [k, v] of Object.entries(o.metadata)) form[`metadata[${k}]`] = v;
    const c = await this.request<Charge>('authorize', 'POST', '/charges', form);
    // 3D セキュアを求められて与信が終わっていない場合は、そこで止める（指示書 3）
    if (c.three_d_secure_status && !['verified', 'attempted'].includes(c.three_d_secure_status)) {
      throw new AuthenticationRequired(`payjp charge ${c.id} three_d_secure_status=${c.three_d_secure_status}`);
    }
    return c;
  }

  capture(id: string, amount?: number): Promise<Charge> {
    return this.request<Charge>('capture', 'POST', `/charges/${encodeURIComponent(id)}/capture`, amount === undefined ? {} : { amount: String(amount) });
  }

  release(id: string): Promise<Charge> {
    return this.request<Charge>('refund', 'POST', `/charges/${encodeURIComponent(id)}/refund`, {});
  }

  async listCharges(since: number): Promise<Charge[]> {
    const out: Charge[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.request<{ data: Charge[]; has_more: boolean }>('list', 'GET', `/charges?limit=100&offset=${offset}&since=${since}`);
      out.push(...page.data);
      if (!page.has_more) return out;
    }
  }
}
