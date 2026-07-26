# 実装依頼: bunkatsu 初期実装

## 背景

動画や GIF から「変化点」フレームだけを検出し、静止画として抽出・ダウンロードできる Web アプリ「bunkatsu」を新規構築する。ファイルはサーバーに送らず、読み込みから抽出・ZIP 生成まですべてブラウザ内(クライアントサイド)で完結させる。

## 対象

- リポジトリ: `bunkatsu`(現状 README.md のみの新規リポジトリ)
- 作業ブランチ: `plan/2026-07-23-initial-app`(main から作成してここで作業する)
- ベースブランチ: `main`

## 設計仕様(確定済み。変更しないこと)

以下はすでに確定済みの設計。plan.md を読まなくてもこの依頼書だけで実装できるよう、必要な情報をここに転記している。疑問が生じても、この仕様の範囲内で解決策を選んで実装すること(この節の内容自体を変えたい場合は「未確定事項と判断の委ね方」の「止まって報告すべき範囲」に従うこと)。

### アーキテクチャ

完全クライアントサイドの静的 Web アプリ。Vite + TypeScript(Vanilla、UI フレームワークなし)+ Vitest。ランタイム依存は次の 2 つのみ。

- `gifuct-js` — GIF デコード
- `fflate` — ZIP 生成

(WebCodecs は Safari 対応と demux の複雑さから、ffmpeg.wasm は数十 MB のバイナリで過剰なため、サーバーサイド処理は運用コストとプライバシーの点で、それぞれ不採用と決定済み。再検討しないこと。)

### モジュール構成

```
src/
  main.ts              — エントリポイント。UI と core の配線
  ui/                  — DOM 構築・イベント(入力エリア、設定パネル、進捗、結果一覧)
  core/
    types.ts           — SampledFrame 等の型定義
    frameSource.ts     — フレーム供給の共通インターフェース
    videoSource.ts     — <video> + seek + canvas で動画からフレーム列を生成
    gifSource.ts       — gifuct-js で GIF をデコードしフレーム列を生成
    diff.ts            — 縮小グレースケール化とフレーム間差分率の計算(純関数)
    extractor.ts       — 差分系列としきい値から採用フレームを決定・再抽出(純ロジック)
    zip.ts             — 採用フレームの PNG 化と ZIP 生成(fflate)
```

### 共通の型・インターフェース(core/types.ts, core/frameSource.ts)

メモリ設計の核: スキャン時にフル解像度は保持しない。各サンプルフレームにつき (a) 64×64 グレースケール `Uint8Array`(差分計算用)と (b) 表示用サムネイル Blob(JPEG、幅 320〜400px 程度)のみ保持する。フル解像度 PNG はダウンロード時に必要なフレームだけ元ソースから再取得する。

```ts
// core/types.ts
export interface SampledFrame {
  index: number;        // サンプリング順の連番(0始まり)
  timestampMs: number;  // 元動画/GIF先頭からの経過時間(ミリ秒)
  gray64: Uint8Array;   // 64x64 グレースケール(差分計算用、長さ 4096)
  thumbnail: Blob;      // 表示用サムネイル(JPEG、幅 320〜400px程度。サイズ・形式は実装者判断で可)
  width: number;        // 元フレームの幅(px)
  height: number;       // 元フレームの高さ(px)
}

export interface ScanOptions {
  intervalMs: number;   // サンプリング間隔。既定 200
  maxSamples: number;   // サンプル数上限。既定 600
  signal?: AbortSignal; // 中断シグナル(キャンセルボタンから渡す)
  onProgress?: (sampled: number, estimatedTotal: number) => void; // 進捗コールバック
}
```

```ts
// core/frameSource.ts
export interface FrameSource {
  /** サンプリングしながらフレームを順に供給(進捗コールバック・中断シグナル付き) */
  scan(opts: ScanOptions): AsyncGenerator<SampledFrame>;
  /** 指定フレームのフル解像度 PNG を再取得(動画: 該当時刻へ再 seek / GIF: 再デコード・合成) */
  renderFull(frame: SampledFrame): Promise<Blob>;
  /** objectURL 等の後始末 */
  dispose(): void;
}
```

`ScanOptions` のフィールド名は上記を基本としつつ、命名などの軽微な調整は実装者判断で可(意味・挙動は変えないこと)。

### 変化点検出アルゴリズム(core/extractor.ts が担う。変更しないこと)

