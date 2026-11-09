// 実証4：入金のトランザクション署名を Solana の公開 RPC で引き、送金時刻・手数料・USDC の移動を出す。
// 使い方：node scripts/lookup-tx.mjs <署名>   （鍵は使わない）
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sig = process.argv[2];
if (!sig) throw new Error('usage: node scripts/lookup-tx.mjs <signature>');
const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }) });
const tx = (await r.json()).result;
if (!tx) throw new Error('transaction not found');
const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
const bal = (arr) => Object.fromEntries((arr ?? []).filter((b) => b.mint === USDC).map((b) => [b.owner, Number(b.uiTokenAmount.uiAmountString)]));
const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
const usdcDelta = Object.fromEntries([...new Set([...Object.keys(pre), ...Object.keys(post)])].map((o) => [o, +((post[o] ?? 0) - (pre[o] ?? 0)).toFixed(6)]));
console.log(JSON.stringify({ signature: sig, slot: tx.slot, blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null, feeLamports: tx.meta.fee, feeSol: tx.meta.fee / 1e9, feePayer: keys[0], err: tx.meta.err, usdcDelta }, null, 2));
