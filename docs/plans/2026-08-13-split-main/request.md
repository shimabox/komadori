# 実装依頼: main.ts分割

## 背景

`src/main.ts`が771行あり、状態変数が14個(うち可変が10個)、ビューアのキャッシュ管理・renderFullの直列化キュー・ダウンロード処理・スキャン制御が同居している。この領域には単体テストが1つも無い。今すぐ壊れるわけではないが、次に機能を足すときの摩擦になる。関心事ごとに3モジュールへ切り出し、約470行まで減らす。

**最優先の制約: 振る舞いを一切変えないこと。** これはリファクタリングであり、機能追加でも不具合修正でもない。この領域には単体テストが無く、壊しても機械的には気付けない。迷ったら元のコードの形をできるだけ変えずに移すこと。

## 現状の裏取り(着手前に把握しておくこと)

采配役が確認した`src/main.ts`の内訳。

| 塊 | 行数の目安 | 中身 |
|---|---|---|
| 純粋ヘルパー | 約50行 | `detectFileKind` `stripExtension` `formatBytes` `formatFileTimestamp` `buildFrameFileName` `triggerBlobDownload` |
| 直列化キュー | 約20行 | `renderQueue`と`enqueueRenderFull` |
| ビューアのキャッシュ | 約150行 | `thumbUrlCache` `fullResCache` `fullResInFlight`と`addToFullResCache` `clearFullResCache` `clearThumbUrlCache` `getViewerThumbUrl` `ensureFullRes` |
| ビューア制御 | 約90行 | `buildViewerFrameData` `openViewerAt` `navigateViewer` `syncViewerDisplay` `closeViewerSilently` |
| `handleFile` | 144行 | 全体のオーケストレーション |
| ダウンロード | 約118行 | `buildDownloadPlan` `downloadOne` `downloadZip` |

問題は行数ではなく結合である。ほぼ全ての関数がモジュールレベルの可変状態(`frames` `selected` `currentSession` `frameSource`)を直接読んでいる。

このリポジトリは日本語のコメントで意図を丁寧に書く方針であり、特にセッションガードやobjectURLの解放まわりには非自明な理由が書かれている。**移動時にコメントを削らないこと。** 具体的には以下のような非自明な理由の説明が該当する。

- セッションガードの順序(なぜその順で`currentSession`をチェックするか)
- objectURLのrevokeタイミング
- 直列化キューがなぜ直列でなければならないか
- in-flightエントリを参照の同一性で削除する理由

## 対象

- リポジトリ: `~/shimabox/github/komadori`
- 作業ブランチ: plan/2026-08-13-split-main(mainから作成して作業する)
- ベースブランチ: main(SHA `adf0969061a7c0c488b39e68654fd4757c052a66`)

## 着手前に読むべきファイル

- `src/main.ts`全体
- `src/ui/viewer.ts`
- `src/ui/viewerNav.ts`
- `src/core/frameSource.ts`
- `src/core/types.ts`

## タスク(この順で。各段階でcommitを分けること)

1. `src/core/format.ts`の切り出しと単体テスト
   - `src/main.ts`から以下を移す。`detectFileKind(file: File): FileKind` `stripExtension(filename: string): string` `formatBytes(bytes: number): string` `formatFileTimestamp(ms: number): string` `buildFrameFileName(sequence: number, timestampMs: number): string`
   - `FileKind`型と、正規表現定数(`GIF_EXTENSION` `VIDEO_EXTENSION`)も一緒に移す
   - `triggerBlobDownload`はDOMに依存するので`format.ts`には入れない。`src/main.ts`に残すか、別の小さなモジュール(例`src/ui/blobDownload.ts`)に置くかは実装者裁量
   - 単体テストを必ず追加する(`src/core/format.test.ts`)。`File`はNode 20以降のグローバルに存在するので`detectFileKind`もテストできる(采配役が確認済み)。ケース例は以下
     - `detectFileKind`: MIMEタイプが`image/gif`、拡張子が`.gif`、MIMEタイプが`video/`始まり、拡張子が`.mp4`など、どちらにも当てはまらない場合、拡張子の大文字小文字
     - `stripExtension`: 拡張子あり、拡張子なし、先頭がドット(`.gitignore`のようなケース)
     - `formatBytes`: 小数第1位までの丸め
     - `formatFileTimestamp`: 0、負値、分をまたぐ値、ミリ秒3桁のゼロ埋め
     - `buildFrameFileName`: 4桁ゼロ埋め連番との組み合わせ