各フレームを 64×64 に縮小しグレースケール化 → 「直前の採用フレーム」との平均絶対差(0〜255)を 0〜100% に正規化した差分率を計算 → しきい値(既定 3%)以上なら採用。**先頭フレームは常に採用**。比較対象は「直前サンプル」ではなく「直前の採用フレーム」であること(ゆっくり進む累積変化も拾うため。これは確定済みのロジックであり変更しないこと)。しきい値変更時は保持済み gray64 列に対して逐次再評価するだけでよく、再デコードは不要。しきい値のスライダー範囲は 0.5〜30%、既定 3%。

## タスク(この順で)

1. **プロジェクト初期化**
   - Vite の `vanilla-ts` テンプレートでリポジトリ直下にプロジェクトを初期化する(Node v20.19.5 / npm を使用)。
   - Vitest、ESLint、Prettier を導入する。
   - `package.json` の `scripts` に以下を用意する。
     - `dev` : Vite の開発サーバー起動
     - `build` : 本番ビルド
     - `preview` : ビルド結果のプレビュー
     - `test` : Vitest でテストを一度実行して終了する形にする(watch モードにしない。例: `vitest run`)
     - `lint` : ESLint 実行
     - `format` : Prettier 実行
   - `.gitignore` を用意する(`node_modules`、`dist` など)。
   - ランタイム依存として `gifuct-js` と `fflate` を追加する。**この 2 つ以外のランタイム依存を追加したくなった場合は追加せず、いったん止まって報告すること。**

2. **core/types.ts + core/frameSource.ts**
   - 上記「共通の型・インターフェース」節の通りに `SampledFrame` / `ScanOptions` / `FrameSource` を実装する。

3. **core/diff.ts + ユニットテスト**
   - 縮小グレースケール化と、2 つの gray64 配列からの差分率計算を行う純関数を実装する。DOM/canvas に依存せず、Vitest で単体テストできること。想定シグネチャ:

     ```ts
     // core/diff.ts
     export interface ImageDataLike {
       data: Uint8ClampedArray; // RGBA
       width: number;
       height: number;
     }

     /** 任意サイズの ImageData 相当のデータを 64x64 グレースケールの Uint8Array(長さ4096)に変換する */
     export function toGray64(image: ImageDataLike): Uint8Array;

     /** 2つの 64x64 グレースケール配列(gray64)から差分率を 0〜100(%) で返す */
     export function diffPercent(a: Uint8Array, b: Uint8Array): number;
     ```

   - `toGray64` はブラウザの `ImageData` をそのまま渡せるよう構造的に互換な型で受け取る(テストでは canvas を使わずプレーンオブジェクトを渡せるようにする)。内部の縮小アルゴリズム(ニアレストネイバー/平均化等)と輝度変換式は実装者判断で可。
   - `diffPercent` は画素ごとの絶対差の平均(0〜255)を 0〜100 に正規化して返す。
   - Vitest でユニットテストを書く。最低限: 同一配列同士なら差分 0% になること、既知の入力に対する差分率の妥当性、`toGray64` の出力長が 4096 であること。

4. **core/extractor.ts + ユニットテスト**
   - 上記「変化点検出アルゴリズム」節の通りに実装する。想定シグネチャ:

     ```ts
     // core/extractor.ts
     /**
      * サンプル済みフレーム列としきい値(%)から、採用すべきフレームを判定する。
      * 先頭は常に採用。以降は「直前に採用したフレーム」との diffPercent が
      * thresholdPercent 以上のフレームを採用する。
      */
     export function extractChangedFrames(
       frames: SampledFrame[],
       thresholdPercent: number
     ): SampledFrame[];
     ```

   - Vitest でユニットテストを書く。最低限: 先頭フレームは常に採用される、しきい値未満の変化は不採用になる、比較対象が「直前サンプル」ではなく「直前に採用したフレーム」になっている(採用がスキップされた後も正しく比較基準が更新される)、しきい値を変えると採用結果が変わる。

5. **core/videoSource.ts**
   - `FrameSource` を実装する。
   - `scan(opts)`:
     - `<video muted playsinline preload="auto">` を生成し、対象ファイルの objectURL を読み込む。
     - `currentTime` を間隔刻みで進め、`seeked` イベント後に canvas へ `drawImage` してフレームを取得する。
     - 動画長(durationMs)に対して `opts.intervalMs` のままだとサンプル数が `opts.maxSamples` を超える場合は間隔を自動で広げる(例: `effectiveIntervalMs = Math.max(opts.intervalMs, Math.ceil(durationMs / opts.maxSamples))`)。
     - 各サンプルについて `diff.ts` の `toGray64` で `gray64` を生成し、別途サムネイル用 Blob(JPEG、幅 320〜400px 程度)を生成して `SampledFrame` として yield する。
     - `opts.signal` が abort されたら速やかにスキャンを打ち切る。`opts.onProgress` を適宜呼ぶ。
     - `requestVideoFrameCallback` は使わない(seek 方式で互換性を優先する)。ブラウザによる seek 精度のズレ(±1サンプル程度)は許容してよい。
   - `renderFull(frame)`: 該当タイムスタンプへ再 seek し、`seeked` 後に元解像度の canvas へ描画して PNG Blob(`canvas.toBlob('image/png')` 等)を返す。
   - `dispose()`: objectURL の revoke、video 要素の後始末を行う。

