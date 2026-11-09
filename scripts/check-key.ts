// Secret の PAYJP_SECRET_KEY が使えるかを、値を出さずに確かめる
import { normalizeKey } from '../src/psp/payjp.ts';
const raw = process.env.PAYJP_SECRET_KEY ?? '';
const key = normalizeKey(raw);
const kind = ['sk_test_', 'pk_test_', 'sk_live_', 'pk_live_'].find((p) => key.startsWith(p)) ?? 'unknown';
console.log(JSON.stringify({ kind, length: key.length, rawLength: raw.length, hadExtraChars: raw !== key }));
if (kind !== 'sk_test_') {
  console.log('PAYJP_SECRET_KEY must be the test secret key (sk_test_...)');
  process.exit(1);
}
