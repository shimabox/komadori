import { decompressFrame, parseGIF } from 'gifuct-js';
import type { ParsedFrame, ParsedGif } from 'gifuct-js';
import { toGray64 } from './diff';
import type { FrameSource } from './frameSource';
import type { SampledFrame, ScanOptions } from './types';

const GRAY_SIZE = 64;
const THUMBNAIL_MAX_WIDTH = 360;
const THUMBNAIL_QUALITY = 0.85;
/** gce が存在せず delay が取得できないフレームに対するフォールバック値(ミリ秒) */
const FALLBACK_DELAY_MS = 100;
/** この時間(ミリ秒)以上、間を置かずに処理が続いたら一度イベントループへ制御を返す */
const YIELD_INTERVAL_MS = 16;

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

/** parseGIF が返す `frames` 配列の要素(拡張ブロックと画像フレームが混在する) */
type RawGifFrame = ParsedGif['frames'][number];
/** そのうち画像を持つ要素だけ(= decompressFrame に渡せるもの) */
type RawImageFrame = Extract<RawGifFrame, { image: unknown }>;
type GifColorTable = ParsedGif['gct'];

/**
 * `parseGIF` の `frames` には Application 等の拡張ブロックも混在するため、
 * `image` プロパティを持つ要素だけを LZW 展開の対象にする
 * (`decompressFrames` の内部実装 `.filter(f => f.image)` と同じ挙動)。
 */
