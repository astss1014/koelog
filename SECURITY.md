# セキュリティポリシー

## 脆弱性の報告

脆弱性を見つけた場合は、**公開 Issue には書かず**、GitHub の「Security」タブ →「Report a vulnerability」から非公開で報告してください。影響を受ける機能、再現手順、想定される影響を書いてもらえると助かります。

## アプリの安全対策

| 対策 | 内容 |
| --- | --- |
| 音声を外に送らない | 録音・文字起こし・保存はすべて端末のブラウザ内で行う。サーバーへ音声やテキストを送る処理はない |
| 通信先の制限（CSP） | 画面と文字起こし担当（Worker）の両方で、通信先をこのサイトと AI の配布元（huggingface.co / *.hf.co）だけに制限。外部サイトのプログラムは読み込めない |
| ライブラリの同梱 | 文字起こしライブラリ（Transformers.js 3.8.1 と ONNX Runtime Web）を `vendor/` に同梱し、CDN から実行時に読み込まない。npm 公開版と同一であることを SHA-256 で確認済み（下表） |
| AI の版の固定 | 使う AI は3種類だけに限定し、Hugging Face 上の版（コミット）を固定。配布元で中身が差し替わっても自動では使われない |
| 画面の書き換え対策 | 録音タイトルや文字起こし結果は `textContent` で表示し、HTML として解釈しない |
| その他のヘッダー | `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、クロスオリジン分離（COOP/COEP）を Service Worker で付与 |
| 保存データ | 録音と結果はそのブラウザの IndexedDB にだけ保存。ブラウザに消去しないよう依頼（`navigator.storage.persist()`） |

### 同梱ライブラリの SHA-256

| ファイル | SHA-256 |
| --- | --- |
| `vendor/transformers.min.js` | `aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa` |
| `vendor/ort-wasm-simd-threaded.jsep.mjs` | `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9` |
| `vendor/ort-wasm-simd-threaded.jsep.wasm` | `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39` |

### 利用者側でできること

- スマホの画面ロック（PIN・指紋など）を必ず設定する。録音はブラウザ内に暗号化せず保存されるため、端末を開ける人は録音も見られる。
- 共用の端末では使わない。不要になった録音はアプリ内で削除する。

## リポジトリの防御設定

| 仕組み | 内容 |
| --- | --- |
| `.github/workflows/security.yml` | プッシュ・PR・毎週の定期実行で、秘密情報の混入チェック（Gitleaks）とコード解析（CodeQL）を自動実行 |
| `.gitignore` | 秘密鍵・認証情報ファイルを誤ってコミットしないよう除外 |

### GitHub 側で有効にしておきたい設定

1. **Settings → Advanced Security**：Secret scanning、Push protection、Dependabot alerts、Private vulnerability reporting を有効化
2. **Settings → Rules → Rulesets**：`main` の強制プッシュ・削除を禁止
3. **Settings → Actions → General**：Workflow permissions を「Read repository contents permission」に
4. **アカウント**：二要素認証（2FA）を有効化
