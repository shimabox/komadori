import { decompressFrames, parseGIF } from 'gifuct-js';
import type { ParsedFrame } from 'gifuct-js';
import { toGray64 } from './diff';
import type { FrameSource } from './frameSource';
import type { SampledFrame, ScanOptions } from './types';

const GRAY_SIZE = 64;
const THUMBNAIL_MAX_WIDTH = 360;
const THUMBNAIL_QUALITY = 0.85;
/** gce が存在せず delay が取得できないフレームに対するフォールバック値(ミリ秒) */
const FALLBACK_DELAY_MS = 100;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** disposalType の処理により、次フレーム描画前に適用すべき保留アクション */
interface DisposalState {
  pendingClearRect: Rect | null;
  pendingRestoreSnapshot: ImageData | null;
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

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('画像の生成に失敗しました'));
        }
      },
      type,
      quality,
    );
  });
}

/** decompressFrames の 1 フレーム分の patch を、指定 canvas 上へ合成(重ね書き)する */
function drawPatch(
  targetCtx: CanvasRenderingContext2D,
  patchCanvas: HTMLCanvasElement,
  patchCtx: CanvasRenderingContext2D,
  frame: ParsedFrame,
): void {
  const { dims } = frame;
  if (patchCanvas.width !== dims.width || patchCanvas.height !== dims.height) {
    patchCanvas.width = dims.width;
    patchCanvas.height = dims.height;
  }
  // patch は putImageData で一旦別 canvas に書き、drawImage で本 canvas に重ねる。
  // putImageData は透明画素をそのまま上書きしてしまう(アルファ合成されない)ため、
  // 透明部分の下の絵を残すには drawImage によるアルファ合成を経由する必要がある。
  const imageData = patchCtx.createImageData(dims.width, dims.height);
  imageData.data.set(frame.patch);
  patchCtx.putImageData(imageData, 0, 0);
  targetCtx.drawImage(patchCanvas, dims.left, dims.top);
}

/**
 * 1 フレーム分を canvas に合成する(disposal 処理込み)。
 * 呼び出し前に、前フレームの disposalType に基づく保留アクション(state)を
 * 適用しておく必要がある。
 */
