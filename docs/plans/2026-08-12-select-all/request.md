# 実装依頼: 結果一覧の全選択・全解除

## 背景

結果一覧では各フレームに「採用」チェックボックスが付いており、しきい値による自動判定の結果を手で調整できる。しかし一括操作の手段が無く、まとめて外したり全部に付けたりするには1枚ずつクリックするしかない。フレーム数が多いと現実的でない。「全選択」「全解除」を追加する。

## 現状の裏取り(着手前に把握しておくこと)

- `src/ui/resultsList.ts`の`createResultsList()`が結果一覧を組み立てている。ヘッダー(`.results-header`)は左に`.results-summary`(「n 件中 m 件を採用中」)、右に`.results-actions`(「ビューアで見る」「選択したフレームを ZIP でダウンロード」)という2ブロック構成になっている
- 各フレームのチェックボックスは`appendFrame()`内で生成され、変更時に`callbacks.onToggle(frame.index, checkbox.checked)`と`updateSummary()`を呼ぶ
- `updateSummary()`は全アイテムのチェック状態を数えてサマリ文言を更新している
- `applySelection(selected)`が外から選択状態を反映する口になっている
- `src/main.ts`は`selected: Set<number>`で採用中のフレームindexを保持し、`applyThreshold()`で`selected = computeSelection()`としたあと`resultsList.applySelection(selected)`と`syncViewerDisplay()`を呼んでいる

## 対象

- リポジトリ: `~/shimabox/github/komadori`
- 作業ブランチ: plan/2026-08-12-select-all(mainから作成して作業する)
- ベースブランチ: main(SHA `3c3264aecad863623d6b75e29a2cfcd0ee9fe916`)

## 着手前に読むべきファイル

- `src/ui/resultsList.ts`全体
- `src/main.ts`の`selected`まわりと`applyThreshold()`と`syncViewerDisplay()`と`createResultsList`の呼び出し
- `src/ui/rescan.ts`(DOM非依存の純粋関数を`src/ui/`に置く前例)
- `src/ui/viewerNav.ts`(0件の扱い。前後送りの対象決定`findAdjacentFrame`とカウンタ計算`computeViewerCounter`)
- `src/style.css`の`.results-header`と`.results-actions`まわり(`@media (max-width: 480px)`での縦積み指定を含む)

## タスク(この順で)

1. `shouldEnableSelectAll` / `shouldEnableDeselectAll`の実装と単体テスト
   - シグネチャ

     ```ts
     export function shouldEnableSelectAll(totalCount: number, selectedCount: number): boolean;
     export function shouldEnableDeselectAll(selectedCount: number): boolean;
     ```

   - `shouldEnableSelectAll`はフレームが1件以上あり、かつ全件が選択済みでないときにtrue
   - `shouldEnableDeselectAll`は選択が1件以上あるときにtrue
   - 置き場所は`src/ui/`配下か`src/core/`配下かを含めて実装者裁量でよいが、DOM非依存にしてNode環境のvitestから直接テストできるようにすること。既存の`src/ui/rescan.ts`と`rescan.test.ts`が前例
   - 単体テストを必ず追加する。ケース例はフレーム0件、全件選択済み、一部選択、選択0件、選択数が総数を超える異常値

2. `src/ui/resultsList.ts`にボタンと`onSelectAll`コールバックを追加
   - `ResultsListCallbacks`に`onSelectAll: (adopted: boolean) => void`を追加する。2つのコールバックに分けず、真偽値を取る1つにすること
   - 「全選択」ボタンは`onSelectAll(true)`、「全解除」ボタンは`onSelectAll(false)`を呼ぶ
   - ボタンの置き場所は`.results-actions`(右側、出力操作)ではなく**サマリの直後(左側)**にする。左が選択の状態と操作、右が出力の操作、という分かれ方にすること

     ```
     [70 件中 27 件を採用中] [全選択][全解除] ......... [ビューアで見る][ZIP でダウンロード]
     ```

   - サマリとボタンをまとめる要素を1つ作って`.results-header`の左ブロックとするのが素直だが、具体的なDOM構造は実装者裁量でよい。既存の`.results-header`が`justify-content: space-between`で左右に分ける前提になっている点だけ守ること
   - ボタンは控えめな見た目にして、ZIPボタン(アクセント色)と競合させないこと
   - `reset()`で両方とも無効にする
   - `finalize()`で有効化の判断を行う
   - 押しても何も起きない状態ではボタンを無効にすること。全件が選択済みなら「全選択」を無効、選択が0件なら「全解除」を無効にする。フレームが0件ならどちらも無効
   - この有効/無効の更新は、既にチェック数を数えている`updateSummary()`に相乗りさせるのが自然(`applySelection()`も`appendFrame()`も`updateSummary()`を通るため、1箇所で済む)

