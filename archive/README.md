# poc-usdc-to-card（実証4）

x402 の売上（USDC）を ether.fi Cash のカード残高に移し、外部サービスに 1 回払う。結果は [docs/result.md](docs/result.md)。

- `scripts/lookup-tx.mjs`：入金のトランザクションを Solana の公開 RPC で引く（鍵は使わない）
