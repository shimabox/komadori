# GIFサンプリングの時間ベース化 実装計画

- 日付: 2026-08-12
- ブランチ: plan/2026-08-12-gif-time-sampling
- ベースブランチ: main(SHA `e6ab424bd139689615fc0ba17530ce318ba2cb32`)
- 実装担当(駒): Claude sonnet(既存の`videoSource.ts`と同型の純粋関数追加+既存ループの差し替えが中心で、設計は計画で確定済みの標準的実装のため)
- クロスレビュー: Sol

## 背景・目的

komadoriの設定「サンプリング間隔(ミリ秒)」は動画にしか効いていない。`GifSource.scan()`は`intervalMs`を一切参照せず、`pickEvenIndices(rawFrames.length, maxSamples)`でフレームのindexを均等に間引くだけで、時間軸を見ていない。

直近の作業(PR #7)では、この既存挙動に合わせて「GIFではこの設定は使われません」とUIとドキュメントで明示する対応を入れた。今回はその根本を直し、GIFも時間ベースでサンプリングするようにして動画と挙動を揃える。あわせてPR #7で入れたGIF例外を削除する。

## 裏取り済みの事実

- `src/core/gifSource.ts`の`scan()`は`opts.intervalMs`を参照していない
- `src/core/videoSource.ts`は実効間隔を`const effectiveIntervalMs = Math.max(opts.intervalMs, Math.ceil(durationMs / maxSamples));`として決め、`for (let t = 0; t <= durationMs && sampled < maxSamples; t += effectiveIntervalMs)`で時間グリッド上をサンプリングしている
- gifuct-jsは`decompressFrame`の中で`resultImage.delay = (frame.gce.delay || 10) * 10;`としてセンチ秒からミリ秒へ変換している。つまり**LZW展開前の生フレーム(`parseGIF`の結果)の時点で`gce.delay`が取れる**ので、デコード前に総再生時間を計算できる
- `GifSource.scan()`は現状も`elapsedMs`を累積しており、`const delay = typeof frame.delay === 'number' && frame.delay > 0 ? frame.delay : FALLBACK_DELAY_MS;`で加算している

## 受け入れる挙動変更

既定のサンプリング間隔は200msなので、多くのGIFでは**サンプル数が今より減る**。これはユーザーが了承済みの意図した変更である。

| GIFの例 | 変更前 | 変更後(既定200ms) |
|---|---|---|
| 1秒・30フレーム(33msディレイ) | 30件 | 約5件 |
| 20秒・200フレーム(100msディレイ) | 200件 | 約100件 |

細かく見たい場合は間隔を下限(20ms)まで下げれば、ほぼ全フレームが選ばれる状態に戻せる。この点をドキュメントに明記する。

## スコープ

### やること

- `src/core/gifSource.ts`に時間ベースの選択を行う純粋関数`pickIndicesByInterval`を追加し、単体テストを書く
- `GifSource.scan()`を、生フレームのディレイ配列を先に組み立てたうえで`pickIndicesByInterval`を使う形に差し替える
- PR #7で入れたGIF例外(`isIntervalApplicable`/`setIntervalApplicable`/`shouldEnableRescan`第4引数など)を削除する
- `docs/usage.md`と`docs/architecture.md`を実態に合わせて書き直す

### やらないこと

- `src/core/videoSource.ts`の変更(動画側の挙動は今回のスコープ外で、一切触らない)
- サンプリング間隔の既定値(200ms)や上限サンプル数600(`MAX_SAMPLES`)自体の変更
- GIFのdisposal処理・全フレーム展開自体の省略や高速化(スキャン時間は今回変わらない前提)
- 再スキャン導線(`shouldEnableRescan`本体の3条件)の設計変更(第4引数を削るだけ)

## 方針

### 1. 時間ベースの選択を純粋関数として切り出す

`src/core/gifSource.ts`に以下を追加してエクスポートする(既存の`planCompositeRange`と同じ場所でよい)。

```ts
export function pickIndicesByInterval(
  delaysMs: readonly number[],
  intervalMs: number,
  maxSamples: number,
): number[];
```

仕様。

- `delaysMs[i]`はフレーム`i`の表示時間(ミリ秒)
- 総再生時間は`delaysMs`の総和
- 実効間隔は動画と同じく`Math.max(intervalMs, Math.ceil(総再生時間 / maxSamples))`とする。ただし0除算や0以下にならないよう、最低でも1msは確保すること
- フレーム`i`の表示開始時刻を`startMs[i]`(それ以前のディレイの累積)とし、**表示開始時刻が次のサンプリンググリッド点に達したフレームを採用する**
- **同じフレームを二度採用しない。** 動画は同一フレームの表示区間に複数回シークしうるが、GIFで同じフレームを重複して出すのは無駄なので、1フレームにつき最大1回とする
- **先頭フレーム(index 0)は常に採用する**
- 採用数は`maxSamples`を超えない
- `delaysMs`が空なら空配列を返す
- 戻り値は昇順のindex配列

実装の考え方の一例(この通りでなくてよい)。`nextSampleAtMs`を0から始め、各フレームの`startMs`が`nextSampleAtMs`以上ならそのフレームを採用し、`nextSampleAtMs`を「採用したフレームの`startMs`を超える次のグリッド点」まで進める。

### 2. `GifSource.scan()`を差し替える

- `parseGIF`後の生フレーム配列から、各フレームのディレイをミリ秒で先に組み立てる。gifuctと同じ式にすること(展開後の`frame.delay`と食い違うと、採用したindexとタイムスタンプがずれるため)

  ```ts
  rawFrame.gce ? (rawFrame.gce.delay || 10) * 10 : FALLBACK_DELAY_MS
  ```

  `gce`が無い場合の扱いは既存の`FALLBACK_DELAY_MS`に合わせる。型が付かない場合は`src/core/gifSource.ts`の既存の型エイリアス(`RawImageFrame`など)にならって最小限の型を足してよい
- `const outputIndices = pickEvenIndices(rawFrames.length, maxSamples);`を`pickIndicesByInterval(delaysMs, opts.intervalMs, maxSamples)`へ差し替える
- **スキャンループの構造は変えない。** 現状も`outputSet.has(i)`で採用判定しているので、集合の作り方だけを差し替える形にする
- ループ内の`elapsedMs`加算も、先に作った`delaysMs`配列を使う形へ揃える(展開後の`frame.delay`と二重管理にしない)
- `pickEvenIndices`が他から使われていなければ削除する(`src/core/gifSource.ts`内でしか使われていないことは確認済み)
- 全フレームの展開・合成はdisposal処理のため従来どおり必要である(スキャン時間は変わらない)。この点をコメントに残す
- 進捗の`estimatedTotal`は採用予定件数(`pickIndicesByInterval`の戻り値の長さ)にする

### 3. PR #7で入れたGIF例外を削除する

GIFでも間隔が効くようになるため、以下がすべて不要になる。**削除する。**

- `src/main.ts`の`isIntervalApplicable()`関数と、`updateRescanState()`からのその呼び出し
- `src/main.ts`の`settingsPanel.setIntervalApplicable(...)`の呼び出し(2箇所。`handleFile()`のリセット時と種別確定後)
- `src/ui/settingsPanel.ts`の`setIntervalApplicable()`、`SettingsPanelHandle`のその宣言、内部状態`intervalApplicable`、`refreshIntervalHint()`によるヒント文の出し分け(ヒント文は動画・GIF共通の1種類に戻す)
- `src/ui/rescan.ts`の`shouldEnableRescan()`の4番目の引数`intervalApplicable`とそのガード
- `src/ui/rescan.test.ts`の`intervalApplicable`関連のテストケース4件と、既存ケースの第4引数

削除後、GIFでも再スキャンボタンが動画と同じように機能するようになる。

### 4. ドキュメントを実態に合わせる

- `docs/usage.md`の「サンプリング間隔」の節から「この設定が効くのは動画のみです」およびGIF専用の段落を削除し、動画・GIF共通の設定として書き直す。あわせて、GIFで細かく見たい場合は間隔を下限まで下げるとほぼ全フレームが選ばれる旨を書く
- `docs/architecture.md`の「サンプリング間隔の変更には再スキャンが必要(動画のみ)」の見出しから「(動画のみ)」を外し、GIFが均等間引きであるという段落を、時間ベースになった実態に書き直す。GIFは全フレームを展開・合成した上で時間軸に沿って採用フレームを選ぶ、という趣旨にする

既存の文体に合わせる(日本語と英数字の間にスペースを入れない、emダッシュを使わない)。

## タスク分解

| # | タスク | 依存 |
|---|---|---|
| 1 | `pickIndicesByInterval`の実装と単体テスト | - |
| 2 | `GifSource.scan()`の差し替え(ディレイ配列の事前構築、`outputIndices`の生成元変更、`estimatedTotal`) | 1 |
| 3 | PR #7のGIF例外を削除(`main.ts` / `settingsPanel.ts` / `rescan.ts` / `rescan.test.ts`) | 2 |
| 4 | `docs/usage.md`と`docs/architecture.md`の更新 | 2,3 |
| 5 | `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す | 2,3,4 |

## 完了条件・受け入れ基準

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
- [ ] 作業ブランチ`plan/2026-08-12-gif-time-sampling`にcommit済み

## 未確定事項・リスクと判断の委ね方

| 項目 | 内容 | 実装時の扱い |
|---|---|---|
| 既存のGIFスキャン結果が変わる | 既定200msではサンプル数が減る | ユーザー了承済みの意図した変更。docsに明記する |
| ディレイ0のGIF | gifuctが`(gce.delay || 10) * 10`で100msに補正する | 同じ式を使うので既存挙動と揃う |
| `gce`が無いフレーム | gifuctは`delay`を設定しない | 既存の`FALLBACK_DELAY_MS`に合わせる |
| グリッド点の進め方 | 重複採用を避ける進め方の詳細 | 実装者裁量。完了条件を満たせばよい |
| `pickEvenIndices`の去就 | 他から使われていなければ不要になる | 使われていないことを確認済みなので削除する |
