# 実証4：x402 の売上をカード残高に移して支払う

状態：**準備済み・未実施**（2026-11-04 時点）

x402 の売上ウォレット（Solana の USDC）から ether.fi Cash に入金し、そのバーチャルカード（Direct Pay）で、カード払いしか受け付けない外部サービス（Anthropic Console のクレジット $5）に 1 回払う。

## 参照した公式ドキュメント（2026-11-04 確認）

| 対象 | URL | 確かめたこと |
|---|---|---|
| 入金ネットワーク | https://help.ether.fi/en/articles/833702-usdc-and-usdt-deposit-networks-and-addresses | USDC は Solana から入金できる（EVM とは別の Solana 用アドレス） |
| 初回 $10 入金 | https://help.ether.fi/en/articles/758781-why-do-i-need-to-make-an-initial-10-deposit-before-verification | カードの本人確認を終える前に $10 の入金が要る。確認に通らなければ引き出せる |
| Direct Pay と Borrow | https://help.ether.fi/en/articles/326983-understanding-your-cash-card-borrow-mode-vs-direct-pay-mode | Direct Pay は Vault の USDC（次に LiquidUSD）をそのまま使う |
| 対象国 | https://help.ether.fi/en/articles/758780-in-which-countries-is-the-cash-card-available | Japan が掲載されている |

指示書との違い：なし（入金額 $10 は初回入金の要件どおり）。

## 手順

1. 人が ether.fi Cash に登録して本人確認を進め、売上ウォレットから ether.fi の Solana の入金アドレスへ USDC $10 を送り、トランザクション署名とカード残高に反映された時刻を伝える
2. `node scripts/lookup-tx.mjs <署名>` で送金時刻・手数料・USDC の移動を確かめる
3. 人がバーチャルカード（Direct Pay）で Anthropic Console のクレジット $5 を買い、成否を伝える

## 結果

| 項目 | 値 |
|---|---|
| 実施日時 | |
| 送金の時刻（チェーン） | |
| カード残高に反映された時刻 | |
| 送金から反映までの時間 | |
| 送金手数料 | |
| ether.fi 側で差し引かれた額 | |
| 外部サービスでの決済の成否・請求額 | |
| エラー内容（拒否なら文言） | |