function applyFrameToCanvas(
  ctx: CanvasRenderingContext2D,
  patchCanvas: HTMLCanvasElement,
  patchCtx: CanvasRenderingContext2D,
  frame: ParsedFrame,
  state: DisposalState,
): void {
  // 前フレームの disposalType による保留アクションを、このフレームを描く前に適用する。
  if (state.pendingRestoreSnapshot) {
    ctx.putImageData(state.pendingRestoreSnapshot, 0, 0);
    state.pendingRestoreSnapshot = null;
  } else if (state.pendingClearRect) {
    const r = state.pendingClearRect;
    ctx.clearRect(r.left, r.top, r.width, r.height);
    state.pendingClearRect = null;
  }

  const disposalType = typeof frame.disposalType === 'number' ? frame.disposalType : 0;

  // disposalType === 3(直前の状態に復元)の場合、このフレームを描く直前の状態を
  // スナップショットしておき、次フレームの描画前に復元できるようにする。
  let snapshotBeforeDraw: ImageData | null = null;
  if (disposalType === 3) {
    snapshotBeforeDraw = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  drawPatch(ctx, patchCanvas, patchCtx, frame);

  if (disposalType === 2) {
    state.pendingClearRect = frame.dims;
  } else if (disposalType === 3) {
    state.pendingRestoreSnapshot = snapshotBeforeDraw;
  }
  // 0 または 1 の場合は何もしない(前フレームの描画結果をそのまま残す)。
}

/** デコード後のフレーム数が maxSamples を超える場合に、均等間引きした添字配列を返す */
function pickEvenIndices(total: number, maxSamples: number): number[] {
  if (total <= maxSamples) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const step = total / maxSamples;
  const picked = new Set<number>();
  for (let i = 0; i < maxSamples; i++) {
    picked.add(Math.min(total - 1, Math.floor(i * step)));
  }
  return Array.from(picked).sort((a, b) => a - b);
}

/**
 * `gifuct-js` で GIF をデコードしフレーム列を生成する `FrameSource` 実装。
 *
 * GIF は間引きなしで全フレームを合成(disposal 処理込み)した上で、
 * 出力するサンプル数だけ均等間引きする。デコード結果(`decompressFrames` の出力)は
 * `renderFull` での再合成のためインスタンス内に保持し、`dispose()` まで破棄しない。
 */
export class GifSource implements FrameSource {
  private readonly file: File;
  private decodedFrames: ParsedFrame[] | null = null;
  private decodePromise: Promise<void> | null = null;
  private canvasWidth = 0;
  private canvasHeight = 0;
  /** yield した SampledFrame.index -> decompressFrames 配列中の元インデックス */
  private sampleToOriginalIndex: number[] = [];
  private disposed = false;

  constructor(file: File) {
    this.file = file;
  }

  private async ensureDecoded(): Promise<ParsedFrame[]> {
    if (this.decodedFrames) {
      return this.decodedFrames;
    }
    if (!this.decodePromise) {
      this.decodePromise = this.decode();
    }
    await this.decodePromise;
    if (!this.decodedFrames) {
      throw new Error('GIF のデコードに失敗しました');
    }
    return this.decodedFrames;
  }

  private async decode(): Promise<void> {
    let buffer: ArrayBuffer;
    try {
      buffer = await this.file.arrayBuffer();
    } catch {
      throw new Error('GIF ファイルの読み込みに失敗しました');
    }

    try {
      const gif = parseGIF(buffer);
      const frames = decompressFrames(gif, true);
      this.canvasWidth = gif.lsd.width;
      this.canvasHeight = gif.lsd.height;
      this.decodedFrames = frames;
    } catch {
      throw new Error('GIF の解析に失敗しました。対応していない形式の可能性があります。');
    }
  }

  private renderThumbnail(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
    const scale = width > 0 ? Math.min(1, THUMBNAIL_MAX_WIDTH / width) : 1;
    const thumbWidth = Math.max(1, Math.round(width * scale));
    const thumbHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const ctx = requireContext(canvas);
    ctx.drawImage(source, 0, 0, thumbWidth, thumbHeight);
    return canvasToBlob(canvas, 'image/jpeg', THUMBNAIL_QUALITY);
  }

  async *scan(opts: ScanOptions): AsyncGenerator<SampledFrame> {
    const frames = await this.ensureDecoded();
    if (frames.length === 0 || opts.signal?.aborted) {
      return;
    }

    const maxSamples = Math.max(1, opts.maxSamples);
    const outputIndices = pickEvenIndices(frames.length, maxSamples);
    const outputSet = new Set(outputIndices);
    const estimatedTotal = outputIndices.length;

    const canvas = document.createElement('canvas');
    canvas.width = this.canvasWidth;
    canvas.height = this.canvasHeight;
    const ctx = requireContext(canvas, true);

    const patchCanvas = document.createElement('canvas');
    const patchCtx = requireContext(patchCanvas);

    const grayCanvas = document.createElement('canvas');
    grayCanvas.width = GRAY_SIZE;
    grayCanvas.height = GRAY_SIZE;
    const grayCtx = requireContext(grayCanvas, true);

    const state: DisposalState = { pendingClearRect: null, pendingRestoreSnapshot: null };
    this.sampleToOriginalIndex = [];

    let elapsedMs = 0;
    let sampled = 0;

    for (let i = 0; i < frames.length; i++) {
      if (opts.signal?.aborted) {
        return;
      }

      const frame = frames[i];
      const timestampMs = elapsedMs;

      applyFrameToCanvas(ctx, patchCanvas, patchCtx, frame, state);

      if (outputSet.has(i)) {
        grayCtx.clearRect(0, 0, GRAY_SIZE, GRAY_SIZE);
        grayCtx.drawImage(canvas, 0, 0, GRAY_SIZE, GRAY_SIZE);
        const grayImageData = grayCtx.getImageData(0, 0, GRAY_SIZE, GRAY_SIZE);
        const gray64 = toGray64(grayImageData);
        const thumbnail = await this.renderThumbnail(canvas, this.canvasWidth, this.canvasHeight);

        this.sampleToOriginalIndex.push(i);
        const sampledFrame: SampledFrame = {
          index: sampled,
          timestampMs,
          gray64,
          thumbnail,
          width: this.canvasWidth,
          height: this.canvasHeight,
        };
        sampled += 1;
        opts.onProgress?.(sampled, estimatedTotal);
        yield sampledFrame;
      }

      const delay =
        typeof frame.delay === 'number' && frame.delay > 0 ? frame.delay : FALLBACK_DELAY_MS;
      elapsedMs += delay;
    }
  }

  async renderFull(frame: SampledFrame): Promise<Blob> {
    const frames = await this.ensureDecoded();
    const originalIndex = this.sampleToOriginalIndex[frame.index] ?? 0;

    const canvas = document.createElement('canvas');
    canvas.width = this.canvasWidth;
    canvas.height = this.canvasHeight;
    const ctx = requireContext(canvas, true);

    const patchCanvas = document.createElement('canvas');
    const patchCtx = requireContext(patchCanvas);

    const state: DisposalState = { pendingClearRect: null, pendingRestoreSnapshot: null };
    const lastIndex = Math.min(originalIndex, frames.length - 1);
    for (let i = 0; i <= lastIndex; i++) {
      applyFrameToCanvas(ctx, patchCanvas, patchCtx, frames[i], state);
    }

    return canvasToBlob(canvas, 'image/png');
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.decodedFrames = null;
    this.decodePromise = null;
  }
}
