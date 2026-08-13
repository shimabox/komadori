# 実装依頼: サンプリング間隔変更後の再スキャン

## 背景

komadoriはしきい値(変化率)を変更すると再デコードなしで採用フレームが即時に再計算されるが、サンプリング間隔(ミリ秒)を変更しても何も起きず、反映するにはファイルを選び直すしかない。この導線の欠落を埋め、サンプリング間隔を変更したあとファイルを選び直さずに再スキャンできるようにする。

## 現状の裏取り(着手前に把握しておくこと)

- `settingsPanel.getIntervalMs()`が読まれるのはsrc/main.tsの1箇所だけで、`handleFile()`の中でスキャンオプションを組み立てる瞬間のみ
- 設定パネルのコールバックは`onThresholdChange`しかなく、間隔変更を通知する口がない
- src/main.tsは`File`オブジェクトを保持していない(保持しているのは`currentFileBaseName`という文字列のみ)
- src/ui/dropzone.tsは`change`ハンドラで`input.value = ''`としてクリアしているため、input側にもファイルは残らない

したがって、再スキャンしようにも元のファイルへの参照がどこにもない状態である。

## なぜしきい値と同じ即時反映にできないのか

しきい値はスキャン中に保持した`gray64`(64x64のグレースケール)を再評価するだけで済むためデコードが不要。一方サンプリング間隔は「どの時刻のフレームを取るか」自体が変わるため、動画の再シークまたはGIFの再デコードが必須になる。構造上、即時反映にはできない。よって明示的な再スキャンの導線を用意する。

## 対象

- リポジトリ: `~/shimabox/github/komadori`
- 作業ブランチ: plan/2026-08-11-rescan-interval(mainから作成して作業する)
- ベースブランチ: main(SHA `b527f9b602ebc7ec7f55f6cb9801fcf8b63bc888`)

## 着手前に読むべきファイル

- src/main.tsの`handleFile()`と`applyThreshold()`、およびその周辺の状態変数
- src/ui/settingsPanel.ts全体
- src/ui/dropzone.ts
- src/ui/progressPanel.ts

## タスク(この順で)

1. `shouldEnableRescan`の実装と単体テスト
   - 再スキャン可否を判定する純関数を実装する

     ```ts
     export function shouldEnableRescan(
       hasFile: boolean,
       scannedIntervalMs: number | null,
       requestedIntervalMs: number,
     ): boolean
     ```

   - 判定ルール: ファイル未読み込み(`hasFile === false`)ならfalse。未スキャン(`scannedIntervalMs === null`)ならfalse。`requestedIntervalMs === scannedIntervalMs`ならfalse(変えていないので再スキャン不要)。それ以外はtrue
   - 置き場所は実装者裁量(src/ui/settingsPanel.tsかsrc/core/配下)だが、DOM非依存にしてNode環境のvitestから直接テストできるようにする。既存テストはすべて純粋ロジックのテストで、jsdomは入っていない
   - 単体テストを必ず追加する。ケース例はファイル未読み込み、未スキャン、値が同じ、値が異なる、小数や不正値が入った場合の扱い

2. src/ui/settingsPanel.tsにボタンとコールバックを追加
   - サンプリング間隔の行に「この間隔で再スキャン」ボタンを並べる。既存の`.settings-row`の構造に合わせる
   - `SettingsPanelCallbacks`に`onIntervalChange: () => void`を追加し、間隔入力の`input`イベントで発火させる
   - `SettingsPanelCallbacks`に`onRescan: () => void`を追加し、ボタンのクリックで発火させる
   - `SettingsPanelHandle`に`setRescanEnabled(enabled: boolean): void`を追加する
   - ボタンの初期状態は無効
   - 既存の`setDisabled(disabled)`はスキャン中に呼ばれる。スキャン中はこのボタンも必ず無効にする。ただし`setDisabled(false)`で復元するときに無条件で有効にしてはいけない(間隔を変えていないのに有効になってしまう)。有効/無効の最終的な判断はmain.tsが`setRescanEnabled()`で行う形にし、`setDisabled()`はスキャン中の一時的な無効化だけを担当するよう責務を分ける

3. src/main.tsに状態を追加し結線
   - 状態を追加する

     ```ts
     let currentFile: File | null = null; // 再スキャン用に保持する
     let scannedIntervalMs: number | null = null; // スキャン開始時に「指定した」間隔
     ```

   - `handleFile()`は既にセッション更新・`frameSource.dispose()`・objectURLキャッシュ解放・ビューアの強制クローズ・進捗パネルのリセットまで全部行っている。再スキャンの実体は`handleFile(currentFile)`を呼び直すだけでよく、新しいスキャン処理を書く必要はない
   - `currentFile`は、対応形式であることが確定してから(`detectFileKind()`が`unknown`でないことを確認してから)代入する。非対応形式で早期returnするパスで無効なファイルを再スキャン対象として抱えないため
   - `scannedIntervalMs`は、スキャンオプションを組み立てるときに`settingsPanel.getIntervalMs()`から取った値をそのまま記録する
   - `createSettingsPanel`のコールバックに`onIntervalChange`と`onRescan`を渡す
   - `onIntervalChange`では、`shouldEnableRescan()`の結果を`settingsPanel.setRescanEnabled()`へ反映する共通関数(例:`updateRescanState()`)を呼ぶ
   - `onRescan`では`currentFile`があれば`void handleFile(currentFile)`を呼ぶ
   - `handleFile()`のスキャン完了後(および早期returnのパス)でも`updateRescanState()`を呼び、ボタンの状態が実態と合うようにする

