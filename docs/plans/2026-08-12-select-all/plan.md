# 結果一覧の全選択・全解除 実装計画

- 日付: 2026-08-12
- ブランチ: plan/2026-08-12-select-all
- ベースブランチ: main(SHA `3c3264aecad863623d6b75e29a2cfcd0ee9fe916`)
- 実装担当(駒): Claude sonnet(既存の`updateSummary()`まわりへの相乗りと純粋関数の追加が中心で、設計は計画で確定済みの標準的実装のため)
- クロスレビュー: Sol

## 背景・目的

結果一覧では各フレームに「採用」チェックボックスが付いており、しきい値による自動判定の結果を手で調整できる。しかし一括操作の手段が無く、まとめて外したり全部に付けたりするには1枚ずつクリックするしかない。フレーム数が多いと現実的でない。「全選択」「全解除」を追加する。

## 現状の裏取り

- `src/ui/resultsList.ts`の`createResultsList()`が結果一覧を組み立てている。ヘッダー(`.results-header`)は左に`.results-summary`(「n 件中 m 件を採用中」)、右に`.results-actions`(「ビューアで見る」「選択したフレームを ZIP でダウンロード」)という2ブロック構成になっている
- 各フレームのチェックボックスは`appendFrame()`内で生成され、変更時に`callbacks.onToggle(frame.index, checkbox.checked)`と`updateSummary()`を呼ぶ
- `updateSummary()`は全アイテムのチェック状態を数えてサマリ文言を更新している
- `applySelection(selected)`が外から選択状態を反映する口になっている
- `src/main.ts`は`selected: Set<number>`で採用中のフレームindexを保持し、`applyThreshold()`で`selected = computeSelection()`としたあと`resultsList.applySelection(selected)`と`syncViewerDisplay()`を呼んでいる

## スコープ

### やること

- `shouldEnableSelectAll` / `shouldEnableDeselectAll`という2つの純粋関数を追加し、単体テストを書く
- `src/ui/resultsList.ts`に「全選択」「全解除」ボタンと`onSelectAll`コールバックを追加する
- `src/main.ts`で`onSelectAll`を結線する
- `src/style.css`に新ボタンのスタイルを追加する
- `docs/usage.md`に一括操作できる旨を追記する

### やらないこと

- ボタンを3つ以上に分ける、あるいは「全選択」「全解除」以外の一括操作(範囲選択・反転選択など)を追加すること
- しきい値変更時に選択を保持する、または警告を出すといった仕様変更(既存挙動のまま据え置く)
- `.results-header`のレイアウト方式自体(`justify-content: space-between`による左右2ブロック構成)の変更

## 方針

### 1. ボタンの置き場所

`.results-actions`(右側)に足すとボタンが4つ並び、しかも「選択の操作」と「出力の操作」が混ざる。**サマリの直後(左側)に置く。**

```
[70 件中 27 件を採用中] [全選択][全解除] ......... [ビューアで見る][ZIP でダウンロード]
```

左が選択の状態と操作、右が出力の操作、という分かれ方にする。実測ではこの構成で合計約716pxとなりパネル内側の上限790pxに収まる。

サマリとボタンをまとめる要素を1つ作って`.results-header`の左ブロックとするのが素直だが、具体的なDOM構造は実装者裁量でよい。既存の`.results-header`が`justify-content: space-between`で左右に分ける前提になっている点に注意すること。

### 2. `src/ui/resultsList.ts`

- `ResultsListCallbacks`に`onSelectAll: (adopted: boolean) => void`を追加する。2つのコールバックに分けず、真偽値を取る1つにすること
- 「全選択」ボタンは`onSelectAll(true)`、「全解除」ボタンは`onSelectAll(false)`を呼ぶ
- ボタンは控えめな見た目にして、ZIPボタン(アクセント色)と競合させない
- `reset()`で両方とも無効にする
- `finalize()`で有効化の判断を行う
- 押しても何も起きない状態ではボタンを無効にすること。全件が選択済みなら「全選択」を無効、選択が0件なら「全解除」を無効にする。フレームが0件ならどちらも無効
- この有効/無効の更新は、既にチェック数を数えている`updateSummary()`に相乗りさせるのが自然(`applySelection()`も`appendFrame()`も`updateSummary()`を通るため、1箇所で済む)

### 3. 有効判定を純粋関数に切り出す

```ts
export function shouldEnableSelectAll(totalCount: number, selectedCount: number): boolean;
export function shouldEnableDeselectAll(selectedCount: number): boolean;
```

- `shouldEnableSelectAll`はフレームが1件以上あり、かつ全件が選択済みでないときにtrue
- `shouldEnableDeselectAll`は選択が1件以上あるときにtrue

