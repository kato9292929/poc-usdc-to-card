# 先行事例と仕様の読み込み（2026-11-09）

## 1. PR #3707 のカードバインディング仕様

- 出典：`stefanoamorelli/x402` ブランチ `specs/auth-capture-card`、コミット `140c9ac83a9b6d6e3bffd488898100cdb3ef54cc`（2026-10-06）、`specs/schemes/auth-capture/scheme_auth_capture_card.md`（Version 0.2.0）
- PR：https://github.com/x402-foundation/x402/pull/3707

### 冒頭の未解決項目（Open items、原文のまま）

| # | Open item | What it is about | Possible options |
|---|---|---|---|
| 1 | What goes in v1 | Whether v1 is only for agents paying for requests, with card checkout for a person in a browser, agent spending permissions, bundled micropayments, bank verification (3DS), post-payment updates, statement text and refunds handled later as separate proposals (§9). | (a) agents only, extras later; (b) also support a person paying in a browser; (c) bring one of the other extras back into v1 |
| 2 | What card token does an agent pay with? | A token usually works only with the PSP account that created it, and an agent pays many merchants it has never used before, so it needs a token each merchant's PSP account can charge (§4.2 and §4.4). | (a) network agent tokens; (b) a token the PSP shares with the merchant; (c) leave it out of the spec |
| 3 | How do card networks recognise an agent's x402 payment? | An agent payment fits neither card-network category, cardholder-initiated (CIT) or merchant-initiated (MIT), so the spec has to say what the authorization carries for the network to handle it correctly (§4.4 and §4.7). | (a) the network agent token carries it; (b) submit it as a payment without the cardholder present (e.g. Stripe `off_session`) and let the PSP set the rest; (c) a dedicated `x402` or agent marker, once a network defines one |
| 4 | Which ID ties the hold and the charge together? | The `payment-identifier` extension rejects a second message with the same ID and different contents, which is exactly what the charge after a hold is, so the draft uses its own `paymentId` (§4.4). | (a) `paymentId` on every message; (b) reuse `payment-identifier` with a rule that allows the charge message |
| 5 | How do we pay for requests that cost less than the card fee? | A card payment carries a fee that can be bigger than the price of a cheap `x402` request (§4.5). | (a) one card payment per request, and merchants offer cards only above a price they choose; (b) one hold covers several requests and the total is charged once; (c) cheap requests use other payment methods until the bundling proposal is ready |

実証4 の ID の 2 方式は項目 4 の (a)・(b)、実証5 は項目 5 の (b) に当たる。

### 項目名（実装はこれに合わせる）

`PaymentRequirements`（§4.3）

| 項目 | 内容 |
|---|---|
| `scheme` | `"auth-capture"` |
| `network` | `card:<card-network>`（例 `card:visa`） |
| `amount` | 与信する額。`asset` の最小単位。capture の上限 |
| `asset` | ISO 4217 の通貨コード（例 `"USD"`。本実装は `"JPY"`、最小単位は円） |
| `payTo` | `extra.psp` の PSP での加盟店アカウント ID |
| `maxTimeoutSeconds` | 例は 900 |
| `extra.psp` | 必須。小文字の PSP 名 |
| `extra.paymentFlow` | 必須。`"escrow"` のみ |
| `extra.captureDeadline` | 任意。Unix 秒。無ければ PSP の与信の有効期間 |

`PaymentPayload.payload`（§4.4）：`token`（PSP の不透明なトークン。PAN などは不可）、`paymentId`（16〜128 文字、英数字・`-`・`_`。同じ支払いの再送では同じ値）

ライフサイクルの payload（§4.6）：`type`（`capture` か `void`）、`paymentId`、`amount`（`capture` のとき。与信額以下）

`SettleResponse`（§4.5 の例）：`success`、`transaction`（PSP の charge ID）、`network`、`amount`。確定が未確認のときは `settlement_pending`

エラーコード（§6.3）：`card_declined`、`card_authentication_required`

### 流れと規則（§4.5・§4.6）

- 最初の `/settle` で与信（`authorize`）。`/verify` は使わない
- 2 回目の `/settle` で `payload.type` が `capture`（最終額）か `void`
- facilitator は `payTo` と `paymentId` で与信を重複排除する。同じ `paymentId`・同じトークンの再送は既存の与信を返す。同じ `paymentId` で別のトークンか別の額なら拒否
- 1 つの支払いは `capture` か `void` を 1 回だけ。同じ内容の再送は保存した結果を返し、違う内容は拒否
- 少額払い（`batch-settlement` のカード版）、権限委任、追加認証、決済後のイベント、複数回の capture は後続の提案（§9）

