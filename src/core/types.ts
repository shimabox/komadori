/**
 * サンプリングによって取得された1フレーム分のデータ。
 *
 * メモリ設計上の要点: スキャン中はフル解像度の画像を保持しない。
 * 差分計算用の 64x64 グレースケールと、表示用の小さなサムネイルのみを保持し、
 * フル解像度の画像はダウンロード時に `FrameSource.renderFull` で元ソースから再取得する。
 */
export interface SampledFrame {
  /** サンプリング順の連番(0始まり) */
  index: number;
  /** 元動画/GIF先頭からの経過時間(ミリ秒) */
  timestampMs: number;
  /** 64x64 グレースケール(差分計算用、長さ 4096) */
  gray64: Uint8Array;
  /** 表示用サムネイル(JPEG、幅 320〜400px程度) */
  thumbnail: Blob;
  /** 元フレームの幅(px) */
  width: number;
  /** 元フレームの高さ(px) */
  height: number;
}

/** フレームのサンプリング(走査)に関するオプション */
export interface ScanOptions {
  /** サンプリング間隔(ミリ秒)。既定 200 */
  intervalMs: number;
  /** サンプル数上限。既定 600 */
  maxSamples: number;
  /** 中断シグナル(キャンセルボタンから渡す) */
  signal?: AbortSignal;
  /** 進捗コールバック(sampled: 取得済み件数, estimatedTotal: 推定総数) */
  onProgress?: (sampled: number, estimatedTotal: number) => void;
}
