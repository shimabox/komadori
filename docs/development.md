# 開発ガイド

Node.js v20.19.5以降を想定しています。[mise](https://mise.jdx.dev/)を使っている場合は、リポジトリ直下で以下を実行すると`mise.toml`に基づいて必要なNodeがインストールされます。

```bash
mise install
```

```bash
npm install
```

## npm scripts

| コマンド          | 内容                                           |
| ----------------- | ---------------------------------------------- |
| `npm run dev`     | 開発サーバーを起動します                       |
| `npm run build`   | 型チェックを行った上で本番用ビルドを生成します |
| `npm run preview` | `build`の成果物をローカルでプレビューします   |
| `npm test`        | Vitestでユニットテストを一度だけ実行します    |
| `npm run lint`    | ESLintでコードを検査します                    |
| `npm run format`  | Prettierでコードを整形します                  |

## 技術構成

- [Vite](https://vite.dev/) + TypeScript(フレームワークなしのVanilla構成)
- [Vitest](https://vitest.dev/)によるユニットテスト(`src/**/*.test.ts`)
- ランタイム依存は以下の3つのみです。
  - [`gifuct-js`](https://github.com/matt-way/gifuct-js) — GIFのデコード
  - [`fflate`](https://github.com/101arrowz/fflate) — ZIPファイルの生成
  - [`gifenc`](https://github.com/mattdesl/gifenc) — アニメーションGIFのエンコード(GIF書き出し)

## ディレクトリ構成

```
src/
  main.ts              # エントリポイント。UIとcoreの配線、ダウンロード処理
  ui/                  # DOM構築・イベント(入力エリア、設定パネル、進捗、結果一覧、ビューア)
    viewerNav.ts       # ビューアの前後送り対象決定(「採用のみ」フィルタ考慮、純関数)
    bulkSelection.ts   # 「全選択」「全解除」ボタンの有効/無効判定(純関数)
    rescan.ts          # 再スキャンボタンの有効/無効判定(純関数)
  core/
    types.ts           # SampledFrame等の型定義
    frameSource.ts     # フレーム供給の共通インターフェース
    videoSource.ts     # <video> + seek + canvasで動画からフレーム列を生成
    gifSource.ts       # gifuct-jsでGIFをデコードしフレーム列を生成
    renderQueue.ts     # renderFull呼び出しの直列化キュー(シーク混線防止、キャンセル対応)
    diff.ts            # 縮小グレースケール化とフレーム間差分率の計算(純関数)
    extractor.ts       # 差分系列としきい値から採用フレームを決定・再抽出(純ロジック)
    format.ts          # ファイル形式判定・ファイル名・バイト数表記などの整形(純関数)
    zip.ts             # 採用フレームのZIP生成(fflate、キャンセル対応)
    gifExport.ts       # 採用フレームのアニメーションGIFエンコード(gifenc)
```