2. `src/core/renderQueue.ts`の切り出しと単体テスト
   - `renderQueue`変数と`enqueueRenderFull`関数を、ファクトリ関数として切り出す

     ```ts
     export function createRenderQueue(deps: { getSession: () => number }): {
       enqueue(source: FrameSource, frame: SampledFrame, session: number): Promise<Blob>;
     };
     ```

   - 現在の`enqueueRenderFull`は、キュー内の順番が回ってきて実際に実行する直前にも`session !== currentSession`を再確認し、ずれていたら`source.renderFull`を呼ばずに`AbortError`でrejectする。この挙動と、**直前の呼び出しが失敗してもキューを止めない**挙動を、移動後もそのまま維持すること。既存のコメント(旧sourceがdispose済みの可能性があるため呼び出さない、という理由)も移すこと
   - 単体テストを必ず追加する(`src/core/renderQueue.test.ts`)。偽の`FrameSource`(`renderFull`が解決を制御できるPromiseを返すもの)を渡せばDOM無しでテストできる。ケース例は以下
     - 複数の呼び出しが直列に実行される(2つ目のrenderFullが、1つ目が解決するまで呼ばれない)
     - 直前の呼び出しがrejectしても次の呼び出しが実行される
     - 積んだ時点とセッションがずれていたら`source.renderFull`が呼ばれずにrejectする
     - rejectされるエラーが`AbortError`である

3. `src/ui/viewerController.ts`の切り出し
   - ビューア関連の状態と制御を丸ごと移す。`createViewer`の生成もこのモジュールの中で行う
   - 移す状態: `viewerOpenFrameIndex` `viewerAdoptedOnly` `thumbUrlCache` `fullResCache` `fullResInFlight` `FULL_RES_CACHE_LIMIT`定数
   - 移す関数: `addToFullResCache` `clearFullResCache` `clearThumbUrlCache` `getViewerThumbUrl` `ensureFullRes` `buildViewerFrameData` `openViewerAt` `navigateViewer` `syncViewerDisplay` `closeViewerSilently`
   - 公開APIは以下の形にする

     ```ts
     export function createViewerController(deps: {
       getFrames: () => SampledFrame[];
       getSelected: () => ReadonlySet<number>;
       getSession: () => number;
       getFrameSource: () => FrameSource | null;
       enqueueRenderFull: (source: FrameSource, frame: SampledFrame, session: number) => Promise<Blob>;
       onToggleAdopt: (frameIndex: number, adopted: boolean) => void;
       onDownload: (frameIndex: number) => void;
     }): {
       element: HTMLElement;
       openAt(frameIndex: number, openerElement: HTMLElement): void;
       sync(): void;
       closeSilently(): void;
       clearCaches(): void;
     };
     ```

   - `viewerOpenFrameIndex`と`viewerAdoptedOnly`はコントローラ内部に隠れ、`src/main.ts`からは見えなくなること
   - `onToggleAdopt`と`onDownload`は`src/main.ts`が持つ処理(`selected`の更新と`resultsList.applySelection`、`downloadOne`)を呼ぶための口にすること
   - `clearCaches()`は現在の`clearFullResCache()`と`clearThumbUrlCache()`の両方を行うこと
   - `navigateViewer`はビューアの`onNavigate`から呼ばれる内部処理なので、公開APIには出さないこと
   - 引数名や細かい構造は実装者裁量でよいが、**`src/main.ts`側から`viewerOpenFrameIndex`や3つのキャッシュに直接触れない**形にすること
   - このモジュールはDOMとobjectURLに依存するため単体テストは書かない(既存の`src/ui/viewer.ts`にもテストは無い)。検証はブラウザで行う

