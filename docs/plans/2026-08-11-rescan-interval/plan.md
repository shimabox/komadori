# サンプリング間隔変更後の再スキャン 実装計画

- 日付: 2026-08-11
- ブランチ: plan/2026-08-11-rescan-interval
- ベースブランチ: main(SHA `b527f9b602ebc7ec7f55f6cb9801fcf8b63bc888`)
- 実装担当(駒): Claude sonnet(状態追加+UI配線が中心で、設計は計画で確定済みの標準的実装のため)

## 背景・目的

komadoriは、しきい値(変化率)スライダーを動かすと再デコードなしで採用フレームが即時に再計算される。一方サンプリング間隔(ミリ秒)を変更しても何も起きず、反映するにはファイルをドラッグ&ドロップし直すか選び直すしかない。この導線の欠落を埋め、サンプリング間隔を変更したあとファイルを選び直さずに再スキャンできるようにする。

## 現状の裏取り

- `settingsPanel.getIntervalMs()`が読まれるのはsrc/main.tsの1箇所だけで、`handleFile()`の中でスキャンオプションを組み立てる瞬間のみ
- 設定パネルのコールバックは`onThresholdChange`しかなく、間隔変更を通知する口がない
- src/main.tsは`File`オブジェクトを保持していない(保持しているのは`currentFileBaseName`という文字列のみ)
- src/ui/dropzone.tsは`change`ハンドラで`input.value = ''`としてクリアしているため、input側にもファイルは残らない

したがって、再スキャンしようにも元のファイルへの参照がどこにもない状態である。

## なぜしきい値と同じ即時反映にできないのか

しきい値はスキャン中に保持した`gray64`(64x64のグレースケール)を再評価するだけで済むためデコードが不要。一方サンプリング間隔は「どの時刻のフレームを取るか」自体が変わるため、動画の再シークまたはGIFの再デコードが必須になる。構造上、即時反映にはできない。よって明示的な再スキャンの導線を用意する。

## スコープ

### やること

- src/main.tsに`currentFile`(再スキャン用に保持するFile)と`scannedIntervalMs`(スキャン開始時に指定した間隔)を追加し、`handleFile()`を再スキャンにも使い回す
- 再スキャン可否を判定する純関数`shouldEnableRescan`を切り出し、単体テストを追加する
- src/ui/settingsPanel.tsに「この間隔で再スキャン」ボタン、`onIntervalChange`/`onRescan`コールバック、`setRescanEnabled()`を追加する
- src/main.tsで上記を結線し、`updateRescanState()`でボタンの有効/無効を管理する
- src/style.cssに再スキャンボタンのスタイルを追加する
- docs/usage.mdとdocs/architecture.mdを更新する

### やらないこと

- 再スキャン時のスクロール位置維持(結果一覧が作り直されるため位置がずれうるが、今回はスコープ外)
- 再スキャンで手動の採用/除外調整が失われることへの警告ダイアログなどの実装(仕様として受け入れ、docs/usage.mdへの明記のみ行う)
- しきい値と同様の再デコード不要な即時反映(構造上不可能なため対象外)

## 方針

### 1. src/main.tsに状態を追加する

```ts
let currentFile: File | null = null; // 再スキャン用に保持する
let scannedIntervalMs: number | null = null; // スキャン開始時に「指定した」間隔
```

`handleFile()`は既にセッション更新・`frameSource.dispose()`・objectURLキャッシュ解放・ビューアの強制クローズ・進捗パネルのリセットまで全部行っている。したがって再スキャンの実体は`handleFile(currentFile)`を呼び直すだけでよく、新しいスキャン処理を書く必要はない。

`currentFile`と`scannedIntervalMs`を更新する位置に注意する。

- `currentFile`は、対応形式であることが確定してから(`detectFileKind()`が`unknown`でないことを確認してから)代入する。非対応形式で早期returnするパスで無効なファイルを再スキャン対象として抱えないため
- `scannedIntervalMs`は、スキャンオプションを組み立てるときに`settingsPanel.getIntervalMs()`から取った値をそのまま記録する

### 2. 再スキャン可否の判定を純粋関数に切り出す

```ts
export function shouldEnableRescan(
  hasFile: boolean,
  scannedIntervalMs: number | null,
  requestedIntervalMs: number,
): boolean
```

- ファイル未読み込み(`hasFile === false`)ならfalse
- 未スキャン(`scannedIntervalMs === null`)ならfalse
- `requestedIntervalMs === scannedIntervalMs`ならfalse(変えていないので再スキャン不要)
- それ以外はtrue

切り出し先は実装者の裁量でよいが、src/ui/settingsPanel.tsかsrc/core/配下のどちらかにして、Node環境のvitestから直接テストできるようにする(DOM非依存にする)。既存のテストはすべて純粋ロジックのテストで、jsdomは入っていない。この関数の単体テストを必ず追加する。ケース例はファイル未読み込み、未スキャン、値が同じ、値が異なる、小数や不正値が入った場合の扱い。

### 3. src/ui/settingsPanel.tsにボタンとコールバックを追加する

- サンプリング間隔の行に「この間隔で再スキャン」ボタンを並べる。既存の`.settings-row`の構造に合わせる
- `SettingsPanelCallbacks`に`onIntervalChange: () => void`を追加し、間隔入力の`input`イベントで発火させる
- `SettingsPanelCallbacks`に`onRescan: () => void`を追加し、ボタンのクリックで発火させる
- `SettingsPanelHandle`に`setRescanEnabled(enabled: boolean): void`を追加する
- ボタンの初期状態は無効
- 既存の`setDisabled(disabled)`はスキャン中に呼ばれる。スキャン中はこのボタンも必ず無効にする。ただし`setDisabled(false)`で復元するときに無条件で有効にしてはいけない(間隔を変えていないのに有効になってしまう)。有効/無効の最終的な判断はmain.tsが`setRescanEnabled()`で行う形にし、`setDisabled()`はスキャン中の一時的な無効化だけを担当するよう責務を分ける