切り出し先は実装者裁量でよいが、DOM非依存にしてNode環境のvitestから直接テストできるようにすること。既存の`src/ui/rescan.ts`(DOM非依存の純関数を`src/ui/`に置き、`rescan.test.ts`でテストしている)が前例になる。

単体テストを必ず追加すること。ケース例は、フレーム0件、全件選択済み、一部選択、選択0件、選択数が総数を超える異常値。

### 4. `src/main.ts`

`createResultsList`のコールバックに`onSelectAll`を追加する。

```ts
onSelectAll: (adopted) => {
  selected = adopted ? new Set(frames.map((f) => f.index)) : new Set();
  resultsList.applySelection(selected);
  syncViewerDisplay();
},
```

既存の`onToggle`が`syncViewerDisplay()`を呼んでいるのと同じ扱いにすること。

### 5. `src/style.css`

新しいボタンのスタイルを追加する。既存のボタン(`.results-view-button`、`.results-zip-button`)との関係を見て、選択操作のボタンは控えめな扱いにすること。狭い幅で折り返したときに崩れないことも確認すること(既存の`@media (max-width: 480px)`で`.results-header`と`.results-actions`が縦積みになる指定がある)。

### 6. ドキュメント

`docs/usage.md`の基本の流れ、または採用/除外の調整について書かれている箇所に、全選択と全解除で一括操作できる旨を追記すること。既存の文体に合わせる(日本語と英数字の間にスペースを入れない、emダッシュを使わない)。

## 注意点

**しきい値を動かすと選択が作り直される。** 全選択したあとにしきい値スライダーを触ると、その選択は`applyThreshold()`によって自動判定の結果で上書きされる。これは現在のチェックボックス手動操作と同じ挙動なので、仕様として揃える。新たに警告や確認ダイアログを出す必要はない。

**ビューアが開いている状態で全解除しても壊れないこと。** ビューアには「採用のみ表示」トグルがあり、ONの状態で全解除すると対象が0件になる。`syncViewerDisplay()`経由で表示が更新されるが、前後送りの対象決定(`findAdjacentFrame`)やカウンタ計算(`computeViewerCounter`)が0件を正しく扱えるかを動作確認すること。

## タスク分解

| # | タスク | 依存 |
|---|---|---|
| 1 | `shouldEnableSelectAll` / `shouldEnableDeselectAll`の実装と単体テスト | - |
| 2 | `src/ui/resultsList.ts`にボタンと`onSelectAll`コールバックを追加し、`updateSummary()`で有効/無効を更新 | 1 |
| 3 | `src/main.ts`で結線 | 2 |
| 4 | `src/style.css`の調整 | 2 |
| 5 | `docs/usage.md`の更新 | 3 |
| 6 | `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す | 3,4,5 |

## 完了条件・受け入れ基準

- [ ] 「全選択」を押すと全フレームが採用状態になり、サマリの件数が総数と一致する
- [ ] 「全解除」を押すと採用が0件になる
- [ ] 全件選択済みのとき「全選択」が無効になる
- [ ] 選択が0件のとき「全解除」が無効になる
- [ ] スキャン完了前(フレーム0件)は両方とも無効
- [ ] 個別のチェックボックスを操作したときも、両ボタンの有効/無効が追従する
- [ ] しきい値を変更したときも、両ボタンの有効/無効が追従する
- [ ] ビューアを開いた状態で全解除しても表示が壊れない(「採用のみ表示」がONの場合を含む)
- [ ] 全解除の状態でZIPダウンロードを押すと、既存の警告(ダウンロード対象のフレームが選択されていません)が出る
- [ ] `shouldEnableSelectAll` / `shouldEnableDeselectAll`の単体テストがある
- [ ] 通常幅でヘッダーが1行に収まり、狭い幅でも崩れない
- [ ] `docs/usage.md`が更新されている
- [ ] `npm test` / `npm run lint` / `npm run build` / `npm run format:check`がすべて通る
- [ ] 既存挙動(スキャン、しきい値の即時再計算、再スキャン、PNG個別ダウンロード、ZIPダウンロード、ビューア)が壊れていない
- [ ] 作業ブランチ`plan/2026-08-12-select-all`にcommit済み

## 未確定事項・リスクと判断の委ね方

| 項目 | 内容 | 実装時の扱い |
|---|---|---|
| ボタンのラベル | 「全選択」「全解除」を想定 | 実装者裁量。意味が伝わればよい |
| DOM構造 | サマリとボタンをまとめる要素の作り方 | 実装者裁量。`.results-header`が左右2ブロック前提である点だけ守る |
| 純粋関数の置き場所 | `src/ui/`配下か`src/core/`配下か | 実装者裁量。DOM非依存でテストできればよい |
| ボタンの見た目 | 控えめにする | 実装者裁量。ZIPボタンより目立たせない |
| しきい値変更で選択が消える | 既存挙動と同じ | 仕様として受け入れる。警告は出さない |
