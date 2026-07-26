# 実装依頼: フレームviewer(ライトボックス)

## 背景

bunkatsu(動画/GIFから変化点フレームのみを静止画抽出するブラウザ内完結Webアプリ)の抽出結果は小さなサムネイル一覧でしか確認できず、細部確認とフレーム選別がしづらい。クリックで拡大し前後送りできる viewer(ライトボックス)を追加し、拡大確認しながら採用/除外・PNG保存まで完結できるようにする。

## 対象

- リポジトリ: bunkatsu
- 作業ブランチ: plan/2026-07-25-frame-viewer(ここから作成して作業する)
- ベースブランチ: plan/2026-07-23-initial-app(main ではない。初期実装+タイル分割diff改善がこのブランチにあり未マージのため、必ずここから作業ブランチを切ること)

## タスク(この順で)

1. 前後送り対象決定の純関数+単体テスト
   - 「採用のみ」フィルタを考慮した次/前フレーム決定ロジックを、DOM に依存しない純関数として切り出す(例: findAdjacentFrame(frames, currentIndex, direction, adoptedSet, adoptedOnly) — 命名・配置は裁量。src/core または src/ui 配下の DOM 非依存モジュール)
   - Vitest で単体テストを書く。既存テストは DOM なしの node 環境で動いているため、DOM に依存させないこと
   - テストケース: 通常送り・端(先頭/末尾)・「採用のみ」フィルタ・採用0件・現在フレームがフィルタ対象外
2. src/ui/viewer.ts コンポーネント新規作成+ src/style.css へのスタイル追記
   - モーダルオーバーレイ。画像表示・前後送りボタン・「n / 総数」カウンタ・タイムスタンプ表示・閉じるボタン
   - resultsList と同様の「create 関数+ハンドル」パターン(createViewer(callbacks): ViewerHandle)で独立コンポーネント化する。フレーム配列・採用状態のオーナーは従来どおり main.ts であり、viewer は開閉時と変更通知時に渡されたデータを表示するだけにする
   - キーボード操作: ← → で前後送り、Esc で閉じる。背景(オーバーレイ)クリックでも閉じる
   - 「採用のみ表示」トグル: ON にすると前後送りの対象が採用フレームのみになる(タスク1の純関数を使用)
   - viewer 内操作: 現在フレームの採用チェック切替+ PNG 保存ボタン(既存 downloadOne を再利用)
   - アクセシビリティは最小限: role="dialog" + aria-modal="true"、開いたら閉じるボタンへフォーカス移動、閉じたら開く前のフォーカス位置(クリックしたサムネイル等)へ戻す
   - ズーム・パン、スライドショー自動再生、隣接フレームのフル解像度先読みはスコープ外(画面にフィットする等倍表示のみ)
3. src/ui/resultsList.ts: 開く導線の追加
   - サムネイルクリック(そのフレームから viewer を開く)+ 結果一覧ヘッダの「ビューアで見る」ボタン(先頭フレームから開く)
   - いずれもスキャン完了後(finalize 後)に有効化する。スキャン進行中の viewer 起動はスコープ外
4. src/main.ts: 配線
   - 開閉の配線と双方向同期: viewer 内の採用切替 → コールバックで main.ts の selected を更新し resultsList.applySelection を呼ぶ。逆に(viewer 表示中に)しきい値変更が起きたら main.ts から viewer へ通知して表示中のチェック状態・「採用のみ」フィルタの対象を更新する
   - renderFull の直列化キュー: viewer のフル解像度生成と既存の PNG/ZIP ダウンロードが同じ renderFull(動画は共有 video 要素のシーク)を使うため、同時実行するとシークが混線する。main.ts に直列実行キューを設け、全ての renderFull 呼び出し(downloadOne / downloadZip / viewer)をそこ経由にする
   - サムネ→フル解像度差し替え: 表示直後はサムネイル拡大で即表示し、裏で FrameSource.renderFull を実行して完成したら差し替える。差し替えは「表示中フレームと生成完了フレームが一致する場合のみ差し替える」トークン方式にする(高速送り中の stale 表示を防ぐ)
   - フル解像度キャッシュ: frameIndex → objectURL の Map 管理で上限付き(名前付き定数、初期値 20)。上限超過時は古い順に objectURL を revoke して解放する
   - ファイル切替(handleFile)時は viewer を強制クローズしキャッシュを全 revoke する。main.ts の既存セッションガード(session !== currentSession で静かに return)パターンを踏襲する
5. README.md に viewer の使い方を追記

## 完了条件

- [ ] npm test / npm run lint / npm run build / npm run format:check がパスする
- [ ] 前後送り対象決定の純関数に単体テストがある(通常送り・端(先頭/末尾)・「採用のみ」フィルタ・採用0件・現在フレームがフィルタ対象外、のケースをカバー)
- [ ] サムネイルクリックでそのフレームの viewer が開き、「ビューアで見る」ボタンで先頭から開く
- [ ] ← → キー/ボタンで前後送り、Esc・背景クリック・閉じるボタンで閉じられる
- [ ] 「採用のみ表示」トグルで送り対象が絞られる
- [ ] viewer 内の採用切替が一覧に即時反映され、しきい値変更も viewer に反映される
- [ ] 全 renderFull 呼び出しが直列化キューを経由している
- [ ] README に viewer の使い方が追記されている
- [ ] 作業ブランチ plan/2026-07-25-frame-viewer に commit 済みであること

## 未確定事項と判断の委ね方

- 勝手に決めてよい範囲: 関数名・定数名・CSSクラス名・純関数の配置場所・テストケースの構成などの実装詳細。以下は実装者判断でよいが、どうしたかを報告すること
  - 採用のみモードで現在フレームの採用を外した時の挙動(表示は維持して次の送りから対象外とするのが自然か。自然な方を選んでよい)
  - 採用0件で「採用のみ」ON にした時の挙動(トグル無効化 or 空状態メッセージ)
- 止まって報告すべき範囲: スコープ変更・既存挙動(スキャン/ダウンロード/しきい値再計算)の破壊・依存追加

## 禁止事項

- push しない(commit まで)
- スコープ外のファイルを触らない(リファクタの誘惑に乗らない)。具体的には src/core/videoSource.ts, src/core/gifSource.ts, src/core/diff.ts, src/core/extractor.ts, src/ui/settingsPanel.ts, src/ui/dropzone.ts, src/ui/progressPanel.ts, src/ui/notice.ts は変更禁止。ただし src/main.ts / src/ui/resultsList.ts / src/style.css / README.md はタスクに含まれるため変更可

## 報告フォーマット

- 変更ファイル一覧
- 実行したテスト・lint とその結果
- 未確定事項で選んだ挙動
- 判断に迷った点・未解決の懸念
