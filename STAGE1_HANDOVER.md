# Stage 1 運用メモ（Square 100円決済 疎通テスト）

## 1) マージ前に Cloudflare 側で設定すべき項目（CONFIG_ERROR 回避のため必須）
- `GAS_WEBHOOK_URL`（Worker Variable）
- `GAS_WEBHOOK_TOKEN`（Worker Secret）

> `GAS_WEBHOOK_URL` が未設定のままデプロイすると Worker は `CONFIG_ERROR` を返します。

## 2) マージ後でよい項目
- Square Dashboard の Webhook 通知先URL（Worker URL）
- Square Webhook 送信イベントの選択（支払い完了系）

## 3) Google Apps Script 側に設定すべき Script Properties
- `WEBHOOK_TOKEN`
- `ADMIN_EMAIL`
- `SHEET_ID`

## 4) GAS へ `main.gs` を反映する具体的手順
1. Apps Script プロジェクトを開き、`main.gs` を最新化（GitHub差分どおり）
2. `プロジェクトの設定` → `スクリプト プロパティ` で以下の名前を追加
   - `WEBHOOK_TOKEN`
   - `ADMIN_EMAIL`
   - `SHEET_ID`
3. `デプロイ` → `新しいデプロイ` → `ウェブアプリ`
   - 実行ユーザー: 自分
   - アクセス: 全員
   - デプロイ後、発行された WebアプリURL を Cloudflare `GAS_WEBHOOK_URL` に設定

## 5) Square 100円決済テスト前の最終チェックリスト
- Cloudflare
  - `GAS_WEBHOOK_URL` が設定済み
  - `GAS_WEBHOOK_TOKEN` が設定済み
- GAS
  - `WEBHOOK_TOKEN` が設定済み（Cloudflare `GAS_WEBHOOK_TOKEN` と同じ値）
  - `ADMIN_EMAIL` が設定済み
  - `SHEET_ID` が設定済み
  - `main.gs` を含む Webアプリ最新デプロイ済み
- Square
  - Webhook通知先が Worker URL
  - テスト決済額が 100円

## 橋本さんの手作業（3つ以内）
1. Cloudflare に `GAS_WEBHOOK_URL` と `GAS_WEBHOOK_TOKEN` を設定
2. GAS に `WEBHOOK_TOKEN` / `ADMIN_EMAIL` / `SHEET_ID` を設定し、Webアプリ再デプロイ
3. Square で 100円テスト決済を実行