6. **core/gifSource.ts**
   - `FrameSource` を実装する。`gifuct-js` の `parseGIF()` で GIF を解析し、`decompressFrames(gif, true)`(第2引数 `true` で `patch` を生成)で全フレームを取得する。各フレームは `delay`(ミリ秒。gifuct-js は既にミリ秒単位で返す)、`disposalType`、`dims`(`{ top, left, width, height }`)、`patch`(`ctx.putImageData()` にそのまま渡せる Uint8ClampedArray)を持つ。
   - ディスポーザル処理: 内部でオフスクリーン canvas を1枚保持し、フレームを順に合成する。
     - `disposalType === 0 または 1`(不特定/破棄しない): 前フレームの描画結果をそのまま残し、次のフレームの `patch` を `dims.left, dims.top` へ重ね書きする。
     - `disposalType === 2`(背景色に復元): 描画後、次のフレームを描く前にそのフレームの矩形領域を透明にクリアする。
     - `disposalType === 3`(直前の状態に復元): そのフレームを描く直前の canvas 状態をスナップショットしておき、次のフレームを描く前にそのスナップショットへ戻す。
     - 各フレームを合成した時点の canvas 全体を、そのフレームの「表示される画像」として扱う。
   - `delay` を先頭から積算して各フレームの `timestampMs` を計算する。
   - GIF は間引きなしで全フレームを対象にする。ただしデコード後のフレーム数が `maxSamples`(既定 600)を超える場合は均等間引きして上限内に収める。
   - 各フレーム(合成済み画像)から `diff.ts` の `toGray64` で `gray64` を生成し、サムネイル Blob を生成して `SampledFrame` として yield する。
   - `renderFull(frame)`: 該当フレームまで(必要なら先頭または直近のスナップショットから)再合成し、その時点の合成画像を PNG Blob として返す。
   - `dispose()`: 保持しているデコード結果・canvas 等を解放する。
   - `gifuct-js` に公式の TypeScript 型定義は無いため、`declare module 'gifuct-js' { ... }` 形式の自前 `.d.ts`(例: `src/types/gifuct-js.d.ts`)を用意し、使用する API(`parseGIF`、`decompressFrames`、フレームの `delay`/`disposalType`/`dims`/`patch` 等)の最小限の型を定義する。

