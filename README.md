```text
my-worker-backend/
├── wrangler.jsonc
├── package.json
└── src/
    ├── config/
    │   └── constants.js          # 定数定義 (CORS, キャッシュバージョン等)
    ├── utils/
    │   ├── dateHelper.js         # JST日時操作ヘルパー
    │   ├── responseHelper.js     # HTTPレスポンス整形ヘルパー
    │   └── cryptoHelper.js       # Google OAuth (JWT/RSA-256) 認証処理
    ├── services/
    │   ├── d1Service.js          # D1 データベース操作層
    │   ├── firebaseService.js    # Firestore API & FCM 通知処理
    │   └── cacheService.js       # CDN キャッシュ削除処理
    └── index.js                  # エントリーポイント (Fetch & Cron ハンドラー)
```