## 2. PR #3131「Experimental shared-payment-token scheme」

- 出典：https://github.com/x402-foundation/x402/pull/3131 （コミット `3db55ca`、2026-08-11、`specs/schemes/shared-payment-token/scheme_shared_payment_token.md`）
- 中身：スキーム名 `shared-payment-token`、`network` は `spt:sandbox` などの環境名。特定の PSP に依存しない（例は `processor: "examplepay"`）。固定額のリクエストを、1 回使い切りの Shared Payment Token で 1 回の settle で払う。**与信と確定を分けない**。`payment-identifier` 拡張を必須に近い扱いで使い、ID を要求の指紋に結びつける
- PR #3707 との重なり：どちらも PAN を運ばず、PSP の不透明なトークンを payload に載せる。違いは、#3131 は独自スキームで即時の 1 回決済、#3707 は既存の `auth-capture` のネットワークバインディングで与信と確定を分ける点。押さえた資金と請求を結ぶ ID の問題（#3707 の項目 4）は、#3131 では settle が 1 回なので起きない

## 3. auth-capture の親仕様（main）

- 出典：`x402-foundation/x402` main の `specs/schemes/auth-capture/scheme_auth_capture.md`（v1.0 2026-05-13 Initial draft、v1.1 2026-08-18）。同じフォルダにあるバインディングは EVM（`scheme_auth_capture_evm.md`）だけ
- `extra.paymentFlow`：`escrow`（既定）と `authorization`。`escrow` は「settle → resource → settle」。`authorize` で資金を押さえ、資源の後に `capture` か `void`、さらに後で `refund`。押さえたまま capture の期限が過ぎたら client が `reclaim` できる
- ライフサイクルの操作はすべて `/settle`。2 回目以降は `payload.type`（`capture`・`void`・`refund`）で区別する。新しいエンドポイントは無い
- 資源の後の `capture`（か `void`）は、リクエストの中で同期的に終えても、後から非同期に行ってもよい

## 4. `payment-identifier` 拡張（main の `specs/extensions/payment_identifier.md`）

- `extensions["payment-identifier"].info.id`（16〜128 文字）。サーバは `info.required` で必須にできる
- 同じ `id`・同じ内容 → 保存した応答を返す。同じ `id`・違う内容 → **409 Conflict**。`required: true` で `id` が無い → 400
- `id` は要求の指紋（`scheme`・`network`・`asset`・`amount`・`payTo`・パスとメソッドなど）に結びつけて保存する
- このため、与信のあとの capture（同じ支払いで内容が違うメッセージ）は、拡張の規則のままでは 409 になる。#3707 の項目 4 が挙げている点

## 5. SDK（`@x402/core`）の対応

- 版：2.28.0（npm の最新は 2.30.0、2026-11-04）
- 独自スキームの登録：`SchemeNetworkClient`（`scheme`・`createPaymentPayload`）を `x402Client` に `register(network, client)` で登録できる。`card:*` のような網の型も渡せる
- escrow（settle を 2 回）：サーバ側の型に `paymentFlows`（`escrow` など）、「Multi-settle flows (`escrow`) invoke settle lifecycle hooks once per settle」、`settleOnCancel`（ハンドラ失敗時の settle）がある。対応はしている
- 本実装での使い方：
  - client：SDK の `x402Client` に `card:*` のスキームを登録して `PAYMENT-SIGNATURE` を作る（SDK を使う）
  - 402・`PAYMENT-REQUIRED`・`PAYMENT-SIGNATURE`・`PAYMENT-RESPONSE` のヘッダの組み立てと読み取り：SDK の `x402HTTPClient` を使う
  - **自前で書いた部分**：リソースサーバの escrow の進行（1 回目の settle → ハンドラ → 2 回目の settle）と、カードのライフサイクル payload（`payload.type` `capture`・`void`）の組み立て、facilitator（PAY.JP への与信・確定・取り消し、重複排除、実証5 の台帳）。理由：SDK のサーバの escrow は既存のスキーム（EVM）のライフサイクルに合わせたもので、カードの `capture` の額と `paymentId` を載せる組み立て方が仕様（PR #3707）に書かれておらず、SDK の内部の決まりに合わせるより、仕様の項目名どおりに書く方が比べやすいため
