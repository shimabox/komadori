# 実装依頼: GIFサンプリングの時間ベース化

## 背景

komadoriの設定「サンプリング間隔(ミリ秒)」は動画にしか効いていない。`GifSource.scan()`は`intervalMs`を一切参照せず、`pickEvenIndices(rawFrames.length, maxSamples)`でフレームのindexを均等に間引くだけで、時間軸を見ていない。直近の作業(PR #7)ではこの既存挙動に合わせて「GIFではこの設定は使われません」とUIとドキュメントで明示する対応を入れたが、今回はその根本を直し、GIFも時間ベースでサンプリングするようにして動画と挙動を揃える。あわせてPR #7で入れたGIF例外を削除する。

## 裏取り済みの事実(着手前に把握しておくこと)

- `src/core/gifSource.ts`の`scan()`は`opts.intervalMs`を参照していない
- `src/core/videoSource.ts`は実効間隔を`const effectiveIntervalMs = Math.max(opts.intervalMs, Math.ceil(durationMs / maxSamples));`として決め、`for (let t = 0; t <= durationMs && sampled < maxSamples; t += effectiveIntervalMs)`で時間グリッド上をサンプリングしている
- gifuct-jsは`decompressFrame`の中で`resultImage.delay = (frame.gce.delay || 10) * 10;`としてセンチ秒からミリ秒へ変換している。つまり**LZW展開前の生フレーム(`parseGIF`の結果)の時点で`gce.delay`が取れる**ので、デコード前に総再生時間を計算できる
- `GifSource.scan()`は現状も`elapsedMs`を累積しており、`const delay = typeof frame.delay === 'number' && frame.delay > 0 ? frame.delay : FALLBACK_DELAY_MS;`で加算している
- `pickEvenIndices`(`src/core/gifSource.ts`)は同ファイル内でしか使われていない

## 受け入れる挙動変更

既定のサンプリング間隔は200msなので、多くのGIFでは**サンプル数が今より減る**。これはユーザー了承済みの意図した変更である。

| GIFの例 | 変更前 | 変更後(既定200ms) |
|---|---|---|
| 1秒・30フレーム(33msディレイ) | 30件 | 約5件 |
| 20秒・200フレーム(100msディレイ) | 200件 | 約100件 |

細かく見たい場合は間隔を下限(20ms)まで下げれば、ほぼ全フレームが選ばれる状態に戻せる。この点をドキュメントに明記すること。

## 対象

- リポジトリ: `~/shimabox/github/komadori`
- 作業ブランチ: plan/2026-08-12-gif-time-sampling(mainから作成して作業する)
- ベースブランチ: main(SHA `e6ab424bd139689615fc0ba17530ce318ba2cb32`)

## 着手前に読むべきファイル

- `src/core/gifSource.ts`全体(特に`scan()`と`pickEvenIndices`と`applyFrameToCanvas`)
- `src/core/videoSource.ts`の実効間隔の決め方(`scan()`内、`effectiveIntervalMs`まわり)
- `src/main.ts`の`handleFile()`と`updateRescanState()`と`isIntervalApplicable()`
- `src/ui/settingsPanel.ts`
- `src/ui/rescan.ts`
- `node_modules/gifuct-js/lib/index.js`の`decompressFrame`

## タスク(この順で)

1. `pickIndicesByInterval`の実装と単体テスト
   - `src/core/gifSource.ts`に以下を追加してエクスポートする(既存の`planCompositeRange`と同じ場所でよい)

     ```ts
     export function pickIndicesByInterval(
       delaysMs: readonly number[],
       intervalMs: number,
       maxSamples: number,
     ): number[];
     ```

   - 仕様
     - `delaysMs[i]`はフレーム`i`の表示時間(ミリ秒)。総再生時間は`delaysMs`の総和
     - 実効間隔は動画と同じく`Math.max(intervalMs, Math.ceil(総再生時間 / maxSamples))`とする。ただし0除算や0以下にならないよう、最低でも1msは確保すること
     - フレーム`i`の表示開始時刻を`startMs[i]`(それ以前のディレイの累積)とし、**表示開始時刻が次のサンプリンググリッド点に達したフレームを採用する**
     - **同じフレームを二度採用しない。** 動画は同一フレームの表示区間に複数回シークしうるが、GIFで同じフレームを重複して出すのは無駄なので、1フレームにつき最大1回とする
     - **先頭フレーム(index 0)は常に採用する**
     - 採用数は`maxSamples`を超えない
     - `delaysMs`が空なら空配列を返す
     - 戻り値は昇順のindex配列
   - 実装の考え方の一例(この通りでなくてよい): `nextSampleAtMs`を0から始め、各フレームの`startMs`が`nextSampleAtMs`以上ならそのフレームを採用し、`nextSampleAtMs`を「採用したフレームの`startMs`を超える次のグリッド点」まで進める
   - 単体テストを必ず追加する。ケース例は間隔がディレイより細かい場合に全フレーム、間隔がディレイの倍数のとき等間隔、ディレイ不均一、上限超過で実効間隔が広がる、フレーム1枚、空配列

2. `GifSource.scan()`の差し替え
   - `parseGIF`後の生フレーム配列から、各フレームのディレイをミリ秒で先に組み立てる。gifuctと同じ式にすること(展開後の`frame.delay`と食い違うと、採用したindexとタイムスタンプがずれるため)

     ```ts
     rawFrame.gce ? (rawFrame.gce.delay || 10) * 10 : FALLBACK_DELAY_MS
     ```

     `gce`が無い場合の扱いは既存の`FALLBACK_DELAY_MS`に合わせる。型が付かない場合は`src/core/gifSource.ts`の既存の型エイリアス(`RawImageFrame`など)にならって最小限の型を足してよい
   - `const outputIndices = pickEvenIndices(rawFrames.length, maxSamples);`を`pickIndicesByInterval(delaysMs, opts.intervalMs, maxSamples)`へ差し替える
   - **スキャンループの構造は変えないこと。** 現状も`outputSet.has(i)`で採用判定しているので、集合の作り方だけを差し替える形にする
   - ループ内の`elapsedMs`加算も、先に作った`delaysMs`配列を使う形へ揃える(展開後の`frame.delay`と二重管理にしない)
   - `pickEvenIndices`は他から使われていないため削除する
   - 全フレームの展開・合成はdisposal処理のため従来どおり必要である(スキャン時間は変わらない)。この点をコメントに残す
   - 進捗の`estimatedTotal`は採用予定件数(`pickIndicesByInterval`の戻り値の長さ)にする

3. PR #7で入れたGIF例外の削除
   - `src/main.ts`の`isIntervalApplicable()`関数と、`updateRescanState()`からのその呼び出しを削除する
   - `src/main.ts`の`settingsPanel.setIntervalApplicable(...)`の呼び出しを削除する(2箇所。`handleFile()`のリセット時と種別確定後)
   - `src/ui/settingsPanel.ts`の`setIntervalApplicable()`、`SettingsPanelHandle`のその宣言、内部状態`intervalApplicable`、`refreshIntervalHint()`によるヒント文の出し分けを削除する(ヒント文は動画・GIF共通の1種類に戻す)
   - `src/ui/rescan.ts`の`shouldEnableRescan()`の4番目の引数`intervalApplicable`とそのガードを削除する
   - `src/ui/rescan.test.ts`の`intervalApplicable`関連のテストケース4件を削除し、既存ケースの第4引数を削る
   - 削除後、GIFでも再スキャンボタンが動画と同じように機能するようになることを確認する

4. ドキュメント更新
   - `docs/usage.md`の「サンプリング間隔」の節から「この設定が効くのは動画のみです」およびGIF専用の段落を削除し、動画・GIF共通の設定として書き直す。あわせて、GIFで細かく見たい場合は間隔を下限まで下げるとほぼ全フレームが選ばれる旨を書く
   - `docs/architecture.md`の「サンプリング間隔の変更には再スキャンが必要(動画のみ)」の見出しから「(動画のみ)」を外し、GIFが均等間引きであるという段落を、時間ベースになった実態に書き直す。GIFは全フレームを展開・合成した上で時間軸に沿って採用フレームを選ぶ、という趣旨にする
   - このリポジトリは日本語のコメントで意図(特に非自明な状態管理・同期の理由)を丁寧に書く方針なので、コード・ドキュメントともにそれに倣う。既存の文体に合わせ、日本語と英数字の間にスペースを入れず、emダッシュを使わない

5. `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す

## 完了条件

- [ ] GIFでサンプリング間隔を変えると採用されるフレーム数が変わる
- [ ] GIFで再スキャンボタンが有効になり、押すと結果が変わる
- [ ] ディレイが不均一なGIFで、index均等ではなく時間軸に沿ったサンプリングになる
- [ ] 先頭フレームは常に採用される
- [ ] 採用数が上限(600)を超えない
- [ ] `pickIndicesByInterval`の単体テストがある(間隔がディレイより細かい場合に全フレーム、間隔がディレイの倍数のとき等間隔、ディレイ不均一、上限超過で実効間隔が広がる、フレーム1枚、空配列)
- [ ] `isIntervalApplicable` / `setIntervalApplicable` / `shouldEnableRescan`の第4引数が残っていない
- [ ] 設定パネルのヒント文が動画・GIF共通の1種類になっている
- [ ] `docs/usage.md`と`docs/architecture.md`が実態と合っている
- [ ] 動画側の挙動が変わっていない(`videoSource.ts`は変更しない)
- [ ] `npm test` / `npm run lint` / `npm run build` / `npm run format:check`がすべて通る
- [ ] 既存挙動(しきい値の即時再計算、PNG個別ダウンロード、ZIPダウンロード、ビューア、逐次合成による再取得)が壊れていない
- [ ] 作業ブランチplan/2026-08-12-gif-time-samplingにcommit済みであること

## 未確定事項と判断の委ね方

- 勝手に決めてよい範囲: `pickIndicesByInterval`のグリッド点の進め方の詳細実装、変数名・関数内部の分割、テストケースの構成などの実装詳細。以下は実装者判断でよいが、どうしたかを報告すること
  - グリッド点の進め方(重複採用を避ける具体的な進め方。完了条件を満たせばよい)
  - ディレイ配列を組み立てる際の型の付け方(既存の型エイリアスにならう)
- 止まって報告すべき範囲: スコープ変更・既存挙動(動画側のスキャン/しきい値の即時再計算/ダウンロード/ビューア)の破壊・依存追加
- 今回のスコープ外(手を出さない): `src/core/videoSource.ts`の変更、サンプリング間隔の既定値(200ms)や上限サンプル数600(`MAX_SAMPLES`)自体の変更、GIFのdisposal処理・全フレーム展開の省略や高速化

## 禁止事項

- pushしない(commitまで)
- `docs/plans/`配下のplan.md/request.mdはuntrackedのまま残し、commitに含めないこと(既存の`2026-08-11-rescan-interval/`も含めてcommitしないこと)
- スコープ外のファイルを触らない(リファクタの誘惑に乗らない)

## 報告フォーマット

- 変更ファイル一覧
- 実行したテスト・lint・build・formatとその結果
- `pickIndicesByInterval`のグリッド進め方をどう実装したか
- 削除したGIF例外の一覧
- 判断に迷った点・未解決の懸念