### 4. src/main.tsで結線する

- `createSettingsPanel`のコールバックに`onIntervalChange`と`onRescan`を渡す
- `onIntervalChange`では、`shouldEnableRescan()`の結果を`settingsPanel.setRescanEnabled()`へ反映する共通関数(例:`updateRescanState()`)を呼ぶ
- `onRescan`では`currentFile`があれば`void handleFile(currentFile)`を呼ぶ
- `handleFile()`のスキャン完了後(および早期returnのパス)でも`updateRescanState()`を呼び、ボタンの状態が実態と合うようにする

### 5. src/style.css

再スキャンボタンのスタイルを追加する。既存の`.settings-row`内の要素や、他のボタン(`.results-zip-button`、`.progress-cancel`)の指定と整合させる。設定パネルの中で目立ちすぎない扱いにする。

### 6. ドキュメント

- docs/usage.mdの設定項目「サンプリング間隔(ミリ秒)」の説明に、変更しただけでは反映されず「この間隔で再スキャン」を押す必要があること、および再スキャンすると手動で調整した採用/除外はリセットされることを追記する
- docs/architecture.mdの「しきい値の即時再計算」の近くに、しきい値は保持済みのグレースケールデータの再評価だけで済むのに対し、サンプリング間隔は取得するフレームそのものが変わるため再スキャンが必要である、という趣旨の段落を追加する

既存の文体に合わせる(日本語と英数字の間にスペースを入れない、emダッシュを使わない)。

## タスク分解

| # | タスク | 依存 |
|---|---|---|
| 1 | `shouldEnableRescan`の実装と単体テスト | - |
| 2 | src/ui/settingsPanel.tsにボタン・`onIntervalChange`・`onRescan`・`setRescanEnabled`を追加 | - |
| 3 | src/main.tsに`currentFile`/`scannedIntervalMs`/`updateRescanState()`を追加し結線 | 1,2 |
| 4 | src/style.cssの調整 | 2 |
| 5 | docs/usage.mdとdocs/architecture.mdの更新 | 3 |
| 6 | npm test / npm run lint / npm run build / npm run format:checkをすべて通す | 3,4,5 |

## 完了条件・受け入れ基準

- [ ] サンプリング間隔を変更すると「この間隔で再スキャン」ボタンが有効になる
- [ ] ボタンを押すと、新しい間隔でスキャンし直され、結果一覧が作り直される
- [ ] スキャン直後(値を変えていない状態)ではボタンが無効
- [ ] 長い動画で実効間隔が自動的に広げられた場合でも、スキャン直後にボタンが有効にならない
- [ ] スキャン中はボタンが無効
- [ ] ファイル未読み込みの状態ではボタンが無効
- [ ] 再スキャン中にキャンセルボタンが効く
- [ ] 非対応形式のファイルを選んだあと、それが再スキャン対象にならない
- [ ] `shouldEnableRescan`の単体テストがある
- [ ] npm test / npm run lint / npm run build / npm run format:checkがすべて通る
- [ ] docs/usage.mdとdocs/architecture.mdが更新されている
- [ ] 既存挙動(スキャン、しきい値の即時再計算、PNG個別ダウンロード、ZIPダウンロード、ビューア)が壊れていない
- [ ] 作業ブランチplan/2026-08-11-rescan-intervalにcommit済み

## 未確定事項・リスクと判断の委ね方

| 項目 | 内容 | 実装時の扱い |
|---|---|---|
| `shouldEnableRescan`の置き場所 | settingsPanel.tsかcore/配下か | 実装者裁量。DOM非依存でNodeのvitestからテストできればよい |
| ボタンのラベル | 「この間隔で再スキャン」を想定 | 実装者裁量。何が起きるか一目で分かればよい |
| ボタンの見た目 | 設定パネル内で目立ちすぎない扱い | 実装者裁量 |
| 間隔入力が不正値のとき | 既存の`getIntervalMs()`は不正値なら初期値を返す | 既存挙動に合わせる。`shouldEnableRescan`には`getIntervalMs()`の戻り値(正規化後)を渡す |
| 再スキャン時のスクロール位置 | 結果一覧が作り直されるため位置がずれうる | 今回のスコープ外。気になれば別途 |

## 設計上の注意点

比較するのは「指定値」であって「実効値」ではない。長い動画では上限600サンプル(`MAX_SAMPLES`)の制約により、指定した間隔より広い間隔が自動的に使われる(この挙動は設定パネルのヒント文にも書かれている)。実効値と比較する実装にすると、スキャン直後で何も変えていないのにボタンが有効になってしまう。必ずスキャン時に`getIntervalMs()`から取った値を記録して比較すること。

再スキャンすると手動の採用/除外調整は失われる。サンプリング間隔が変わるとフレームのindexが振り直されるため、これは避けられない。仕様として受け入れ、docs/usage.mdに明記する。実装で警告ダイアログなどを出す必要はない。

再スキャン中もキャンセルできること。`handleFile()`は`AbortController`を作って`progressPanel.start()`を呼ぶので、既存のキャンセルボタンがそのまま効くはずである。実装後に必ず動作確認する。
