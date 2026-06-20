# TikTok Shop Tracking System

TikTok Shop注文CSVとヤマトPDFを照合し、公式APIで追跡番号を反映するための専用アプリです。

## 機密情報

実キーやトークンは `.env` にだけ入れてください。`.env` は `.gitignore` 済みです。

```bash
cp .env.example .env
```

## 起動

```bash
npm start
```

```text
http://localhost:3010
```

## デプロイ

RenderまたはRailwayのWeb Serviceとしてデプロイしてください。`Dockerfile` と `render.yaml` を同梱しています。

### Render

1. GitHubなどにこの `tiktok-shop-tracking-system` フォルダをアップロードします。
2. Renderで `New Web Service` を作成します。
3. Root Directoryに `tiktok-shop-tracking-system` を指定します。
4. Build Command:

```bash
npm install --omit=dev
```

5. Start Command:

```bash
npm start
```

6. 環境変数をRenderのDashboardに設定します。`.env` はアップロードしません。

必須:

```text
TIKTOK_SHOP_DRY_RUN=false
TTS_APP_KEY
TTS_APP_SECRET
TTS_ACCESS_TOKEN
TTS_REFRESH_TOKEN
TTS_SHOP_CIPHER
TTS_API_BASE_URL=https://open-api.tiktokglobalshop.com
TTS_SHIP_ENDPOINT_PATH=/fulfillment/202309/packages/{package_id}/ship
TTS_SHIPPING_PROVIDER_ID
CSV_DATE_COLUMN_INDEX=23
CSV_PACKAGE_ID_LABELS=Package ID,PackageID,パッケージID
```

任意:

```text
TTS_AUTH_CODE
TTS_STATUS_ENDPOINT_PATH
```

### 注意

- `.env` は絶対にアップロードしないでください。
- 本番では最初に1件だけチェックして送信してください。
- `TTS_ACCESS_TOKEN` には期限があります。期限切れ時は `TTS_REFRESH_TOKEN` で更新する処理を追加する必要があります。

## 現在の送信設計

最初は `TIKTOK_SHOP_DRY_RUN=true` のまま使います。送信ボタンを押してもTikTok Shopには反映せず、送信予定の注文ID・追跡番号・PDF位置だけを確認します。

本番反映には次の確認が必要です。

- TikTok Shop Open APIアプリの `app_key`
- `app_secret`
- `access_token`
- `shop_cipher`
- 追跡番号反映に使う正式エンドポイント
- CSVに `package_id` が含まれるか、注文IDからpackage_idを取得するAPIが必要か
