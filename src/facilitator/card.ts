// カードの auth-capture の facilitator（PR #3707 の §4.5・§4.6・§6.2 に合わせる）
// - 1 回目の /settle（クライアントの payload）で与信、2 回目（payload.type capture / void）で確定か取り消し
// - payTo と ID で与信を重複排除。同じ ID・同じトークン・同じ額の再送は既存の与信を返し、違えば拒否
// - 1 つの支払いは capture か void を 1 回だけ。同じ内容の再送は保存した結果を返し、違えば拒否
// - ID の取り方を 2 方式で切り替える（未解決項目 4）
//     A：payload.paymentId
//     B：extensions["payment-identifier"].info.id（ライフサイクルの操作ごとに指紋を分ける規則を足す）
// - 実証5 用に、与信の残りを持つ台帳（payload.type usage）を足す。これは仕様に無い自前の拡張（§9 の後続提案の範囲）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { AuthenticationRequired, PspError, type Psp } from '../psp/types.ts';

export type IdMode = 'A' | 'B';

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, any>;
}

export interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  amount?: string;
  errorReason?: string;
  /** 自前：実証5 の台帳の残り（与信額 − 使った額） */
  remaining?: string;
}

export interface HoldRecord {
  key: string;
  id: string;
  payTo: string;
  token: string;
  amount: number;
  chargeId: string;
  authorizedAt: number;
  status: 'authorized' | 'captured' | 'voided';
  lifecycle?: { type: 'capture' | 'void'; amount?: number; at: number; response: SettleResponse };
  used: number;
  usageCalls: number;
  /** B の拡張の規則どおりなら 409 になったはずのメッセージの数（項目 4 の記録用） */
  literalConflicts: number;
  fingerprint: string;
}

export interface FacilitatorStats {
  authorizeCalls: number;
  authorizeDeduped: number;
  lifecycleCalls: number;
  lifecycleDeduped: number;
  rejected: Record<string, number>;
}