3. `src/main.ts`で結線
   - `createResultsList`のコールバックに`onSelectAll`を追加する

     ```ts
     onSelectAll: (adopted) => {
       selected = adopted ? new Set(frames.map((f) => f.index)) : new Set();
       resultsList.applySelection(selected);
       syncViewerDisplay();
     },
     ```

   - 既存の`onToggle`が`syncViewerDisplay()`を呼んでいるのと同じ扱いにすること

4. `src/style.css`の調整
   - 新しいボタンのスタイルを追加する。既存のボタン(`.results-view-button`、`.results-zip-button`)との関係を見て、選択操作のボタンは控えめな扱いにすること
   - 狭い幅で折り返したときに崩れないことを確認すること(既存の`@media (max-width: 480px)`で`.results-header`と`.results-actions`が縦積みになる指定がある)

5. `docs/usage.md`の更新
   - 基本の流れ、または採用/除外の調整について書かれている箇所に、全選択と全解除で一括操作できる旨を追記する
   - このリポジトリは日本語のコメントで意図を丁寧に書く方針なので、コード・ドキュメントともにそれに倣う。既存の文体に合わせ、日本語と英数字の間にスペースを入れず、emダッシュを使わない

6. `npm test` / `npm run lint` / `npm run build` / `npm run format:check`をすべて通す

## 注意点

**しきい値を動かすと選択が作り直される。** 全選択したあとにしきい値スライダーを触ると、その選択は`applyThreshold()`によって自動判定の結果で上書きされる。これは現在のチェックボックス手動操作と同じ挙動なので、仕様として揃える。新たに警告や確認ダイアログを出す必要はない。

**ビューアが開いている状態で全解除しても壊れないこと。** ビューアには「採用のみ表示」トグルがあり、ONの状態で全解除すると対象が0件になる。`syncViewerDisplay()`経由で表示が更新されるが、前後送りの対象決定(`findAdjacentFrame`)やカウンタ計算(`computeViewerCounter`)が0件を正しく扱えるかを動作確認すること。

## 完了条件

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
- [ ] 作業ブランチplan/2026-08-12-select-allにcommit済みであること

## 未確定事項と判断の委ね方

- 勝手に決めてよい範囲: ボタンのラベル文言(「全選択」「全解除」を想定。意味が伝わればよい)、サマリとボタンをまとめるDOM構造の詳細、純粋関数の置き場所(`src/ui/`か`src/core/`か)、ボタンの見た目の詳細(ZIPボタンより目立たせない範囲で)。以下は実装者判断でよいが、どうしたかを報告すること
  - `.results-header`左ブロックのDOM構造
  - 純粋関数の配置先
- 止まって報告すべき範囲: スコープ変更・既存挙動(しきい値の即時再計算、再スキャン、PNG個別ダウンロード、ZIPダウンロード、ビューア)の破壊・依存追加
- 今回のスコープ外(手を出さない): 「全選択」「全解除」以外の一括操作(範囲選択・反転選択など)の追加、しきい値変更時に選択を保持または警告するという仕様変更、`.results-header`のレイアウト方式(`justify-content: space-between`による左右2ブロック構成)自体の変更

## 禁止事項

- pushしない(commitまで)
- `docs/plans/`配下のplan.md/request.mdはuntrackedのまま残し、commitに含めないこと
- スコープ外のファイルを触らない(リファクタの誘惑に乗らない)

## 報告フォーマット

- 変更ファイル一覧
- 実行したテスト・lint・build・formatとその結果
- 純粋関数をどこに置いたか
- ヘッダーのDOM構造をどうしたか
- 判断に迷った点
