# BRIDGE 見積前受付フロント GASデプロイ手順

## 前提

このGASは販売検証用MVPです。初期状態では `TEST_MODE=true` とし、本番メールは送信しません。Square決済リンクも自動作成・変更・削除しません。

## 1. Googleスプレッドシート作成手順

1. Googleドライブで新しいスプレッドシートを作成します。
2. ファイル名を `BRIDGE_見積前受付フロント_管理台帳_テスト` にします。
3. URL内のスプレッドシートIDを控えます。
4. Apps Scriptから `setupEstimateFrontSheets()` を実行し、次のシートが作成されることを確認します。
   - Settings
   - Customers
   - Leads
   - Mail_Log
   - Reminder_Log
   - System_Log
   - System_DLQ

## 2. Apps Script作成手順

1. スプレッドシートのメニューから「拡張機能」→「Apps Script」を開きます。
2. プロジェクト名を `BRIDGE_見積前受付フロント_MVP` にします。
3. 既存の `コード.gs` がある場合は、中身を消すか、使わない状態にします。
4. 本番運用中の既存GASプロジェクトには貼り付けないでください。

## 3. 各GSファイル貼り付け手順

Apps Scriptエディタで次のファイルを作成し、このリポジトリ内の同名ファイルを貼り付けます。

1. `00_config.gs`
2. `01_sheet_setup.gs`
3. `02_form_receiver.gs`
4. `03_auto_reply.gs`
5. `04_lead_ledger.gs`
6. `05_reminder.gs`
7. `06_admin_tools.gs`

貼り付け後、保存して構文エラーが出ないことを確認します。

## 4. Script Properties設定手順

Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」で以下を設定します。

| key | value例 | 必須 | 用途 |
| --- | --- | --- | --- |
| ESTIMATE_FRONT_CONTROL_SSID | スプレッドシートID | 推奨 | 管理台帳の指定 |
| ESTIMATE_FRONT_TEST_MODE | true | 必須 | trueの場合、本番メールを送信しない |
| ESTIMATE_FRONT_ADMIN_EMAIL | owner@example.com | 必須 | 管理者通知先 |
| ESTIMATE_FRONT_SUPPORT_EMAIL | support@example.com | 任意 | 返信文面内のサポート先 |
| ESTIMATE_FRONT_DEFAULT_CUSTOMER_ID | demo_customer | 推奨 | 既定の顧客ID |
| ESTIMATE_FRONT_WEBHOOK_TOKEN | 任意の長い文字列 | 推奨 | Webhook簡易認証 |
| ESTIMATE_FRONT_REMINDER_HOURS | 24 | 任意 | リマインド予定までの時間 |

## 5. テストモード確認方法

1. Apps Scriptで `showEstimateFrontMode()` を実行します。
2. ログに `ESTIMATE_FRONT_TEST_MODE=true` と表示されることを確認します。
3. `false` が表示された場合は、本番送信前チェックが完了するまで `true` に戻してください。

## 6. テストフォーム送信方法

最初はWeb公開せず、Apps Scriptエディタ上で確認します。

1. `setupEstimateFrontSheets()` を実行します。
2. `testEstimateFrontDoPost()` を実行します。
3. `Leads` にテスト問い合わせが1行追加されることを確認します。
4. `Mail_Log` に `customer_auto_reply` と `admin_notice` が追加されることを確認します。
5. `Reminder_Log` に `test_scheduled_not_sent` が追加されることを確認します。
6. `System_Log` に致命的なエラーがないことを確認します。
7. `System_DLQ` に行が追加されていないことを確認します。

## 7. Webアプリとしてテスト公開する場合

1. Apps Scriptの「デプロイ」→「新しいデプロイ」を選択します。
2. 種類は「ウェブアプリ」を選択します。
3. 実行ユーザーは自分を選択します。
4. アクセス権はテスト範囲に合わせて選択します。
5. 発行されたURLに、必要に応じて `?token=ESTIMATE_FRONT_WEBHOOK_TOKENの値` を付けます。
6. 本番フォームに接続する前に、必ずテスト用フォームまたはcurl相当の検証だけで確認します。

## 8. 本番メール送信前チェックリスト

本番送信を有効にする前に、橋本が手動で以下を確認してください。

- `ESTIMATE_FRONT_TEST_MODE=true` のままテストが成功している
- `Leads` に問い合わせデータが正しく入る
- `Mail_Log` の自動返信文に誤字・過度な表現がない
- `Mail_Log` の送信先が正しい
- `Settings` の事業者名、営業時間、返信目安、キャンセル注意事項が正しい
- `Settings` のSquare決済リンクが本当に対象商品のリンクである
- 予約金/着手金は「必要な場合のみ案内」の運用になっている
- 工事可否、見積金額、契約判断を断定する文面がない
- テスト用メールアドレス以外に送信されないことを確認済み

## 9. Square決済リンクの貼り付け場所

Square決済リンクは自動作成しません。事業者がSquare側で作成したリンクを、スプレッドシートの `Settings` シートにある `square_payment_link` の `value` 欄へ貼り付けます。

予約金/着手金案内を出す場合は、同じく `Settings` で以下を設定します。

- `deposit_enabled` を `true`
- `deposit_label` を `予約金` または `着手金` などに設定
- `deposit_amount` に金額を入力

## 10. LINE公式リッチメニューに貼るURL案内

LINE公式のリッチメニューや応答メッセージには、受付フォームまたはLPのURLを貼ります。

例文：

> お見積り前の確認はこちらからお願いします。対応エリア、写真の有無、希望時期、注意事項をまとめて受付できます。
> {{estimate_front_url}}

## 11. 失敗時の確認手順

1. `System_Log` を確認します。
2. `System_DLQ` に行がある場合は、`payload_json` と `error_message` を確認します。
3. `Settings` の必須項目が空欄でないか確認します。
4. Script Propertiesの `ESTIMATE_FRONT_CONTROL_SSID` が正しいか確認します。
5. Webhook tokenを設定している場合、URLの `token` が一致しているか確認します。
6. 直近で貼り付けたGSファイルに欠落がないか確認します。

## 12. 橋本が手動で押すべきボタン

1. Apps Scriptで `setupEstimateFrontSheets()` を実行
2. Apps Scriptで `showEstimateFrontMode()` を実行
3. Apps Scriptで `testEstimateFrontDoPost()` を実行
4. Sheetsで `Leads` / `Mail_Log` / `Reminder_Log` を確認
5. 問題なければWebアプリとしてテストデプロイ
6. テストフォームから送信
7. 本番化前チェックリストを確認

## 13. 禁止事項

- 既存ProofPack本番フローを変更しない
- 既存Square本番リンクを変更しない
- 既存Cloudflare Workerを変更しない
- 既存GAS本番コードを壊さない
- 本番決済リンクを作成・変更・削除しない
- テスト完了前に本番メールを送信しない
- 既存HPを強制的に差し替えない
