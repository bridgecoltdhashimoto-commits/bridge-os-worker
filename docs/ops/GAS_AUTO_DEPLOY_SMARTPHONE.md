# BRIDGE OS: GitHub → GAS 自動反映・スマホ確認運用

## 目的

Apps Scriptのコードを毎回手作業で貼り替えず、GitHubの `main.gs` をGASへ自動反映するための運用です。

スマホしか見られないタイミングでも、GitHub Actionsの緑/赤チェックとSummaryだけで状況判断できるようにします。

## できること

- GitHubの `main.gs` をApps Scriptへ `clasp push --force` で反映
- 既存WebアプリのDeployment IDを指定している場合のみ、デプロイ更新
- デプロイ更新後にGAS Webアプリへsmoke test payloadをPOST
- GitHub Actions Summaryに成功/失敗を表示
- 任意で外部通知Webhookへ結果を送信

## 安全設計

- PRをマージしただけでは、Secrets未設定なら反映できません。
- `GAS_SCRIPT_ID` と `CLASPRC_JSON` が必須です。
- Webアプリのデプロイ更新は、以下のどちらかの場合だけ動きます。
  - workflow_dispatch実行時に `deploy_webapp=true` を選ぶ
  - Repository Variables の `AUTO_DEPLOY_GAS_WEBAPP=true` を設定する
- `GAS_DEPLOYMENT_ID` がない状態では、既存Webアプリ更新は失敗して止まります。
- smoke testは `GAS_WEB_APP_URL` がある場合のみ実行します。

## 必要なGitHub Secrets

| Secret名 | 必須 | 用途 |
| --- | --- | --- |
| `GAS_SCRIPT_ID` | 必須 | 反映先Apps ScriptのScript ID |
| `CLASPRC_JSON` | 必須 | clasp用のGoogle OAuth認証情報 |
| `GAS_DEPLOYMENT_ID` | Webアプリ更新時のみ | 既存WebアプリDeployment ID |
| `GAS_WEB_APP_URL` | smoke test時のみ | デプロイ済みGAS WebアプリURL |
| `GAS_WEBHOOK_TOKEN` | token運用時のみ | GAS Webhook token |
| `BRIDGE_NOTIFY_WEBHOOK_URL` | 任意 | 外部通知先Webhook URL |

## 必要なRepository Variable

| Variable名 | 値 | 用途 |
| --- | --- | --- |
| `AUTO_DEPLOY_GAS_WEBAPP` | `true` / `false` | main更新時に既存Webアプリまで更新するか |

初期値は未設定または `false` 推奨です。

## スマホで見る場所

1. GitHubリポジトリを開く
2. Actionsを開く
3. `GAS Auto Deploy Guarded` を開く
4. 緑なら成功、赤なら失敗
5. run内のSummaryを見る

## 成功時の判断

- `GAS反映: 実行`
- `Webアプリデプロイ更新: true` または `false`
- `Smoke test: true` の場合、smoke testが通っていれば本番接続確認OK

## 失敗時の判断

赤チェックの場合は、以下のどれかが多いです。

- `GAS_SCRIPT_ID` 未設定
- `CLASPRC_JSON` 未設定または期限切れ
- `GAS_DEPLOYMENT_ID` が違う
- `GAS_WEB_APP_URL` が違う
- GAS側の `WEBHOOK_TOKEN` とGitHub Secretの `GAS_WEBHOOK_TOKEN` が不一致
- Apps Script側の権限承認が未完了

## 初回だけ必要なこと

初回だけ、Googleアカウントでclasp認証を作り、`.clasprc.json` の中身を `CLASPRC_JSON` Secretへ入れる必要があります。

この作業はスマホだけでは難しいため、PCまたはAgent Modeでの画面操作が必要です。

## 運用ルール

- いきなり `AUTO_DEPLOY_GAS_WEBAPP=true` にしない
- 最初はworkflow_dispatchで `deploy_webapp=false` のGAS反映だけ確認する
- 次に `deploy_webapp=true` で既存デプロイ更新とsmoke testを確認する
- 3回連続で成功してから自動デプロイONを検討する
