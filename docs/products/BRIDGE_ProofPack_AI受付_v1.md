# BRIDGE ProofPack AI受付 v1 運用メモ

## 目的

BRIDGE ProofPack StarterのSquare決済後フローに、管理者確認用のAI受付ドラフト作成を追加します。
また、LINE / Gmail / LP問い合わせからの受付payloadも同じ `System_AI_Intake_Log` へsource別に記録できます。
既存の納品メール送信は維持し、AI受付の結果は購入者・問い合わせ者へ自動送信しません。

## 既存Square納品フローとの関係

- Square Webhookは従来どおり `payment.updated` かつ `COMPLETED` のみ処理します。
- Fulfillment Queueへの記録、Evidence Vault、Revenue Audit、購入者への納品メール送信は従来どおりです。
- AI受付は `processFulfillmentQueue()` 内で補助的に実行され、失敗しても納品処理を止めない設計です。
- AI受付の記録は `System_AI_Intake_Log` に保存します。
- LINE / Gmail / LP問い合わせは、Square納品キューには入れず、納品メール・外部返信・管理者通知も送信しません。

## AI処理の構成

1. **回答AI**: 受付情報から管理者確認用のStructured JSONドラフトを作成します。
2. **安全チェックAI**: 回答AIのJSONを検査し、`safe_to_log=true` かつ `safe_to_send=false` かつ `blocked=false` の場合だけログにドラフトを保存します。
3. **決定的ガード**: AI判定とは別に、入力・回答ドラフトの禁止語、`draft_only`、`review_required`、本人判断ボタン文言をコード側でも検査します。

## Structured JSON出力

`draft_json` には以下の構造を保存します。

```json
{
  "schema_version": "bridge_proofpack_ai_intake_v1",
  "source": "square|line|gmail|lp|manual|unknown",
  "category": "purchase_intake|delivery_support|general_question|sensitive_trouble|unknown",
  "risk_level": "low|medium|high|unknown",
  "reply_mode": "draft_only",
  "draft_only": true,
  "review_required": true,
  "auto_send_allowed": false,
  "reply_draft": "管理者確認用ドラフト本文",
  "next_action_button_label": "内容を確認して本人判断で進める",
  "safety_notes": "安全チェックメモ"
}
```

## ログ設計

`System_AI_Intake_Log` はSquareに加え、LINE/Gmail/LP問い合わせ受付にも流用できるよう、以下の列を持ちます。

| column | 用途 |
| --- | --- |
| `created_at` / `updated_at` | 作成・更新日時 |
| `source` | `square`, `line`, `gmail`, `lp`, `manual`, `unknown` |
| `payment_id` / `event_id` / `buyer_email` | Square連携時の識別情報。LINE/Gmail/LPでは空でも可 |
| `original_message` | LINE/Gmail/LP等の元メッセージまたはSquare note |
| `category` | 受付分類 |
| `risk_level` | `low`, `medium`, `high`, `unknown` |
| `reply_mode` | 常に `draft_only` |
| `draft_only` / `review_required` | 常に `TRUE` |
| `status` / `reason` | `SKIPPED`, `DRAFT_READY`, `BLOCKED`, `ERROR` と理由 |
| `model` / `safety_model` | 回答AI・安全チェックAIのモデル |
| `draft_hash` / `draft_json` / `draft_text` | 管理者確認用ドラフト。BLOCKED時は本文を保存しません |
| `safety_notes` / `last_error` | 安全チェックメモ、API/JSONエラー内容 |
| `raw_summary` | 元payloadの要約 |

## LINE / Gmail / LP問い合わせの受付

Cloudflare Worker経由で同じGAS WebhookへPOSTします。Square既存フローを壊さないため、`source` が `line` / `gmail` / `lp` の場合だけAI受付payloadとして扱います。

- Query例: `/intake?source=line` / `/intake?source=gmail` / `/intake?source=lp`
- Path例: `/line` / `/gmail` / `/lp`
- Workerは上記sourceを検出した場合だけ、bodyに `type: "proofpack.ai_intake"` と `source` を付与してGASへ転送します。source指定がないSquare Webhook bodyは従来どおり変更せず転送します。
- GAS側は `source` 別に `System_AI_Intake_Log` へ記録し、`payment_id` がない問い合わせでも `event_id` / `message_id` / `inquiry_id` 等を識別子として保存します。
- 問い合わせpayload例:

