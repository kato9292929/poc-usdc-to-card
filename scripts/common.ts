// 実行スクリプトの共通部分：PSP の選択、facilitator とサーバの起動、記録の書き出し
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Payjp } from '../src/psp/payjp.ts';
import { MockPayjp } from '../src/psp/mock.ts';
import type { Charge, Psp } from '../src/psp/types.ts';
import { CardFacilitator, type IdMode } from '../src/facilitator/card.ts';
import { startFacilitator } from '../src/facilitator/http.ts';
import { startServer, type ServerOptions } from '../src/server/app.ts';

export const JIN_LATEST = 'https://jin.x402jp.com/api/jin/latest';
export const PAY_TO = 'acct_payjp_test';

/** PAYJP_SECRET_KEY があれば PAY.JP のテストモード、--mock か無ければモック */
export function pickPsp(): Psp {
  const key = process.env.PAYJP_SECRET_KEY?.trim();
  if (process.argv.includes('--mock') || !key) return new MockPayjp();
  return new Payjp({ secretKey: key });
}

export function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export async function boot(o: { psp: Psp; idMode: IdMode; runId: string; server: Omit<ServerOptions, 'facilitatorUrl' | 'serverCredential' | 'idMode' | 'payTo' | 'fixturePath'> }) {
  const credential = randomBytes(24).toString('hex');
  const facilitator = new CardFacilitator({ psp: o.psp, idMode: o.idMode, runId: o.runId, statePath: `state/${o.runId}.json` });
  const fac = await startFacilitator(facilitator, credential);
  const srv = await startServer({ ...o.server, idMode: o.idMode, facilitatorUrl: fac.url, serverCredential: credential, payTo: PAY_TO, fixturePath: 'fixtures/jin-latest.json' });
  return {
    facilitator,
    srv,
    credential,
    url: `${srv.url}/jin/latest`,
    close: () => {
      srv.server.close();
      fac.server.close();
    },
  };
}

export function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

/** ランナーの所在地域（GitHub Actions のときだけ外部に問い合わせる） */
export async function runnerRegion(): Promise<Record<string, string> | null> {
  if (!process.env.GITHUB_ACTIONS) return null;
  try {
    const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as Record<string, string>;
    return { country: j.country, region: j.region, city: j.city, org: j.org };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function stats(xs: number[]) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}

/** PSP の charge を run_id で絞り、件数と金額を数える */
export function tally(charges: Charge[]) {
  return {
    authorized: charges.length,
    captured: charges.filter((c) => c.captured).length,
    voided: charges.filter((c) => !c.captured && c.refunded).length,
    open: charges.filter((c) => !c.captured && !c.refunded).length,
    capturedAmount: charges.filter((c) => c.captured).reduce((a, c) => a + c.amount - c.amount_refunded, 0),
  };
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`wrote ${path}`);
}

/** 記録からトークン・キーを除く（PAYMENT-SIGNATURE の token など） */
export function redact<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (k, x) => (k === 'token' && typeof x === 'string' ? '<redacted>' : x)));
}
