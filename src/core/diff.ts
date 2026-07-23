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
 * 出力セル(0..GRAY_GRID_SIZE-1)ごとに、対応する元画像側の区間 [start, end) を返す。
 * 元画像がグリッドより小さい(拡大方向になる)場合でも、区間の幅が 0 にならないよう
 * 保証する(= 全ての出力セルが必ず 1 ピクセル以上をサンプリングできる)。
 */
function computeSourceRanges(sourceLength: number): { starts: Int32Array; ends: Int32Array } {
  const starts = new Int32Array(GRAY_GRID_SIZE);
  const ends = new Int32Array(GRAY_GRID_SIZE);

  for (let cell = 0; cell < GRAY_GRID_SIZE; cell++) {
    const start = Math.floor((cell * sourceLength) / GRAY_GRID_SIZE);
    let end = Math.floor(((cell + 1) * sourceLength) / GRAY_GRID_SIZE);
    if (end <= start) {
      // 元画像がグリッドより小さい場合、丸めによって区間が空になることがあるため、
      // 最低 1 ピクセルは含まれるように補正する(結果としてニアレストネイバー的に拡大される)。
      end = start + 1;
    }
    starts[cell] = start;
    ends[cell] = Math.min(end, sourceLength);
  }

  return { starts, ends };
}

/**
 * 任意サイズの ImageData 相当のデータを 64x64 グレースケールの
 * Uint8Array(長さ4096)に変換する。
 *
 * 出力セル側から対応する元画像の矩形領域を求め、その範囲内の全ピクセルを
 * 平均する(ボックスフィルタによる縮小/拡大)。元画像が 64x64 より小さい
 * 場合でも全セルが必ず元画像の画素をサンプリングできるため、黒(0)で
 * 埋まるセルが発生しない。輝度は ITU-R BT.601 相当の
 * `0.299R + 0.587G + 0.114B` で算出する。
 */
export function toGray64(image: ImageDataLike): Uint8Array {
  const { data, width, height } = image;
  const out = new Uint8Array(GRAY_CELL_COUNT);

  if (width <= 0 || height <= 0) {
    return out;
  }

  const { starts: xStarts, ends: xEnds } = computeSourceRanges(width);
  const { starts: yStarts, ends: yEnds } = computeSourceRanges(height);

  for (let gy = 0; gy < GRAY_GRID_SIZE; gy++) {
    const yStart = yStarts[gy];
    const yEnd = yEnds[gy];
    const cellRowOffset = gy * GRAY_GRID_SIZE;

    for (let gx = 0; gx < GRAY_GRID_SIZE; gx++) {
      const xStart = xStarts[gx];
      const xEnd = xEnds[gx];

      let sum = 0;
      let count = 0;
      for (let y = yStart; y < yEnd; y++) {
        const rowOffset = y * width * 4;
        for (let x = xStart; x < xEnd; x++) {
          const pixelOffset = rowOffset + x * 4;
          const r = data[pixelOffset];
          const g = data[pixelOffset + 1];
          const b = data[pixelOffset + 2];
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          count += 1;
        }
      }

      out[cellRowOffset + gx] = count > 0 ? Math.round(sum / count) : 0;
    }
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
