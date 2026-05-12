# Square自動納品の複数商品運用

この手順は、`Square → Cloudflare Worker → GAS → Google Sheets → Gmail納品` の既存導線を、商品別に判定して納品メールを切り替えるための運用メモです。本番購入、本番送信、Square本番設定変更、Cloudflare環境変数変更、GAS Script Properties変更は、このPRでは行いません。

## Product_Masterに商品を追加する

GASの `ensureSystemSheets_()` が `Product_Master` シートと以下のヘッダーを作成します。既存ヘッダーは削除せず、不足列だけ末尾に追加されます。

```csv
product_key,product_name,active,match_type,match_value,delivery_url,mail_subject,mail_body_template,support_url,notes,created_at,updated_at
```

商品を増やす場合は、`Product_Master` に1行追加します。

| 列 | 入力例 | 説明 |
| --- | --- | --- |
| `product_key` | `estimate_front` | システム内で一意の商品キー。 |
| `product_name` | `BRIDGE 見積前受付フロント` | 納品メールやログに残す商品名。 |
| `active` | `TRUE` | `TRUE` / `1` / `yes` / `y` の行だけ判定対象。 |
| `match_type` | `product_name` / `text` / `amount` | Square payloadとの照合方法。 |
| `match_value` | `BRIDGE 見積前受付フロント` / `29800` | 判定に使う値。`amount` の場合はSquareの最小通貨単位（JPYなら円）。 |
| `delivery_url` | 納品URL | 商品別の納品URL。ProofPack Starterの後方互換ではScript Propertiesの `DELIVERY_URL` も使えます。 |
| `mail_subject` | `【納品】{{product_name}}` | `{{product_name}}` などのプレースホルダーが使用可能。 |
| `mail_body_template` | `納品URL: {{delivery_url}}` | 商品別本文。空なら汎用本文、ProofPack Starterは既存本文。 |
| `support_url` | サポートURL | 商品別サポートURL。空なら `SUPPORT_FORM_URL` を使用。 |

## Square側の商品識別値

商品判定は、Square webhook payload内の `payment.note`、`order_id`、`payment_link_id`、`checkout_id`、レシート情報、payload全体のJSON文字列を検索対象にします。可能な限り、Squareの商品名、Payment Link名、メモなどに `product_key` か明確な商品名を入れ、`match_type=product_name` または `match_type=text` で判定してください。

`match_type=amount` は最後のfallbackとして扱います。同額商品が存在すると誤判定の危険があるため、同額商品を販売する場合は金額マッチだけに依存しないでください。

## 既存ProofPack Starterへの影響

`Product_Master` が未設定でも、100円決済は `proofpack_starter` として後方互換fallback判定されます。ProofPack Starterのメール本文テンプレートが空の場合は、既存の `buildDeliveryMail_()` の件名・本文を使うため、既存の自動納品文面を維持します。

## 本番化前の確認

1. `TEST_resolveProductFromSamplePayload()` でProofPack Starterが `proofpack_starter` に判定されることを確認します。
2. `Product_Master` に新商品行を追加し、`TEST_buildDeliveryMailByProduct()` または手元のサンプルpayloadで件名・本文の差し替えを確認します。
3. `TEST_processFulfillmentQueue_dryRun()` で実メール送信なしにキュー処理の判定を確認します。
4. 本番切替前に、必ず100円テストなどの低額テストで、Square payloadに想定した商品識別値が含まれることを人間が確認してください。
5. 未知の商品は自動納品せず、`UNKNOWN_PRODUCT` / `ERROR` として `System_Fulfillment_DLQ` とキューの `last_error` に残ることを確認してください。