```json
{
  "type": "proofpack.ai_intake",
  "source": "lp",
  "inquiry_id": "lp-001",
  "email": "customer@example.com",
  "message": "納品URLについて確認したいです"
}
```

## Script Properties / 環境変数

| key | 必須 | 既定値 | 用途 |
| --- | --- | --- | --- |
| `PROOFPACK_AI_INTAKE_ENABLED` | 任意 | `false` | `true` の場合のみAI受付を実行します。OFF時はスキップ記録のみ残します。 |
| `OPENAI_API_KEY` | 任意 | 空 | OpenAI APIキーです。未設定でも納品フローは継続します。 |
| `PROOFPACK_AI_INTAKE_MODEL` | 任意 | `gpt-4o-mini` | 回答AIに使うモデル名です。 |
| `PROOFPACK_AI_SAFETY_MODEL` | 任意 | `PROOFPACK_AI_INTAKE_MODEL` と同じ | 安全チェックAIに使うモデル名です。 |
| `OPENAI_RESPONSES_URL` | 任意 | `https://api.openai.com/v1/responses` | OpenAI Responses APIのエンドポイントです。通常は未設定で問題ありません。 |
| `ADMIN_EMAIL` | 任意 | 空 | AI受付ドラフトが作成された場合、管理者へレビュー依頼通知を送ります。 |

## 安全ルール

- AI受付ドラフトは購入者・LINE/Gmail/LP問い合わせ者へ自動送信しません。
- `reply_mode=draft_only`、`draft_only=true`、`review_required=true`、`auto_send_allowed=false` をStructured JSONとログに残します。
- 本人判断ボタン文言は `内容を確認して本人判断で進める` に固定します。
- 管理者通知にもドラフト本文は入れず、`System_AI_Intake_Log` の確認を促すだけです。
- 入力またはAI出力に未払い・未収・督促・クレーム・返金・法的トラブル関連の禁止語が含まれる場合は `BLOCKED` として本文を保存しません。
- OpenAI APIキー未設定、APIエラー、空レスポンス、不正JSONの場合も納品メール送信は継続します。

## テスト方法

ローカルでは以下を実行します。

```bash
node --check index.js
node --check dedupe.js
cp main.gs /tmp/main_check.js && node --check /tmp/main_check.js
node tests/proofpack_ai_intake.test.js
node tests/proofpack_worker.test.js
```

Apps Scriptでは以下を確認します。

1. `PROOFPACK_AI_INTAKE_ENABLED` 未設定または `false` で `processFulfillmentQueue()` を実行し、納品メールが従来どおり送信されること。
2. `System_AI_Intake_Log` に `SKIPPED / feature_flag_disabled`、`reply_mode=draft_only`、`review_required=TRUE` が記録されること。
3. `PROOFPACK_AI_INTAKE_ENABLED=true` かつ `OPENAI_API_KEY` 未設定で実行し、納品メールが継続し、`SKIPPED / openai_api_key_missing` が記録されること。
4. APIキー設定後、テスト用決済データで回答AIと安全チェックAIが順に呼ばれ、`DRAFT_READY / draft_only_admin_review_required` とStructured JSONが記録されること。
5. 禁止語を含むテスト入力、または安全チェックAIが `blocked=true` を返すケースでは `BLOCKED` になり、AI文面が購入者へ送信されないこと。
6. `/intake?source=line`、`/intake?source=gmail`、`/intake?source=lp` からテストpayloadをPOSTし、Square納品キューへ入らず `System_AI_Intake_Log` にsource別で記録されること。

## 残課題

- 本番導入前に、Apps Script実環境でOpenAI APIの疎通、Apps Scriptの実行時間、UrlFetchAppの割当を確認してください。
- 禁止語リストは初期版です。運用ログを見ながら過不足を調整してください。
- AI受付ドラフトのレビュー・承認UIは未実装です。現時点では `System_AI_Intake_Log` の手動確認運用です。
- LINE公式Messaging API、Gmail転送/Apps Scriptトリガー、LPフォーム本番側の署名検証・リトライ設計は各チャネルの本番仕様に合わせて追加確認してください。
- AI受付ドラフトの承認後送信機能は未実装です。現時点では外部返信を絶対に行わず、ログ確認だけに留めます。
