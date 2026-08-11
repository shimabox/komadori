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
- [Vitest](https://vitest.dev/)によるユニットテスト(`src/core/*.test.ts`)
- ランタイム依存は以下の2つのみです。
  - [`gifuct-js`](https://github.com/matt-way/gifuct-js) — GIFのデコード
  - [`fflate`](https://github.com/101arrowz/fflate) — ZIPファイルの生成

## ディレクトリ構成

```
src/
  main.ts              # エントリポイント。UIとcoreの配線
  ui/                  # DOM構築・イベント(入力エリア、設定パネル、進捗、結果一覧、ビューア)
    viewerNav.ts       # ビューアの前後送り対象決定(「採用のみ」フィルタ考慮、純関数)
  core/
    types.ts           # SampledFrame等の型定義
    frameSource.ts     # フレーム供給の共通インターフェース
    videoSource.ts     # <video> + seek + canvasで動画からフレーム列を生成
    gifSource.ts       # gifuct-jsでGIFをデコードしフレーム列を生成
    diff.ts            # 縮小グレースケール化とフレーム間差分率の計算(純関数)
    extractor.ts       # 差分系列としきい値から採用フレームを決定・再抽出(純ロジック)
    zip.ts             # 採用フレームのPNG化とZIP生成(fflate)
    gifExport.ts       # 採用フレームのアニメーションGIF化(gifenc)
  types/
    gifenc.d.ts        # gifencの型定義(本体に同梱されていないため自前で宣言)
```
