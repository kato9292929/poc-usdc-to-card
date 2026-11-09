// PAY.JP のモック。API リファレンスで確かめた振る舞いだけを真似る：
// トークンは 1 回だけ、金額は 50〜9,999,999 円、確定は 1 回だけ、少なく確定すると差額は amount_refunded、
// 未確定の与信の返金は全額のみ
import { PspError, type Charge, type Psp } from './types.ts';

export class MockPayjp implements Psp {
  readonly name = 'payjp-mock';
  readonly calls: Record<string, number> = {};
  readonly charges = new Map<string, Charge>();
  private readonly usedTokens = new Set<string>();
  private readonly issuedTokens = new Set<string>();
  private seq = 0;
  /** テスト用：次の与信で返すエラー */
  failNextAuthorize?: PspError;

  private tick(kind: string) {
    this.calls[kind] = (this.calls[kind] ?? 0) + 1;
  }

  async createToken(): Promise<string> {
    this.tick('token');
    const id = `tok_mock_${++this.seq}`;
    this.issuedTokens.add(id);
    return id;
  }

  async authorize(o: { amount: number; token: string; metadata: Record<string, string> }): Promise<Charge> {
    this.tick('authorize');
    if (this.failNextAuthorize) {
      const e = this.failNextAuthorize;
      this.failNextAuthorize = undefined;
      throw e;
    }
    if (!this.issuedTokens.has(o.token)) throw new PspError(400, 'invalid_id', 'no such token');
    if (this.usedTokens.has(o.token)) throw new PspError(400, 'token_already_used', 'token already used');
    if (!Number.isInteger(o.amount) || o.amount < 50 || o.amount > 9_999_999) throw new PspError(400, 'invalid_amount', 'amount out of range');
    this.usedTokens.add(o.token);
    const c: Charge = {
      id: `ch_mock_${++this.seq}`,
      amount: o.amount,
      amount_refunded: 0,
      captured: false,
      refunded: false,
      currency: 'jpy',
      metadata: { ...o.metadata },
      created: Math.floor(Date.now() / 1000),
      captured_at: null,
      three_d_secure_status: null,
    };
    this.charges.set(c.id, c);
    return { ...c };
  }

  async capture(id: string, amount?: number): Promise<Charge> {
    this.tick('capture');
    const c = this.charges.get(id);
    if (!c) throw new PspError(404, 'invalid_id', 'no such charge');
    if (c.captured) throw new PspError(400, 'already_captured', 'already captured');
    if (c.refunded) throw new PspError(400, 'already_refunded', 'already refunded');
    const a = amount ?? c.amount;
    if (a > c.amount || a < 50) throw new PspError(400, 'invalid_amount', 'invalid capture amount');
    c.captured = true;
    c.captured_at = Math.floor(Date.now() / 1000);
    c.amount_refunded = c.amount - a;
    return { ...c };
  }

  async release(id: string): Promise<Charge> {
    this.tick('refund');
    const c = this.charges.get(id);
    if (!c) throw new PspError(404, 'invalid_id', 'no such charge');
    if (c.refunded) throw new PspError(400, 'already_refunded', 'already refunded');
    if (c.captured) throw new PspError(400, 'already_captured', 'refund of a captured charge is out of scope here');
    c.refunded = true;
    c.amount_refunded = c.amount;
    return { ...c };
  }

  async listCharges(since: number): Promise<Charge[]> {
    this.tick('list');
    return [...this.charges.values()].filter((c) => c.created >= since).map((c) => ({ ...c }));
  }
}
