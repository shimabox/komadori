# GIFエクスポート(最小構成) 実装計画

- 日付: 2026-08-13
- ブランチ: plan/2026-08-13-gif-export-minimal
- ベースブランチ: main(SHA `586b100c5e6831ccb30c91bcc8865884d72669ac`)
- 実装担当(駒): Claude sonnet
- クロスレビュー: Sol

## 背景・目的

komadoriは変化点フレームをPNG個別またはZIPで書き出せる。ここにアニメーションGIFの書き出しを足す。

用途は「動画を短くまとめる」こと。普通の動画からGIFへの変換は等間隔でフレームを抜くため、動きのない区間も拾って冗長になる。komadoriは変化点を抜くので、同じ枚数でも情報密度が高い。長い画面録画を短いGIFにまとめて共有する、という出口ではkomadoriの検出エンジンが一番活きる。

## 前回との違い

この機能は以前一度実装したが、設定パネルに3項目(フレーム遅延・最大幅・色数)を足す形だったため「設定が薄まる」という理由も含めて不採用になった。今回は**設定をまったく持たない最小の形**で作り直す。これらをすべて固定値にし、設定パネルには一切手を入れない。

采配役が実測して既定値を決めた根拠は以下。

60秒の動画から変化点を抽出すると40枚前後になる。ディテールの多い素材で40枚のGIFを幅ごとに生成したサイズは以下だった。

| 幅 | サイズ | 1枚あたり |
|---|---|---|
| 320px | 0.34MB | 約9KB |
| 480px | 0.63MB | 約16KB |
| 640px | 0.96MB | 約25KB |
| 960px | 2.03MB | 約52KB |

幅640pxなら40枚で約1MBに収まり、貼るのに困らない。前回「サイズが膨らむから設定で調整できるようにする」としたが、その前提が実測で崩れた。

遅延については、再生時間が以下になる。

| 遅延 | 20枚 | 40枚 | 80枚 |
|---|---|---|---|
| 200ms | 4.0秒 | 8.0秒 | 16.0秒 |
| 300ms | 6.0秒 | 12.0秒 | 24.0秒 |
| 500ms | 10.0秒 | 20.0秒 | 40.0秒 |

まとめる用途では再生時間を5〜15秒に収めたい。GIFはループするため長いと何周目か分からなくなる。40枚前後という実測を踏まえ300msとする。前回の既定500msは40枚で20秒になり長すぎた。

固定する既定値は以下。定数として`src/main.ts`に置く(命名は実装者裁量)。UIからは変更できない。

| 項目 | 値 |
|---|---|
| フレーム遅延 | 300ms |
| 最大幅 | 640px |
| 色数 | 256 |

## スコープ

### やること

- `npm i gifenc`(前回`package.json`から外れているため再インストール)
- `src/core/gifExport.ts` `src/core/gifExport.test.ts` `src/types/gifenc.d.ts`を、以前のブランチのコミット`1fd1a08`からそのまま取得
- `src/ui/resultsList.ts`にGIFダウンロードボタンを追加
- `src/main.ts`に`downloadGif()`を追加し結線(固定値の定数もここに置く)
- `src/style.css`にGIFボタンのスタイルを追加
- `README.md` / `docs/usage.md` / `docs/architecture.md`の更新

### やらないこと

- 設定パネル(`src/ui/settingsPanel.ts`)への項目追加。今回は差分を出さない
- ZIPボタンのラベル変更(過去に一度短縮したがPRごと不採用になっており、今回のスコープ外)
- gifencのWeb Worker化(メインスレッド実行のまま。体感が悪ければ後追い)
- `vite.config.ts`の変更(gifencはESMなので通常のimportで解決される。確認のみ行う)

## 方針

### 1. gifencの導入

`npm i gifenc`を実行する。

### 2. `src/core/gifExport.ts`と`src/types/gifenc.d.ts`(最重要)

**この2ファイルは、以前のブランチのコミット`1fd1a08`からそのまま取得すること。ゼロから書き直さないこと。**

取得方法の例。