4. `src/main.ts`の整理と結線
   - 上記3モジュールをimportして使う
   - `handleFile`とダウンロード関連(`buildDownloadPlan` `downloadOne` `downloadZip`)は`src/main.ts`に残す
   - `closeViewerSilently()`の呼び出しは`viewerController.closeSilently()`へ、`clearFullResCache()`と`clearThumbUrlCache()`の呼び出しは`viewerController.clearCaches()`へ置き換える
   - 目標は約470行だが、行数は結果であって目的ではない。無理に減らさないこと

5. `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す

## 注意点

**振る舞いを一切変えないこと。** 既存のコメントに書かれている非自明な理由(セッションガードの順序、objectURLのrevokeタイミング、キューの直列性、in-flightエントリを参照の同一性で削除する理由など)は、移動先でもすべて保持すること。コメントを削らないこと。

以下がすべて従来どおり動く必要がある。

- スキャン、進捗表示、キャンセル
- しきい値変更による即時再計算
- サンプリング間隔変更後の再スキャン
- 全選択・全解除
- ビューアを開く、前後送り、採用トグル、採用のみ表示、PNG保存、閉じたときのフォーカス復帰
- ビューアでサムネイル表示からフル解像度への差し替え
- フル解像度キャッシュの上限超過時に、表示中のフレームが追い出されない
- ファイル切替時にobjectURLがすべて解放される
- ダウンロード中にファイルを切り替えたときのセッションガード
- PNG個別ダウンロード、ZIPダウンロード

## 完了条件

- [ ] `src/core/format.ts`が作られ、単体テストがある
- [ ] `src/core/renderQueue.ts`が作られ、直列実行・失敗後の継続・セッションずれ時の非実行を検証する単体テストがある
- [ ] `src/ui/viewerController.ts`が作られ、`src/main.ts`から`viewerOpenFrameIndex`や3つのobjectURLキャッシュに直接触れていない
- [ ] `src/main.ts`の行数が減っている(目安として500行以下)
- [ ] 既存のコメント(非自明な理由を説明しているもの)が移動先で保持されている
- [ ] `npm test` / `npm run lint` / `npm run build` / `npm run format:check`がすべて通る
- [ ] 振る舞いが一切変わっていない(上記「注意点」の項目がすべて従来どおり動く)
- [ ] 作業ブランチplan/2026-08-13-split-mainにcommit済みであること(各段階でcommitを分けていること)

## 未確定事項と判断の委ね方

- 勝手に決めてよい範囲: `triggerBlobDownload`の置き場所(`src/main.ts`に残すか別モジュールにするか)、依存注入の形(オブジェクト1つで渡すか個別引数か)、引数名や細かい構造。以下は実装者判断でよいが、どうしたかを報告すること
  - `triggerBlobDownload`の置き場所
  - 依存注入の設計
- 止まって報告すべき範囲: スコープ変更・既存挙動の破壊・依存追加。振る舞いを変える必要があると判明した場合は、実装を進めず報告すること
- 今回のスコープ外(手を出さない): `handleFile`とダウンロード関連(`buildDownloadPlan` `downloadOne` `downloadZip`)の切り出し、機能追加・不具合修正・UI変更、コメントの削除・要約、行数を減らすこと自体を目的化した無理な圧縮

## 禁止事項

- pushしない(commitまで)
- `docs/plans/`配下のplan.md/request.mdはuntrackedのまま残し、commitに含めないこと
- スコープ外のファイルを触らない(リファクタの誘惑に乗らない)
- 振る舞いを変えないこと(機能追加・不具合修正・UI変更をしない)

## 報告フォーマット

- 変更ファイル一覧
- 実行したテスト・lint・build・formatとその結果
- `src/main.ts`の行数の変化
- `triggerBlobDownload`をどこに置いたか
- 依存注入をどう設計したか
- コメントを移す際に迷った点
- 判断に迷った点