const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** §8.1 の多層防御：Luhn が通る 13〜19 桁の数字の列があれば拒否する */
export function containsPan(v: unknown): boolean {
  const s = JSON.stringify(v ?? '');
  for (const m of s.matchAll(/\d{13,19}/g)) {
    const d = m[0];
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2 === 1) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export class CardFacilitator {
  readonly holds = new Map<string, HoldRecord>();
  readonly stats: FacilitatorStats = { authorizeCalls: 0, authorizeDeduped: 0, lifecycleCalls: 0, lifecycleDeduped: 0, rejected: {} };
  private readonly psp: Psp;
  private readonly idMode: IdMode;
  private readonly runId: string;
  private readonly statePath?: string;
  /** 与信（authorize）と確定・取り消しの時刻。与信から確定までの時間を出す */
  readonly timings: { id: string; authorizeMs: number; lifecycleMs?: number; authorizedAt: number; closedAt?: number }[] = [];

  constructor(o: { psp: Psp; idMode: IdMode; runId: string; statePath?: string }) {
    this.psp = o.psp;
    this.idMode = o.idMode;
    this.runId = o.runId;
    this.statePath = o.statePath;
    if (o.statePath && existsSync(o.statePath)) {
      for (const h of JSON.parse(readFileSync(o.statePath, 'utf8')) as HoldRecord[]) this.holds.set(h.key, h);
    }
  }

  private save() {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify([...this.holds.values()], null, 1));
  }

  private reject(network: string, reason: string, id = ''): SettleResponse {
    this.stats.rejected[reason] = (this.stats.rejected[reason] ?? 0) + 1;
    return { success: false, transaction: id, network, errorReason: reason };
  }

  /** ID を取り出す（A：payload、B：拡張） */
  idOf(p: PaymentPayload): string | undefined {
    if (this.idMode === 'A') return typeof p.payload.paymentId === 'string' ? p.payload.paymentId : undefined;
    const id = p.extensions?.['payment-identifier']?.info?.id;
    return typeof id === 'string' ? id : undefined;
  }

  private fingerprint(p: PaymentPayload): string {
    const a = p.accepted;
    return JSON.stringify([a.scheme, a.network, a.asset, a.amount, a.payTo, p.payload]);
  }

  async settle(p: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    if (containsPan(p.payload) || containsPan(p.extensions)) return this.reject(network, 'invalid_payload_card_data');
    if (requirements.scheme !== 'auth-capture' || !network.startsWith('card:') || requirements.extra?.paymentFlow !== 'escrow') {
      return this.reject(network, 'unsupported_scheme');
    }
    const id = this.idOf(p);
    if (!id || !ID_RE.test(id)) return this.reject(network, 'invalid_payment_id');
    const key = `${requirements.payTo}|${id}`;
    const type = p.payload.type as string | undefined;
    if (type === undefined) return this.authorize(p, requirements, id, key);
    if (type === 'capture' || type === 'void') return this.lifecycle(p, requirements, id, key, type);
    if (type === 'usage') return this.usage(p, requirements, id, key);
    return this.reject(network, 'invalid_payload_type', id);
  }

  private async authorize(p: PaymentPayload, req: PaymentRequirements, id: string, key: string): Promise<SettleResponse> {
    this.stats.authorizeCalls++;
    const network = req.network;
    const token = p.payload.token;
    if (typeof token !== 'string' || !token) return this.reject(network, 'invalid_payload_token', id);
    const amount = Number(req.amount);
    const prev = this.holds.get(key);
    if (prev) {
      if (prev.token !== token || prev.amount !== amount) return this.reject(network, 'payment_id_conflict', id);
      this.stats.authorizeDeduped++;
      return { success: true, transaction: prev.chargeId, network, amount: String(prev.amount), remaining: String(prev.amount - prev.used) };
    }
    const t0 = Date.now();
    let charge;
    try {
      charge = await this.psp.authorize({ amount, token, metadata: { x402_payment_id: id, x402_pay_to: req.payTo, run_id: this.runId, id_mode: this.idMode } });
    } catch (e) {
      if (e instanceof AuthenticationRequired) return this.reject(network, 'card_authentication_required', id);
      if (e instanceof PspError && e.status < 500) return this.reject(network, 'card_declined', id);
      throw e;
    }
    const h: HoldRecord = {
      key, id, payTo: req.payTo, token, amount, chargeId: charge.id, authorizedAt: Date.now(), status: 'authorized',
      used: 0, usageCalls: 0, literalConflicts: 0, fingerprint: this.fingerprint(p),
    };
    this.holds.set(key, h);
    this.timings.push({ id, authorizeMs: Date.now() - t0, authorizedAt: h.authorizedAt });
    this.save();
    return { success: true, transaction: charge.id, network, amount: String(amount), remaining: String(amount) };
  }

  private noteLiteralConflict(h: HoldRecord, p: PaymentPayload) {
    // payment-identifier 拡張の規則（同じ id・違う内容は 409）をそのまま当てると、ここで 409 になる
    if (this.idMode === 'B' && this.fingerprint(p) !== h.fingerprint) h.literalConflicts++;
  }

  private async lifecycle(p: PaymentPayload, req: PaymentRequirements, id: string, key: string, type: 'capture' | 'void'): Promise<SettleResponse> {
    this.stats.lifecycleCalls++;
    const network = req.network;
    const h = this.holds.get(key);
    if (!h) return this.reject(network, 'unknown_payment', id);
    if (h.payTo !== req.payTo) return this.reject(network, 'pay_to_mismatch', id);
    this.noteLiteralConflict(h, p);
    const amount = type === 'capture' ? Number(p.payload.amount) : undefined;
    if (h.lifecycle) {
      if (h.lifecycle.type === type && h.lifecycle.amount === amount) {
        this.stats.lifecycleDeduped++;
        return h.lifecycle.response;
      }
      return this.reject(network, 'payment_closed', id);
    }
    if (type === 'capture' && (!Number.isInteger(amount) || amount! <= 0 || amount! > h.amount)) return this.reject(network, 'invalid_capture_amount', id);
    const t0 = Date.now();
    let res: SettleResponse;
    if (type === 'capture') {
      const c = await this.psp.capture(h.chargeId, amount === h.amount ? undefined : amount);
      h.status = 'captured';
      res = { success: true, transaction: c.id, network, amount: String(c.amount - c.amount_refunded) };
    } else {
      const c = await this.psp.release(h.chargeId);
      h.status = 'voided';
      res = { success: true, transaction: c.id, network, amount: '0' };
    }
    h.lifecycle = { type, amount, at: Date.now(), response: res };
    const t = this.timings.find((x) => x.id === id && x.closedAt === undefined);
    if (t) {
      t.lifecycleMs = Date.now() - t0;
      t.closedAt = Date.now();
    }
    this.save();
    return res;
  }

  /** 実証5：与信の残りから差し引く（PSP は呼ばない）。仕様に無い自前の操作 */
  private async usage(p: PaymentPayload, req: PaymentRequirements, id: string, key: string): Promise<SettleResponse> {
    const network = req.network;
    const h = this.holds.get(key);
    if (!h) return this.reject(network, 'unknown_payment', id);
    if (h.status !== 'authorized') return this.reject(network, 'payment_closed', id);
    const amount = Number(p.payload.amount);
    if (!Number.isInteger(amount) || amount <= 0) return this.reject(network, 'invalid_usage_amount', id);
    if (h.used + amount > h.amount) return this.reject(network, 'hold_exhausted', id);
    h.used += amount;
    h.usageCalls++;
    this.save();
    return { success: true, transaction: h.chargeId, network, amount: String(amount), remaining: String(h.amount - h.used) };
  }
}