```
git show 1fd1a08:src/core/gifExport.ts > src/core/gifExport.ts
git show 1fd1a08:src/core/gifExport.test.ts > src/core/gifExport.test.ts
git show 1fd1a08:src/types/gifenc.d.ts > src/types/gifenc.d.ts
```

このコミットは既にクロスレビューを3回通っており、以下の非自明な修正が入っている。**書き直すとこれらを再発させる危険がある。**

- 透過の自動判定。透明画素を含むフレームだけ`rgba4444`と`oneBitAlpha`に切り替え、含まないフレームは`rgb565`のまま画質を落とさない
- 全フレームに`dispose: 2`を指定する。GIFの`dispose`は「そのフレームを表示した後」に効くため、透過フレーム自身にだけ付けると、不透明フレームの次に透過フレームが来たときに透明部分へ前フレームが残る
- Blobチャンク分割。`gif.stream.reset()`を使い、フレームごとに内部バッファを吐き出す。`gif.reset()`ではヘッダ書き込み済みフラグまで戻ってしまうため使えない。内部バッファのピークが93.8%減る
- `finish()`の冪等性。2回呼んでも同じBlobを返す。`finish()`後の`writeFrame()`は例外を投げる

`gifExport.test.ts`(19件)もそのまま持ってくる。

`createGifEncoder(opts: GifEncodeOptions)`は`maxWidth`と`maxColors`を受け取る形のままでよい。呼び出し側が固定値を渡す。**内容は変更しない。** そのままで今回の用途に足りる。

### 3. `src/ui/resultsList.ts`

`.results-actions`に「GIFでダウンロード」ボタンを追加する。

- `ResultsListCallbacks`に`onDownloadGif: () => void`を追加
- `ResultsListHandle`に`setGifButtonEnabled(enabled: boolean)` / `setGifButtonLabel(label: string)` / `resetGifButtonLabel()`を追加
- 既存の`zipButton`と同じ作りにする。クラス名は`results-gif-button`、既定ラベルは定数として切り出す
- ボタンの並びは`viewButton`、`zipButton`、`gifButton`の順
- `reset()`で無効化しラベルを既定に戻す。`finalize()`で`items.size === 0`でないときに有効化する

ラベルは「GIFでダウンロード」とする。隣のZIPボタンが「選択したフレームをZIPでダウンロード」と長いが、**ZIPボタンのラベルは変更しない。**

### 4. `src/main.ts`

既存の`downloadZip()`をそのままなぞった`downloadGif()`を追加する。以下を必ず踏襲する。

- 開始時点の`currentSession`と`currentFileBaseName`をローカルに束縛する
- `frameSource`がnullなら何もしない
- `selected.size === 0`なら`notice.add('warning', ...)`して戻る
- `buildDownloadPlan(selected)`で対象をタイムスタンプ昇順に並べる
- `resultsList.setGifButtonEnabled(false)`してから開始
- 各フレームは`renderQueue.enqueue(source, frame, session)`で取得する(直列化キュー経由。動画のシーク混線を防ぐため必須)
- ループの各所で`session !== currentSession`をチェックし、ずれていたら静かにreturnする
- 進捗はGIFボタンのラベルで表示する。フレーム取得中は「生成中…(n/総数)」、最後に「GIFを書き出しています…」
- 失敗時は`console.error(error)`のうえ`notice.add('error', 'GIFの生成に失敗しました。')`
- `finally`では`session === currentSession`のときだけラベルを戻し再有効化する
- 成功時は`triggerBlobDownload(gifBlob, \`${baseName}_frames.gif\`)`

`createResultsList`のコールバックに`onDownloadGif`を追加する。

**注意。** 前回の実装時点から`main.ts`はリファクタされている。直列化キューは`enqueueRenderFull()`という関数ではなく`createRenderQueue()`が返す`renderQueue.enqueue()`になっている。前回のコミットの`downloadGif()`をそのまま貼らず、現在の`main.ts`の書き方に合わせる。

### 5. `src/style.css`

`.results-gif-button`のスタイルを追加する。既存の`.results-zip-button`と揃える。ヘッダーのボタンが3つになるので、狭い幅で崩れないことも確認する。

