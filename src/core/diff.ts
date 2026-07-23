/**
 * ブラウザの `ImageData` と構造的に互換なデータ型。
 * テストでは canvas を使わず、この形のプレーンオブジェクトを直接渡せる。
 */
export interface ImageDataLike {
  /** RGBA ピクセルデータ */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 差分計算用に縮小する一辺のサイズ */
export const GRAY_GRID_SIZE = 64;

const GRAY_CELL_COUNT = GRAY_GRID_SIZE * GRAY_GRID_SIZE;

/**
 * 任意サイズの ImageData 相当のデータを 64x64 グレースケールの
 * Uint8Array(長さ4096)に変換する。
 *
 * 各出力セルに対応する元画像の矩形領域内の全ピクセルを平均する
 * (ボックスフィルタによる縮小)。輝度は ITU-R BT.601 相当の
 * `0.299R + 0.587G + 0.114B` で算出する。
 */
export function toGray64(image: ImageDataLike): Uint8Array {
  const { data, width, height } = image;
  const out = new Uint8Array(GRAY_CELL_COUNT);

  if (width <= 0 || height <= 0) {
    return out;
  }

  const sums = new Float64Array(GRAY_CELL_COUNT);
  const counts = new Uint32Array(GRAY_CELL_COUNT);

  for (let y = 0; y < height; y++) {
    const gy = Math.min(GRAY_GRID_SIZE - 1, Math.floor((y * GRAY_GRID_SIZE) / height));
    const rowOffset = y * width * 4;
    const cellRowOffset = gy * GRAY_GRID_SIZE;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(GRAY_GRID_SIZE - 1, Math.floor((x * GRAY_GRID_SIZE) / width));
      const pixelOffset = rowOffset + x * 4;
      const r = data[pixelOffset];
      const g = data[pixelOffset + 1];
      const b = data[pixelOffset + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const cell = cellRowOffset + gx;
      sums[cell] += luma;
      counts[cell] += 1;
    }
  }

  for (let i = 0; i < GRAY_CELL_COUNT; i++) {
    out[i] = counts[i] > 0 ? Math.round(sums[i] / counts[i]) : 0;
  }

  return out;
}

/**
 * 2つの 64x64 グレースケール配列(gray64)から差分率を 0〜100(%) で返す。
 * 画素ごとの絶対差の平均(0〜255)を 0〜100 に正規化する。
 */
export function diffPercent(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let sumAbsDiff = 0;
  for (let i = 0; i < length; i++) {
    sumAbsDiff += Math.abs(a[i] - b[i]);
  }

  const meanAbsDiff = sumAbsDiff / length; // 0-255
  return (meanAbsDiff / 255) * 100;
}