4. src/style.cssの調整
   - 再スキャンボタンのスタイルを追加する。既存の`.settings-row`内の要素や、他のボタン(`.results-zip-button`、`.progress-cancel`)の指定と整合させる。設定パネルの中で目立ちすぎない扱いにする

5. ドキュメント更新
   - docs/usage.mdの設定項目「サンプリング間隔(ミリ秒)」の説明に、変更しただけでは反映されず「この間隔で再スキャン」を押す必要があること、および再スキャンすると手動で調整した採用/除外はリセットされることを追記する
   - docs/architecture.mdの「しきい値の即時再計算」の近くに、しきい値は保持済みのグレースケールデータの再評価だけで済むのに対し、サンプリング間隔は取得するフレームそのものが変わるため再スキャンが必要である、という趣旨の段落を追加する
   - このリポジトリは日本語のコメントで意図(特に非自明な状態管理・同期の理由)を丁寧に書く方針なので、コード・ドキュメントともにそれに倣う。既存の文体に合わせ、日本語と英数字の間にスペースを入れず、emダッシュを使わない

6. `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す

## 設計上の注意点

比較するのは「指定値」であって「実効値」ではない。長い動画では上限600サンプル(`MAX_SAMPLES`)の制約により、指定した間隔より広い間隔が自動的に使われる(この挙動は設定パネルのヒント文にも書かれている)。実効値と比較する実装にすると、スキャン直後で何も変えていないのにボタンが有効になってしまう。必ずスキャン時に`getIntervalMs()`から取った値を記録して比較すること。

再スキャンすると手動の採用/除外調整は失われる。サンプリング間隔が変わるとフレームのindexが振り直されるため、これは避けられない。仕様として受け入れ、docs/usage.mdに明記する。実装で警告ダイアログなどを出す必要はない。

再スキャン中もキャンセルできること。`handleFile()`は`AbortController`を作って`progressPanel.start()`を呼ぶので、既存のキャンセルボタンがそのまま効くはずである。実装後に必ず動作確認する。

## 完了条件

- [ ] サンプリング間隔を変更すると「この間隔で再スキャン」ボタンが有効になる
- [ ] ボタンを押すと、新しい間隔でスキャンし直され、結果一覧が作り直される
- [ ] スキャン直後(値を変えていない状態)ではボタンが無効
- [ ] 長い動画で実効間隔が自動的に広げられた場合でも、スキャン直後にボタンが有効にならない
- [ ] スキャン中はボタンが無効
- [ ] ファイル未読み込みの状態ではボタンが無効
- [ ] 再スキャン中にキャンセルボタンが効く
- [ ] 非対応形式のファイルを選んだあと、それが再スキャン対象にならない
- [ ] `shouldEnableRescan`の単体テストがある
- [ ] `npm test` / `npm run lint` / `npm run build` / `npm run format:check`がすべて通る
- [ ] docs/usage.mdとdocs/architecture.mdが更新されている
- [ ] 既存挙動(スキャン、しきい値の即時再計算、PNG個別ダウンロード、ZIPダウンロード、ビューア)が壊れていない
- [ ] 作業ブランチplan/2026-08-11-rescan-intervalにcommit済みであること

## 未確定事項と判断の委ね方

- 勝手に決めてよい範囲: 関数名・定数名・CSSクラス名・`shouldEnableRescan`の配置場所・テストケースの構成などの実装詳細。以下は実装者判断でよいが、どうしたかを報告すること
  - ボタンのラベル(「この間隔で再スキャン」を想定。何が起きるか一目で分かればよい)
  - ボタンの見た目(設定パネル内で目立ちすぎない扱い)
  - 間隔入力が不正値のときの扱い(既存の`getIntervalMs()`は不正値なら初期値を返すので、既存挙動に合わせる。`shouldEnableRescan`には`getIntervalMs()`の戻り値(正規化後)を渡す)
- 止まって報告すべき範囲: スコープ変更・既存挙動(スキャン/しきい値の即時再計算/ダウンロード/ビューア)の破壊・依存追加
- 今回のスコープ外(手を出さない): 再スキャン時のスクロール位置維持。結果一覧が作り直されるため位置がずれうるが、対応は別途

## 禁止事項

- pushしない(commitまで)
- docs/plans/配下のplan.md/request.mdはuntrackedのまま残し、commitに含めないこと
- スコープ外のファイルを触らない(リファクタの誘惑に乗らない)

## 報告フォーマット

- 変更ファイル一覧
- 実行したテスト・lint・build・formatとその結果
- `shouldEnableRescan`をどこに置いたか
- `setDisabled()`と`setRescanEnabled()`の責務をどう分けたか
- 判断に迷った点・未解決の懸念
