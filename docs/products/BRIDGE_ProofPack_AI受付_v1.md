# BRIDGE ProofPack AI受付 v1 運用メモ

## 目的

BRIDGE ProofPack StarterのSquare決済後フローに、管理者確認用のAI受付ドラフト作成を追加します。
既存の納品メール送信は維持し、AI受付の結果は購入者へ自動送信しません。

## 既存Square納品フローとの関係

- Square Webhookは従来どおり `payment.updated` かつ `COMPLETED` のみ処理します。
- Fulfillment Queueへの記録、Evidence Vault、Revenue Audit、購入者への納品メール送信は従来どおりです。
- AI受付は `processFulfillmentQueue()` 内で補助的に実行され、失敗しても納品処理を止めない設計です。
- AI受付の記録は `System_AI_Intake_Log` に保存します。

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

`System_AI_Intake_Log` はSquareだけでなく、将来のLINE/Gmail/LP問い合わせ受付にも流用できるよう、以下の列を持ちます。

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

- AI受付ドラフトは購入者へ自動送信しません。
- `reply_mode=draft_only`、`draft_only=true`、`review_required=true`、`auto_send_allowed=false` をStructured JSONとログに残します。
- 本人判断ボタン文言は `内容を確認して本人判断で進める` に固定します。
- 管理者通知にもドラフト本文は入れず、`System_AI_Intake_Log` の確認を促すだけです。
- 入力またはAI出力に未払い・クレーム・返金・法的トラブル関連の禁止語が含まれる場合は `BLOCKED` として本文を保存しません。
- OpenAI APIキー未設定、APIエラー、空レスポンス、不正JSONの場合も納品メール送信は継続します。

## テスト方法

ローカルでは以下を実行します。

```bash
node --check index.js
node --check dedupe.js
cp main.gs /tmp/main_check.js && node --check /tmp/main_check.js
node tests/proofpack_ai_intake.test.js
```

Apps Scriptでは以下を確認します。

1. `PROOFPACK_AI_INTAKE_ENABLED` 未設定または `false` で `processFulfillmentQueue()` を実行し、納品メールが従来どおり送信されること。
2. `System_AI_Intake_Log` に `SKIPPED / feature_flag_disabled`、`reply_mode=draft_only`、`review_required=TRUE` が記録されること。
3. `PROOFPACK_AI_INTAKE_ENABLED=true` かつ `OPENAI_API_KEY` 未設定で実行し、納品メールが継続し、`SKIPPED / openai_api_key_missing` が記録されること。
4. APIキー設定後、テスト用決済データで回答AIと安全チェックAIが順に呼ばれ、`DRAFT_READY / draft_only_admin_review_required` とStructured JSONが記録されること。
5. 禁止語を含むテスト入力、または安全チェックAIが `blocked=true` を返すケースでは `BLOCKED` になり、AI文面が購入者へ送信されないこと。

## 残課題

- 本番導入前に、Apps Script実環境でOpenAI APIの疎通、Apps Scriptの実行時間、UrlFetchAppの割当を確認してください。
- 禁止語リストは初期版です。運用ログを見ながら過不足を調整してください。
- AI受付ドラフトのレビュー・承認UIは未実装です。現時点では `System_AI_Intake_Log` の手動確認運用です。
- LINE/Gmail/LPの実Webhook接続は未実装です。ログ列と正規化関数のみ将来拡張できる形にしています。