7. **ui/**
   - 入力エリア: ドラッグ&ドロップ + クリックでのファイル選択。
   - 設定パネル: しきい値スライダー(範囲 0.5〜30%、既定 3%)、サンプリング間隔の設定(既定 200ms、手動変更可)。
   - スキャン進捗バー + キャンセルボタン(`ScanOptions.signal` 用の `AbortController` を保持し、キャンセル時に `abort()` する)。
   - 結果一覧: サムネイルグリッド。各アイテムにタイムスタンプ表示、採用/除外の手動切り替えチェックボックス(初期状態は `extractChangedFrames` の判定結果)、個別ダウンロードボタン。
   - ZIP 一括ダウンロードボタン(チェックが入っている=採用中のフレームを対象)。
   - **重要な挙動**: しきい値スライダーを変更したら、手動での採用/除外操作はリセットし、新しいしきい値での自動判定結果(`extractChangedFrames` の再実行結果)に戻す。
   - 非対応形式・デコード失敗時はエラーメッセージを表示する。
   - ファイルサイズが 500MB を超える場合は警告を表示するが、処理は継続する。
   - UI はすべて日本語。配色・レイアウトの詳細は「入力/設定/進捗/結果一覧」の1画面構成の範囲内で実装者判断で可。

8. **main.ts 配線 + core/zip.ts**
   - main.ts:
     - ファイル選択/D&D → 拡張子/MIME から動画か GIF かを判定 → `VideoSource` か `GifSource` を生成 → `scan()` を `for await` で消費しつつ `SampledFrame` を配列に貯めながらサムネイルグリッドと進捗バーを更新する。
     - スキャン完了後(またはキャンセルされた時点までに集まった分で)、`extractChangedFrames(frames, threshold)` を実行し、チェックボックスの初期状態に反映する。
     - しきい値スライダー変更時は、既に集めた `frames` に対して `extractChangedFrames` を再実行するだけで、再スキャンは行わない。
     - 個別ダウンロードボタン: 対象フレームの `frameSource.renderFull(frame)` を呼び、返ってきた PNG Blob を下記のファイル名でダウンロードさせる(`<a href="objectURL" download="...">` 等)。
     - ZIP ダウンロードボタン: 採用中(チェック済み)の全フレームについて `renderFull` を呼び、`core/zip.ts` の関数で ZIP を生成し、`<元ファイル名(拡張子除く)>_frames.zip` としてダウンロードさせる。
   - ファイル名規則: `{4桁ゼロ埋め連番}_{mm}m{ss}s{ミリ秒3桁}.png`(例: `0001_00m03s200.png`)。連番は、その時点でダウンロード対象になっている採用フレーム群をタイムスタンプ昇順に並べた上で 1 始まりで振る(個別ダウンロード・ZIP ダウンロードで共通の採番方法にする。採番の細部は実装者判断で可)。
   - core/zip.ts: `fflate` の非同期(コールバック)API `zip(zippable, (err, data) => ...)` を Promise でラップして使う(`zippable` は `{ ファイル名: Uint8Array }` の形。フォルダ分けは不要)。各フレームの PNG Blob は `renderFull` の戻り値をそのまま使い、`await blob.arrayBuffer()` → `new Uint8Array(...)` で変換してから `zippable` に詰める。生成された `Uint8Array` から `Blob`(`type: 'application/zip'`)を作りダウンロードさせる。

9. **README + 最終整形**
   - `README.md` に使い方(ファイルの読み込み方、しきい値スライダーの使い方、個別/ZIP ダウンロードの方法)、開発コマンド(`dev`/`build`/`preview`/`test`/`lint`/`format`)、仕組みの短い説明(ブラウザ内で完結する変化点検出であること)を追記する(UI が日本語のため README も日本語で問題ない)。
   - `npm run lint` / `npm run build` / `npm test` が通ることを確認し、最終整形を行う。

## 完了条件

- [ ] `npm run dev` で起動し、mp4 動画を D&D すると変化点フレームの一覧が表示される
- [ ] GIF でも同様に動作する
- [ ] しきい値スライダーを動かすと再デコードなしで抽出結果が即時更新される
- [ ] 一覧から個別 PNG ダウンロードができ、選択フレームの ZIP 一括ダウンロードができる
- [ ] ダウンロードされる PNG は元動画のフル解像度である
- [ ] スキャン中に進捗が表示され、キャンセルできる
- [ ] `npm test`(diff / extractor のユニットテスト)がパスする
- [ ] `npm run lint` がパスする
- [ ] `npm run build` がパスする
- [ ] 作業ブランチに commit 済みであること

## 未確定事項と判断の委ね方

- 勝手に決めてよい範囲:
  - seek 精度のブラウザ差(`seeked` 後の描画が期待時刻とズレる。±1サンプル程度は許容)への対応
  - `gifuct-js` の型定義ファイルの構成・置き場所
  - サムネイルの形式・サイズ(JPEG/WebP、幅 320〜400px 程度の範囲内)
  - `toGray64` の内部アルゴリズム(縮小方式・輝度変換式)
  - UI の見た目(配色・レイアウト詳細。1画面構成である範囲内で)
  - `ScanOptions` 等のフィールド名や、ファイル名の連番付与の細部など、本書に書かれた意味・挙動を変えない範囲での軽微な命名・実装詳細
  - README の文言・構成の細部
  - 変数名・ファイル分割などの一般的な実装詳細

- 止まって報告すべき範囲:
  - ランタイム依存を `gifuct-js` / `fflate` 以外に追加したくなった場合
  - スコープ(やること/やらないこと)や完了条件に影響する変更が必要になった場合
  - 確定済み設計(モジュール構成、`FrameSource` インターフェース、変化点検出アルゴリズム=「直前の採用フレームとの比較」等)を変更したくなった場合
  - 既存の(README 以外の)挙動や上記完了条件と矛盾するような実装上の制約に突き当たった場合

## 禁止事項

- push しない(commit まで)
- スコープ外のファイルを触らない(リファクタの誘惑に乗らない)
- 確定済み設計(モジュール構成・`FrameSource` インターフェース・変化点検出アルゴリズム)を変更しない

## 報告フォーマット

- 変更ファイル一覧
- 実行したテスト・lint と結果
- 判断に迷った点・未解決の懸念