function hasImage(item: RawGifFrame): item is RawImageFrame {
  return 'image' in item;
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

/**
 * `promise` の解決を待つが、`signal` が abort された場合はそちらを優先して
 * `null` で解決する。`promise` 自体は reject させない(複数回の呼び出しで
 * 再利用される共有 Promise ―― 例えば GIF パース Promise ―― を、たまたま
 * 最初に待っていた呼び出しの abort で汚さないようにするため)。abort を
 * 待つために張ったリスナーは、どちらが先に解決してもここで確実に解除する。
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.resolve(null);
  }

  return new Promise<T | null>((resolve, reject) => {
    let isSettled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      cleanup();
      resolve(null);
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** decompressFrame の 1 フレーム分の patch を、指定 canvas 上へ合成(重ね書き)する */
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
 * `parseGIF` はメタデータと圧縮済みブロックを取り出すだけの軽い処理なので
 * 共有 Promise(`decode`)でまとめて待つが、フレームごとの LZW 展開
 * (`decompressFrame`)は CPU 負荷が高く GIF 全体では長時間ブロックしうるため、
 * `scan()` の中でフレーム単位に行い、一定時間ごとにイベントループへ制御を
 * 返してキャンセルを検知できるようにする。
 *
 * GIF は間引きなしで全フレームを合成(disposal 処理込み)した上で、
 * 出力するサンプル数だけ均等間引きする。展開済みフレーム(patch 付き)は
 * `renderFull` での再合成のためインスタンス内に蓄積し、`dispose()` まで
 * 破棄しない(スキャンが先行し、`renderFull` はスキャン済みフレームに対して
 * のみ呼ばれる前提)。
 */
export class GifSource implements FrameSource {
  private readonly file: File;
  /** parseGIF 後、image を持つ生フレームだけを残した配列(まだ LZW 展開していない) */
  private rawFrames: RawImageFrame[] | null = null;
  private decodePromise: Promise<void> | null = null;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private gct: GifColorTable = [];
  /** scan() 中にフレーム単位で LZW 展開して蓄積したもの(renderFull の再合成に使う) */
  private decodedFrames: ParsedFrame[] = [];
  /** yield した SampledFrame.index -> rawFrames/decodedFrames 配列中の元インデックス */
  private sampleToOriginalIndex: number[] = [];
  private disposed = false;

  constructor(file: File) {
    this.file = file;
  }

  private async ensureParsed(): Promise<RawImageFrame[]> {
    if (this.rawFrames) {
      return this.rawFrames;
    }
    if (!this.decodePromise) {
      this.decodePromise = this.parse();
    }
    await this.decodePromise;
    if (!this.rawFrames) {
      throw new Error('GIF のデコードに失敗しました');
    }
    return this.rawFrames;
  }

  /** `file.arrayBuffer()` + `parseGIF()` のみを行う(LZW 展開は含まない軽量処理) */
  private async parse(): Promise<void> {
    let buffer: ArrayBuffer;
    try {
      buffer = await this.file.arrayBuffer();
    } catch {
      throw new Error('GIF ファイルの読み込みに失敗しました');
    }

    try {
      const gif = parseGIF(buffer);
      this.canvasWidth = gif.lsd.width;
      this.canvasHeight = gif.lsd.height;
      this.gct = gif.gct;
      this.rawFrames = gif.frames.filter(hasImage);
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
    // パース待ち(ensureParsed)は複数回呼び出される共有 Promise なので
    // signal による reject を混ぜ込まず、待機側を race させて abort を検知する。
    const rawFrames = await raceWithAbort(this.ensureParsed(), opts.signal);
    if (!rawFrames || rawFrames.length === 0) {
      return;
    }

    try {
      const maxSamples = Math.max(1, opts.maxSamples);
      const outputIndices = pickEvenIndices(rawFrames.length, maxSamples);
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
      this.decodedFrames = [];
      this.sampleToOriginalIndex = [];

      let elapsedMs = 0;
      let sampled = 0;
      let lastYieldAt = performance.now();

      for (let i = 0; i < rawFrames.length; i++) {
        if (opts.signal?.aborted) {
          return;
        }

        // LZW 展開(CPU 負荷が高い部分)をフレーム単位で行う。
        const frame = decompressFrame(rawFrames[i], this.gct, true);
        this.decodedFrames.push(frame);

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

          if (opts.signal?.aborted) {
            return;
          }
        }

        const delay =
          typeof frame.delay === 'number' && frame.delay > 0 ? frame.delay : FALLBACK_DELAY_MS;
        elapsedMs += delay;

        // yield によるサスペンドは Promise の解決(マイクロタスク)止まりで、
        // ブラウザの入力処理・再描画までは保証されない。一定時間ごとに
        // setTimeout でマクロタスク境界まで制御を返し、キャンセルボタンの
        // クリックなどが確実に処理されるようにする。
        if (performance.now() - lastYieldAt >= YIELD_INTERVAL_MS) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          lastYieldAt = performance.now();
          if (opts.signal?.aborted) {
            return;
          }
        }
      }
    } finally {
      // スキャン完了・中断(signal による早期 return)・呼び出し側の
      // for await が早期 return/break して .return() 経由で抜けた場合の
      // いずれでも、展開前の圧縮フレームデータ(rawFrames)はもう不要になる
      // ため解放する。renderFull が使う decodedFrames(展開済み)は
      // ここでは触れない。decodePromise も一緒に null に戻しておくことで、
      // 万一 scan() が再度呼ばれても ensureParsed() が安全に再パースできる
      // ようにする(rawFrames だけ null であっても、古い decodePromise が
      // 残っていると ensureParsed が再パースせずに失敗してしまうため)。
      this.rawFrames = null;
      this.decodePromise = null;
    }
  }

  async renderFull(frame: SampledFrame): Promise<Blob> {
    const originalIndex = this.sampleToOriginalIndex[frame.index] ?? 0;

    const canvas = document.createElement('canvas');
    canvas.width = this.canvasWidth;
    canvas.height = this.canvasHeight;
    const ctx = requireContext(canvas, true);

    const patchCanvas = document.createElement('canvas');
    const patchCtx = requireContext(patchCanvas);

    const state: DisposalState = { pendingClearRect: null, pendingRestoreSnapshot: null };
    const lastIndex = Math.min(originalIndex, this.decodedFrames.length - 1);
    for (let i = 0; i <= lastIndex; i++) {
      applyFrameToCanvas(ctx, patchCanvas, patchCtx, this.decodedFrames[i], state);
    }

    return canvasToBlob(canvas, 'image/png');
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rawFrames = null;
    this.decodePromise = null;
    this.decodedFrames = [];
  }
}
