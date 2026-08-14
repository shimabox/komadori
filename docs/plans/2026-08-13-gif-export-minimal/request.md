# 実装依頼: GIFエクスポート(最小構成)

## 背景

komadoriは変化点フレームをPNG個別またはZIPで書き出せる。ここにアニメーションGIFの書き出しを足す。komadoriは動画から変化点だけを抜くので、同じ枚数でも情報密度が高く、長い画面録画を短いGIFにまとめて共有する用途に向く。

この機能は以前一度実装したが、設定パネルに「フレーム遅延」「最大幅」「色数」の3項目を足す形だったため「設定が薄まる」という理由も含めて不採用になった。今回は**設定をまったく持たない最小の形**で作り直す。これらをすべて固定値にし、設定パネルには一切手を入れない。

固定する既定値(采配役が実測して決定済み。変更しない)。

| 項目 | 値 |
|---|---|
| フレーム遅延 | 300ms |
| 最大幅 | 640px |
| 色数 | 256 |

根拠: 60秒の動画から抽出すると変化点フレームは40枚前後になる。幅640pxなら40枚で約1MBに収まる(320pxで0.34MB、480pxで0.63MB、960pxで2.03MBとの比較で選定)。遅延300msなら40枚で12秒の再生になり、まとめ用途の目安である5〜15秒に収まる(前回の既定500msは40枚で20秒になり長すぎた)。

## 最重要の制約

**`src/core/gifExport.ts`と`src/types/gifenc.d.ts`は、以前のブランチのコミット`1fd1a08`からそのまま取得すること。内容を変更しないこと。ゼロから書き直さないこと。**

取得コマンド。

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

`gifExport.test.ts`(19件)もそのまま持ってくること。`1fd1a08`が参照できない場合は実装を進めず止まって報告すること。

## 対象

- リポジトリ: `~/shimabox/github/komadori`
- 作業ブランチ: plan/2026-08-13-gif-export-minimal(mainから作成して作業する)
- ベースブランチ: main(SHA `586b100c5e6831ccb30c91bcc8865884d72669ac`)

## 着手前に読むべきファイル

- `src/main.ts`の`downloadZip()`と`createRenderQueue`まわり
- `src/ui/resultsList.ts`
- `src/style.css`の`.results-actions`まわり

このリポジトリは日本語のコメントで意図を丁寧に書く方針なので、それに倣うこと。

## タスク(この順で)

1. `npm i gifenc`を実行する(前回`package.json`から外れているため再インストールが必要)

2. コミット`1fd1a08`から`src/core/gifExport.ts` `src/core/gifExport.test.ts` `src/types/gifenc.d.ts`を取得する(前段の「最重要の制約」を参照。内容は変更しない)

3. `src/ui/resultsList.ts`にGIFダウンロードボタンを追加する
   - `.results-actions`に「GIFでダウンロード」ボタンを追加する。既存の`zipButton`と同じ作りにすること
   - `ResultsListCallbacks`に`onDownloadGif: () => void`を追加する
   - `ResultsListHandle`に`setGifButtonEnabled(enabled: boolean)` / `setGifButtonLabel(label: string)` / `resetGifButtonLabel()`を追加する
   - クラス名は`results-gif-button`、既定ラベルは定数として切り出す
   - ボタンの並びは`viewButton`、`zipButton`、`gifButton`の順にする
   - `reset()`で無効化しラベルを既定に戻す。`finalize()`で`items.size === 0`でないときに有効化する
   - ラベルは「GIFでダウンロード」とする。**隣のZIPボタンのラベル(「選択したフレームをZIPでダウンロード」)は変更しないこと**(過去に一度短縮したがPRごと不採用になっており、今回のスコープ外)

