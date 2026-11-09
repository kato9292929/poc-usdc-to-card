# 実証4 結果（PAY.JP テストモード）

- 実行：GitHub Actions `payjp-run` #3（run 42616819880）、コミット `4d2796c3970c2b2cabd3697101407fd14f0c9b89`
- ランナー：Dulles Town Center, Virginia, US（AS8075 Microsoft Corporation）。ジョブのログ上の Region は Azure `centralus`
- 方式A：`2026-11-09T12-25-05-737Z-4-A`（2026-11-09T12:25:05.737Z〜2026-11-09T12:26:47.571Z）／方式B：`2026-11-09T12-25-05-737Z-4-B`（2026-11-09T12:26:47.573Z〜2026-11-09T12:28:29.269Z）
- 価格 50 円（`asset: JPY`、`network: card:visa`、`extra.psp: payjp`、`extra.paymentFlow: escrow`）。データは jin.x402jp.com の `/api/jin/latest`
- 生データ：`docs/runs/`、402 と PAYMENT-RESPONSE の実物：`docs/examples/`

## 時間（通常 20 回、ミリ秒、中央値（最小〜最大、p90））

```
項目                   方式A                         方式B
402 受信から 200 まで  3432（2816〜4433、p90 3673）  3404（3046〜3709、p90 3546）
PAY.JP の与信 API      1191（873〜1365、p90 1264）   1204（947〜1268、p90 1238）
与信から確定まで       1191（838〜1954、p90 1238）   1154（1098〜1271、p90 1205）
```

## ケースごとの件数（PAY.JP の `GET /v1/charges` を metadata の run_id・payment_id で突き合わせ）

```
ケース              回数  方式  応答       与信  確定  取消  未処理  確定額
通常                20    A     200×20     20    20    0     0       1000
通常                20    B     200×20     20    20    0     0       1000
ハンドラ失敗        3     A     502×3      3     0     3     0       0
ハンドラ失敗        3     B     502×3      3     0     3     0       0
同じ支払いの再送    3     A     200×6      3     3     0     0       150
同じ支払いの再送    3     B     200×6      3     3     0     0       150
確定後の応答の欠落  3     A     0×3 200×3  3     3     0     0       150
確定後の応答の欠落  3     B     0×3 200×3  3     3     0     0       150
```

応答の 0 は、確定後に接続を切った回（クライアントに応答が届いていない）。再送・応答欠落の各回は、同じ PAYMENT-SIGNATURE を 2 回送った。

## facilitator の数え

```
項目                                     方式A  方式B
与信の /settle                           35     35
そのうち既存の与信を返した               6      6
確定・取消の /settle                     35     35
そのうち保存した結果を返した             6      6
payment-identifier の規則どおりなら 409  0      35
PAY.JP API 呼び出し：token               29     29
PAY.JP API 呼び出し：authorize           29     29
PAY.JP API 呼び出し：capture             26     26
PAY.JP API 呼び出し：refund              3      3
PAY.JP API 呼び出し：list                1      1
```

## PAY.JP の charge ID

- 方式A・通常：`ch_e17a4e5e4073e0ac1fd95e4a68e0c`, `ch_a1137e33593ac091ce38f478df6de`, `ch_33b41d0dd45c93d5a624e2e88a857`, `ch_1f71f61c599781b2f0f66a3a5ab06`, `ch_052b27a7ee95375ab368aee3dd7c8`, `ch_9527e4ebd5dd53dbb6ef2e206a962`, `ch_26fe5fc2f2f98b45553eb6c001848`, `ch_df7371919ee0e6c3327620ec5a4e9`, `ch_30dce1448b20e90d3680096c1e4bd`, `ch_f91ab53c533232c9903412826f382`, `ch_adb79e8ff74e5b0afa906c4dfceb5`, `ch_0cefb78917fddc5df40bd24748a7d`, `ch_1c0bb0216c2e9927425c7a649f157`, `ch_71359dc38e2e908707480713e12d4`, `ch_21959efb69e4cc45045c89e1084d2`, `ch_7327d786d5950bb48333c82c1a0d2`, `ch_46d3602bee225b162ed3b6d2e477e`, `ch_09d6769e8ded3982eaedf8b74bf33`, `ch_cb8597fb8f99fe0a7064fe9f89766`, `ch_4001b000bd0875824137e322168cc`
- 方式A・ハンドラ失敗：`ch_a057645d194c9fc3002ba83eb6480`, `ch_07b0c88ef3e8ca1d8473d8f685391`, `ch_1d03f7b31b3d6fc7f205063bee39a`
- 方式A・同じ支払いの再送：`ch_6b90a0a374351963f0fe12032a92b`, `ch_deae4293b96664a7f8d3cce9ce107`, `ch_654033e72077cfb8661e11f6e1df7`
- 方式A・確定後の応答の欠落：`ch_3ef34ba076efca967822028cb0aec`, `ch_17d95d4de0d076b8909395844abae`, `ch_ef9cd7c63f44d99e1067b3943c73e`
- 方式B・通常：`ch_ca59af5a5f67696e42a6483ceef56`, `ch_12067a9aa44534d5ecae14492aed0`, `ch_7394d1c3c18ab3a66563bac6b121e`, `ch_9b6970f5ded482b7075e1bc61fc5d`, `ch_c47cfa61ed0408e314ad8db1e18bd`, `ch_58995513dcf65b6966fe46f0bba80`, `ch_820f247e37f500293769ff15b13d6`, `ch_fdcb89d44c64400cb20a95765e036`, `ch_d5c171fdcccab60cae0c62938876b`, `ch_8847ee5eff002e4137c82b77ea5d7`, `ch_9279843562bc7c1ca070ee7c5d6d3`, `ch_15e85f1462533275ace9e215021bb`, `ch_a90055d044140ad4d3b71a511f08b`, `ch_4c876a71c2a67064e85bf9d6d3d77`, `ch_c970432e1b03eff29f26300c4f5d9`, `ch_db5d04ccf0918276273a0edec3fb7`, `ch_f911614420afa49836e9f6f762034`, `ch_3764a47d60f7e320610870d3a5679`, `ch_6e49e8916886bf75729530e25d5ef`, `ch_257460c200f01280db85a70c9068f`
- 方式B・ハンドラ失敗：`ch_febe6b0a044009baee3712de48222`, `ch_cdae4d347efcbc428bbccd0f7ecf0`, `ch_bf3f129edbe5ef3182ca88e7388ae`
- 方式B・同じ支払いの再送：`ch_4c08500ce7c472b1c230b942f55f5`, `ch_e051c4ece079d59540c268fb0e2ec`, `ch_c4e94789e0a0e5f793cc4cbca6f81`
- 方式B・確定後の応答の欠落：`ch_78d8cb7dcd960ecc4a4d7ff7e8a48`, `ch_658c3f469c50b3fc7aea287e23ef7`, `ch_9a31d9b330a33d9a0e477212cc276`
