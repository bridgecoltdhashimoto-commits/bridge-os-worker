# BRIDGE ProofPack AI受付 v1 運用メモ

## 目的

BRIDGE ProofPack StarterのSquare決済後フローに、管理者確認用のAI受付ドラフト作成を追加します。
既存の納品メール送信は維持し、AI受付の結果は購入者へ自動送信しません。

## 既存Square納品フローとの関係

- Square Webhookは従来どおり `payment.updated` かつ `COMPLETED` のみ処理します。
- Fulfillment Queueへの記録、Evidence Vault、Revenue Audit、購入者への納品メール送信は従来どおりです。
- AI受付は `processFulfillmentQueue()` 内で補助的に実行され、失敗しても納品処理を止めない設計です。
- AI受付の記録は `System_AI_Intake_Log` に保存します。

## Script Properties / 環境変数

| key | 必須 | 既定値 | 用途 |
| --- | --- | --- | --- |
| `PROOFPACK_AI_INTAKE_ENABLED` | 任意 | `false` | `true` の場合のみAI受付を実行します。OFF時はスキップ記録のみ残します。 |
| `OPENAI_API_KEY` | 任意 | 空 | OpenAI APIキーです。未設定でも納品フローは継続します。 |
| `PROOFPACK_AI_INTAKE_MODEL` | 任意 | `gpt-4o-mini` | AI受付ドラフト作成に使うモデル名です。 |
| `OPENAI_RESPONSES_URL` | 任意 | `https://api.openai.com/v1/responses` | OpenAI Responses APIのエンドポイントです。通常は未設定で問題ありません。 |
| `ADMIN_EMAIL` | 任意 | 空 | AI受付ドラフトが作成された場合、管理者へレビュー依頼通知を送ります。 |

## 安全ルール

- AI受付ドラフトは購入者へ自動送信しません。
- 管理者通知にもドラフト本文は入れず、`System_AI_Intake_Log` の確認を促すだけです。
- 入力またはAI出力に未払い・クレーム・返金・法的トラブル関連の禁止語が含まれる場合は `BLOCKED` として本文を保存しません。
- OpenAI APIキー未設定、APIエラー、空レスポンスの場合も納品メール送信は継続します。

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
2. `System_AI_Intake_Log` に `SKIPPED / feature_flag_disabled` が記録されること。
3. `PROOFPACK_AI_INTAKE_ENABLED=true` かつ `OPENAI_API_KEY` 未設定で実行し、納品メールが継続し、`SKIPPED / openai_api_key_missing` が記録されること。
4. APIキー設定後、テスト用決済データで `DRAFT_READY / admin_review_required_not_auto_sent` が記録され、購入者へAI文面が送信されないこと。
5. 禁止語を含むテスト入力では `BLOCKED` になり、AI文面が購入者へ送信されないこと。

## 残課題

- 本番導入前に、Apps Script実環境でOpenAI APIの疎通、Apps Scriptの実行時間、UrlFetchAppの割当を確認してください。
- 禁止語リストは初期版です。運用ログを見ながら過不足を調整してください。
- AI受付ドラフトのレビュー・承認UIは未実装です。現時点では `System_AI_Intake_Log` の手動確認運用です。