4. `src/main.ts`に`downloadGif()`を追加し結線する。固定値の定数(遅延300ms、最大幅640px、色数256)もここに置く(命名・置き場所は実装者裁量)
   - 既存の`downloadZip()`をそのままなぞった作りにし、以下を必ず踏襲すること
     - 開始時点の`currentSession`と`currentFileBaseName`をローカルに束縛する
     - `frameSource`がnullなら何もしない
     - `selected.size === 0`なら`notice.add('warning', ...)`して戻る
     - `buildDownloadPlan(selected)`で対象をタイムスタンプ昇順に並べる
     - `resultsList.setGifButtonEnabled(false)`してから開始する
     - 各フレームは`renderQueue.enqueue(source, frame, session)`で取得する(直列化キュー経由。動画のシーク混線を防ぐため必須)
     - ループの各所で`session !== currentSession`をチェックし、ずれていたら静かにreturnする
     - 進捗はGIFボタンのラベルで表示する。フレーム取得中は「生成中…(n/総数)」、最後に「GIFを書き出しています…」
     - 失敗時は`console.error(error)`のうえ`notice.add('error', 'GIFの生成に失敗しました。')`
     - `finally`では`session === currentSession`のときだけラベルを戻し再有効化する
     - 成功時は`triggerBlobDownload(gifBlob, \`${baseName}_frames.gif\`)`
   - `createResultsList`のコールバックに`onDownloadGif`を追加すること
   - **注意。** 前回の実装時点から`main.ts`はリファクタされている。直列化キューは`enqueueRenderFull()`という関数ではなく`createRenderQueue()`が返す`renderQueue.enqueue()`になっている。前回のコミットの`downloadGif()`をそのまま貼らず、現在の`main.ts`の書き方に合わせること

5. `src/style.css`に`.results-gif-button`のスタイルを追加する。既存の`.results-zip-button`と揃える。ヘッダーのボタンが3つになるので、狭い幅で崩れないことも確認すること

6. ドキュメントを更新する
   - `README.md`の「特徴」リストに、採用フレームをアニメーションGIFとして書き出せる旨を1行追加する
   - `docs/usage.md`にGIF出力の節を追加する。ボタンの場所、設定が無く固定値であること(遅延300ms、最大幅640px)、フレーム遅延は一定なのでもとの動画のテンポは再現されないことを書く
   - `docs/architecture.md`にGIF生成についての段落を追加する。採用フレームを1枚ずつ`FrameSource.renderFull`でフル解像度PNGとして取り直し、縮小と量子化をしながら逐次エンコーダへ渡すため、フル解像度画像をまとめてメモリに保持しないことを書く
   - 既存の文体に合わせること(日本語と英数字の間にスペースを入れない、emダッシュを使わない)

7. `vite.config.ts`は変更不要。gifencはESMなので通常のimportで解決され、ワーカーファイルの配置も発生しない。差分が無いことを確認すること

8. `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す

## 完了条件

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
- [ ] 作業ブランチplan/2026-08-13-gif-export-minimalにcommit済みであること

## 未確定事項と判断の委ね方

- 勝手に決めてよい範囲: 固定値の定数名と置き場所(`src/main.ts`に置く想定)、GIFボタンのラベル文言の細部(「GIFでダウンロード」を想定)。以下は実装者判断でよいが、どうしたかを報告すること
  - 固定値の定数名と置き場所
  - ヘッダーが3ボタンになったときのレイアウトの微調整
- 止まって報告すべき範囲: コミット`1fd1a08`が参照できない場合、スコープ変更、既存挙動の破壊、`gifExport.ts`/`gifenc.d.ts`の内容変更が必要だと判明した場合
- 今回のスコープ外(手を出さない): 設定パネルへの項目追加、ZIPボタンのラベル変更、gifencのWeb Worker化、`vite.config.ts`の変更

## 禁止事項

- pushしない(commitまで)
- `docs/plans/`配下のplan.md/request.mdはuntrackedのまま残し、commitに含めないこと
- スコープ外のファイルを触らない(リファクタの誘惑に乗らない)
- `src/core/gifExport.ts`と`src/types/gifenc.d.ts`の内容を変更しないこと(コミット`1fd1a08`のまま取得する)
- 設定パネル(`src/ui/settingsPanel.ts`)に項目を追加しないこと
- ZIPボタンのラベルを変更しないこと

## 報告フォーマット

- 変更ファイル一覧
- 実行したテスト・lint・build・formatとその結果
- `1fd1a08`から取得したファイルが変更されていないことの確認方法(例: `git show 1fd1a08:<path> | diff - <path>`の結果)
- 固定値をどこに置いたか
- ヘッダーのレイアウトがどうなったか(3ボタンでの崩れの有無)
- 判断に迷った点