### 6. ドキュメント

- `README.md`の「特徴」リストに、採用フレームをアニメーションGIFとして書き出せる旨を1行追加する
- `docs/usage.md`にGIF出力の節を追加する。ボタンの場所、設定が無く固定値であること(遅延300ms、最大幅640px)、フレーム遅延は一定なのでもとの動画のテンポは再現されないことを書く
- `docs/architecture.md`にGIF生成についての段落を追加する。採用フレームを1枚ずつ`FrameSource.renderFull`でフル解像度PNGとして取り直し、縮小と量子化をしながら逐次エンコーダへ渡すため、フル解像度画像をまとめてメモリに保持しないことを書く

既存の文体に合わせる(日本語と英数字の間にスペースを入れない、emダッシュを使わない)。

### 7. `vite.config.ts`

変更不要。gifencはESMなので通常のimportで解決され、ワーカーファイルの配置も発生しない。確認するタスクとして残す。

## タスク分解

| # | タスク | 依存 |
|---|---|---|
| 1 | `npm i gifenc` | - |
| 2 | コミット`1fd1a08`から`src/core/gifExport.ts` `src/core/gifExport.test.ts` `src/types/gifenc.d.ts`を取得 | - |
| 3 | `src/ui/resultsList.ts`にGIFボタンを追加 | - |
| 4 | `src/main.ts`に`downloadGif()`を追加し結線(固定値の定数もここに置く) | 2,3 |
| 5 | `src/style.css`を調整 | 3 |
| 6 | `README.md` / `docs/usage.md` / `docs/architecture.md`を更新 | 4 |
| 7 | `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す | 1〜6 |

## 完了条件・受け入れ基準

- [ ] 動画またはGIFを読み込み、採用フレームからアニメーションGIFを生成してダウンロードできる
- [ ] 設定パネルに項目が増えていない(`src/ui/settingsPanel.ts`に差分が無い)
- [ ] 生成されるGIFの遅延が300ms、最大幅が640pxになっている
- [ ] 生成中はGIFボタンが無効化され、「生成中…(n/総数)」形式で進捗が表示され、完了時と失敗時ともにラベルが戻る
- [ ] 生成中に別ファイルへ切り替えても、旧セッションのGIFがダウンロードされず新しい画面にエラーも出ない
- [ ] 透過GIFを入力にしたとき、出力GIFでも透過が保たれる
- [ ] 不透明フレームと透過フレームが交互に並ぶGIFで、透明部分に前フレームが残らない
- [ ] `src/core/gifExport.ts`と`src/types/gifenc.d.ts`がコミット`1fd1a08`の内容と一致している
- [ ] `gifExport.test.ts`の19件を含め、npm test / npm run lint / npm run build / npm run format:checkがすべて通る
- [ ] `vite.config.ts`に変更がない
- [ ] `README.md` / `docs/usage.md` / `docs/architecture.md`が更新されている
- [ ] 既存挙動(スキャン、しきい値の即時再計算、再スキャン、全選択・全解除、PNG個別ダウンロード、ZIPダウンロード、ビューア)が壊れていない
- [ ] 作業ブランチ`plan/2026-08-13-gif-export-minimal`にcommit済み

## 未確定事項・リスクと判断の委ね方

| 項目 | 内容 | 実装時の扱い |
|---|---|---|
| 固定値の定数名と置き場所 | `src/main.ts`に置く想定 | 実装者裁量 |
| GIFボタンのラベル | 「GIFでダウンロード」を想定 | 実装者裁量。ZIPボタンのラベルは変更しないこと |
| ヘッダーが3ボタンで折り返す可能性 | 現状は左右2ブロックで既に上下2段になっている | 端が揃っていれば許容。崩れる場合は報告すること |
| gifencのエンコードがメインスレッド実行 | フレーム数が多いと一瞬固まる | 今回のスコープ外。体感が悪ければ後追いでWeb Worker化 |
| 前回コミットからの取得 | `1fd1a08`が参照できない場合 | 取得できなければ実装を止めて報告すること |
