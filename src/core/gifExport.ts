import { applyPalette, GIFEncoder, quantize } from 'gifenc';

/** quantize / applyPalette に渡す色フォーマット。両者で必ず同じ値を使う必要がある */
const QUANTIZE_FORMAT = 'rgb565';

export interface GifEncodeOptions {
  /** 出力の最大幅(px)。null はフル解像度(縮小しない) */
  maxWidth: number | null;
  /** 量子化の最大色数 */
  maxColors: number;
}

export interface GifEncoderHandle {
  /** 1フレーム分の PNG Blob をデコードし、GIF ストリームへ1フレーム書き込む */
  addFrame(pngBlob: Blob, delayMs: number): Promise<void>;
  /** ストリームを終端し、GIF 全体を表す Blob を返す */
  finish(): Blob;
}

function requireContext(
  canvas: HTMLCanvasElement,
  willReadFrequently = false,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently });
  if (!ctx) {
    throw new Error('2D canvas コンテキストを取得できませんでした');
  }
  return ctx;
}

/**
 * アスペクト比を保ったまま maxWidth に収まるサイズを返す純粋関数。
 *
 * - maxWidth が null、または元幅が maxWidth 以下のときは拡大せず元サイズを返す
 * - 縮小するときは `height = round(srcHeight * width / srcWidth)` で高さを
 *   再計算し、アスペクト比を維持する
 * - 幅・高さとも最小 1px を保証する(極端に細長い画像で 0px にならないようにする)
 */
export function computeGifSize(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number | null,
): { width: number; height: number } {
  if (maxWidth === null || srcWidth <= maxWidth) {
    return { width: Math.max(1, srcWidth), height: Math.max(1, srcHeight) };
  }
  const width = Math.max(1, maxWidth);
  const height = Math.max(1, Math.round((srcHeight * width) / srcWidth));
  return { width, height };
}

/**
 * 採用フレームの PNG を1枚ずつ受け取り、1本のアニメーション GIF へ逐次エンコードする。
 *
 * GIF の論理画面サイズは全フレーム共通である必要があるため、描画用 canvas と
 * 出力サイズは最初の `addFrame` 呼び出し時(= 最初のフレームの寸法から
 * `computeGifSize` で確定)に固定し、以降のフレームは同じサイズへ描画する
 * (GIF ソースのフレームごとに寸法が異なるケースは想定していない)。
 * フル解像度 PNG をまとめてメモリに保持しなくて済むよう、呼び出し元
 * (main.ts の downloadGif)が1フレームずつ渡す前提の設計にしている。
 */
export function createGifEncoder(opts: GifEncodeOptions): GifEncoderHandle {
  const gif = GIFEncoder();
  // canvas・出力サイズは最初のフレームで確定させ、以降は使い回す
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let size: { width: number; height: number } | null = null;
  let frameCount = 0;

  async function addFrame(pngBlob: Blob, delayMs: number): Promise<void> {
    const bitmap = await createImageBitmap(pngBlob);
    try {
      if (!canvas || !ctx || !size) {
        size = computeGifSize(bitmap.width, bitmap.height, opts.maxWidth);
        canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        ctx = requireContext(canvas, true);
      }

      ctx.clearRect(0, 0, size.width, size.height);
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      const imageData = ctx.getImageData(0, 0, size.width, size.height);

      const palette = quantize(imageData.data, opts.maxColors, { format: QUANTIZE_FORMAT });
      const index = applyPalette(imageData.data, palette, QUANTIZE_FORMAT);

      gif.writeFrame(index, size.width, size.height, {
        palette,
        delay: delayMs,
        // 無限ループにするための repeat は先頭フレームにのみ指定する
        ...(frameCount === 0 ? { repeat: 0 } : {}),
      });
      frameCount += 1;
    } finally {
      bitmap.close();
    }
  }

  function finish(): Blob {
    gif.finish();
    return new Blob([gif.bytesView()], { type: 'image/gif' });
  }

  return { addFrame, finish };
}
