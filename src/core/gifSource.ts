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

/**
 * GifSource の合成済みインデックス(`renderedUpTo`)と目標インデックスから、
 * 「先頭からリセットして合成し直す必要があるか」と「どのインデックスから
 * 合成を再開すべきか」を返す純粋関数。
 *
 * - 未合成(renderedUpTo が null)、または目標が合成済みより前(ビューアで
 *   遡った場合など)は、canvas と DisposalState を巻き戻して 0 から合成し直す
 *   必要があるため `{ reset: true, from: 0 }` を返す
 * - 目標が合成済み以上(同じ場合を含む)なら、続きから合成すれば足りるため
 *   `{ reset: false, from: renderedUpTo + 1 }` を返す。目標が合成済みと同じ
 *   場合は `from > targetIndex` となり、呼び出し側のループが1回も回らない
 *   ことで「再合成不要」を自然に表現する
 */
export function planCompositeRange(
  renderedUpTo: number | null,
  targetIndex: number,
): { reset: boolean; from: number } {
  if (renderedUpTo === null || targetIndex < renderedUpTo) {
    return { reset: true, from: 0 };
  }
  return { reset: false, from: renderedUpTo + 1 };
}

/**
 * 各フレームの表示時間(`delaysMs[i]`、単位はミリ秒)から、時間軸に沿って
 * サンプリングするフレームの添字配列を返す。`videoSource.ts`の
 * `effectiveIntervalMs`と同じ考え方で、動画とGIFのサンプリング挙動を揃える。
 *
 * - 実効間隔は動画と同じく`Math.max(intervalMs, Math.ceil(総再生時間 / maxSamples))`。
 *   0除算・0以下を避けるため最低でも1msは確保する
 * - フレーム`i`の表示開始時刻(`startMs[i]`、それ以前のディレイの累積)が
 *   次のサンプリンググリッド点(`nextSampleAtMs`)以上になった時点でそのフレームを
 *   採用し、`nextSampleAtMs`を「採用したフレームの`startMs`を超える直近の
 *   グリッド点」まで進める。これにより、1回のグリッド到達につき最大1フレームしか
 *   採用されない(=同じフレームの重複採用が起きない)
 * - 添字は先頭から昇順に一度ずつしか調べないため、返る配列も自然に昇順・重複なしになる
 * - 先頭フレーム(index 0)は`startMs[0] === 0 === nextSampleAtMs`の初期値により、
 *   常に採用条件を満たす
 */
export function pickIndicesByInterval(
  delaysMs: readonly number[],
  intervalMs: number,
  maxSamples: number,
): number[] {
  if (delaysMs.length === 0) {
    return [];
  }

  // maxSamples は呼び出し側で 1 以上に正規化される想定だが、0 除算や
  // 空配列を返す意図しない挙動を避けるため、ここでも念のため 1 以上に丸める。
  const safeMaxSamples = Math.max(1, Math.floor(maxSamples));
  const totalMs = delaysMs.reduce((sum, delay) => sum + delay, 0);
  const effectiveIntervalMs = Math.max(1, intervalMs, Math.ceil(totalMs / safeMaxSamples));

  const picked: number[] = [];
  let elapsedMs = 0;
  let nextSampleAtMs = 0;

  for (let i = 0; i < delaysMs.length && picked.length < safeMaxSamples; i++) {
    const startMs = elapsedMs;
    if (startMs >= nextSampleAtMs) {
      picked.push(i);
      // 次にサンプリングすべきグリッド点を、採用したフレームの開始時刻を
      // 超える直近の`effectiveIntervalMs`の倍数まで進める。
      nextSampleAtMs = (Math.floor(startMs / effectiveIntervalMs) + 1) * effectiveIntervalMs;
    }
    elapsedMs += delaysMs[i];
  }

  return picked;
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
 * GIF は disposal 処理込みの合成のため全フレームを間引きなしで展開・合成する
 * 必要がある(スキャン時間はサンプリング間隔を変えても変わらない)。その上で、
 * `pickIndicesByInterval` により`videoSource.ts`と同じ考え方の時間ベースで
 * 出力フレームを選ぶ(サンプリング間隔の指定値に応じて採用件数が変わる)。
 * 展開済みフレーム(patch 付き)は`renderFull`での再合成のためインスタンス内に
 * 蓄積し、`dispose()`まで破棄しない(スキャンが先行し、`renderFull`は
 * スキャン済みフレームに対してのみ呼ばれる前提)。
 */
export class GifSource implements FrameSource {
  private readonly file: File;
  /** parseGIF 後、image を持つ生フレームだけを残した配列(まだ LZW 展開していない) */
  private rawFrames: RawImageFrame[] | null = null;
  private decodePromise: Promise<void> | null = null;
  /**
   * `parse()` の「世代」。`scan()` がキャンセル等で終了するたびに
   * インクリメントする。`file.arrayBuffer()` の完了を待っている間に
   * キャンセルされても、既にバックグラウンドで動いている `parse()` の
   * Promise チェーン自体は止められない。この世代番号を使って、遅れて
   * 完了した古い `parse()` が(scan() 側は既に破棄したはずの)
   * `this.rawFrames` を再代入してしまわないようにする。
   */
  private parseGeneration = 0;
  private canvasWidth = 0;
  private canvasHeight = 0;
  private gct: GifColorTable = [];
  /** scan() 中にフレーム単位で LZW 展開して蓄積したもの(renderFull の再合成に使う) */
  private decodedFrames: ParsedFrame[] = [];
  /** yield した SampledFrame.index -> rawFrames/decodedFrames 配列中の元インデックス */
  private sampleToOriginalIndex: number[] = [];
  private disposed = false;

  // ---- renderFull の逐次合成状態 ----
  // renderFull は呼ばれるたびに 0 から合成し直していたため、対象フレームが
  // n 枚あると合成回数の合計が概ね O(n^2) になっていた。直前までの合成結果を
  // canvas ごとインスタンスに永続化し、続きから合成できるようにする。
  //
  // renderFull は src/main.ts の enqueueRenderFull によって
  // downloadOne / downloadZip / ビューアの ensureFullRes の
  // 全経路で直列化されており、同時に2つの renderFull が走ることはない。
  // そのため、この合成用 canvas を複数呼び出しで使い回しても競合しない
  // (直列化が崩れると、ここで保持する canvas / DisposalState / renderedUpTo
  // への読み書きが競合しうるため、この前提が崩れる変更をする場合は要注意)。
  /** 合成先 canvas(renderFull 間で使い回す) */
  private compositeCanvas: HTMLCanvasElement | null = null;
  private compositeCtx: CanvasRenderingContext2D | null = null;
  /** drawPatch が使う patch 用の作業 canvas(renderFull 間で使い回す) */
  private compositePatchCanvas: HTMLCanvasElement | null = null;
  private compositePatchCtx: CanvasRenderingContext2D | null = null;
  /** 前フレームの disposalType による保留アクション(合成の続きを正しく行うために引き継ぐ) */
  private compositeState: DisposalState = { pendingClearRect: null, pendingRestoreSnapshot: null };
  /** decodedFrames のうち、どの元インデックスまで合成済みか(未合成なら null) */
  private renderedUpTo: number | null = null;

  constructor(file: File) {
    this.file = file;
  }

  /**
   * renderFull の逐次合成状態を破棄し、次回呼び出しで先頭から合成し直す
   * ようにする。scan() が新たに走って decodedFrames が作り直されるとき
   * (合成済みインデックスの意味が変わってしまうため)と、dispose() で
   * 呼ぶ。
   */
  private resetCompositeState(): void {
    this.compositeCanvas = null;
    this.compositeCtx = null;
    this.compositePatchCanvas = null;
    this.compositePatchCtx = null;
    this.compositeState = { pendingClearRect: null, pendingRestoreSnapshot: null };
    this.renderedUpTo = null;
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
    // 呼び出し時点の世代を記録しておく。await の間に scan() がキャンセル
    // 等で終了すると、finally が parseGeneration をインクリメントして
    // この世代を無効化する。
    const myGeneration = this.parseGeneration;

    let buffer: ArrayBuffer;
    try {
      buffer = await this.file.arrayBuffer();
    } catch {
      throw new Error('GIF ファイルの読み込みに失敗しました');
    }

    if (myGeneration !== this.parseGeneration) {
      // 既に無効化された古い世代の parse。呼び出し元(scan())は
      // キャンセル等で既に終了しており誰も結果を見ていないため、
      // this.rawFrames 等には触れず、エラーにもせず静かに終了する。
      return;
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
    // try を raceWithAbort の呼び出し自体を含む形で広く取ることで、
    // 「ensureParsed() の内部 Promise は resolve 済みで this.rawFrames は
    // 既にセットされているが、そのマイクロタスクが処理される前に abort
    // イベントが先に isSettled を確定させてしまい raceWithAbort が
    // ローカル変数側には null を返す」というレースが起きた場合の早期
    // return も含めて、finally で確実に解放されるようにする
    // (この分岐だけ finally の外に出してしまうと、その競合発生時に
    // this.rawFrames が非 null のまま取り残されてしまうため)。
    try {
      // パース待ち(ensureParsed)は複数回呼び出される共有 Promise なので
      // signal による reject を混ぜ込まず、待機側を race させて abort を検知する。
      const rawFrames = await raceWithAbort(this.ensureParsed(), opts.signal);
      if (!rawFrames || rawFrames.length === 0) {
        return;
      }

      const maxSamples = Math.max(1, opts.maxSamples);
      // 各フレームのディレイ(ミリ秒)を、LZW 展開前の生フレームの時点で
      // gifuct-js の decompressFrame と同じ式(`(gce.delay || 10) * 10`)を
      // 使って先に組み立てる。展開後の`frame.delay`は decompressFrame の
      // 呼び出しごとにしか手に入らないため、ここで先に作った配列を
      // 「サンプリング対象の選定」と「下のループの elapsedMs 加算」の両方で
      // 共通して使うことで、採用したインデックスとタイムスタンプが
      // 食い違わないようにする(gce が無いフレームは既存の FALLBACK_DELAY_MS
      // に合わせる)。
      const delaysMs = rawFrames.map((rawFrame) =>
        rawFrame.gce ? (rawFrame.gce.delay || 10) * 10 : FALLBACK_DELAY_MS,
      );
      const outputIndices = pickIndicesByInterval(delaysMs, opts.intervalMs, maxSamples);
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
      // decodedFrames を作り直すため、以前の renderFull 合成状態
      // (renderedUpTo が指す先が古い decodedFrames のインデックスになって
      // しまう)は無効になる。ここでリセットしておく。
      this.resetCompositeState();

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

        // 展開後の frame.delay ではなく、上で先に組み立てた delaysMs(同じ式で
        // 算出済み)を使う。両者を別々に計算すると値がずれ得るため、二重管理を避ける。
        elapsedMs += delaysMs[i];

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
      // file.arrayBuffer() の完了待ちの間にキャンセルされた場合、
      // バックグラウンドで動き続けている古い parse() が後から完了して
      // 上の this.rawFrames = null を上書きしてしまわないよう、世代を
      // 進めて無効化する(parse() 側は myGeneration !== this.parseGeneration
      // を見て代入をスキップする)。
      this.parseGeneration += 1;
    }
  }

  /**
   * 対象フレームまでを合成した canvas から PNG を生成する。
   *
   * 二乗時間を避けるため、前回までの合成結果(compositeCanvas /
   * compositeState / renderedUpTo)を使い回し、`planCompositeRange` が
   * 返す範囲だけを追加合成する。目標インデックスが合成済みより前の
   * 場合(ビューアで遡った場合など)だけ、canvas と DisposalState を
   * リセットして 0 から合成し直す。
   *
   * `applyFrameToCanvas` は「前フレームの disposalType による保留
   * アクションを、このフレームを描く前に適用する」設計になっているため、
   * `compositeState` を呼び出しをまたいで引き継ぐ限り、途中から合成を
   * 再開しても最初から合成した場合と同じ結果になる。
   *
   * `renderedUpTo` は「canvas に実際に反映済みのインデックス」を表す値
   * として扱い、canvas の実状態と常に一致させる。そのため合成ループの
   * 一括代入(ループ後にまとめて更新)はせず、1フレーム適用するたびに
   * 更新する。こうしておくことで、`applyFrameToCanvas` が例外を投げて
   * ループが途中で止まっても、次回の呼び出しは「実際に反映済みの
   * 範囲」の続きから正しく再開できる(ループ後の一括代入だと、canvas は
   * 途中まで進んでいるのに `renderedUpTo` は古い値のままになり、次回
   * 既に適用済みのフレームを二重に適用して合成結果が壊れてしまう)。
   */
  async renderFull(frame: SampledFrame): Promise<Blob> {
    const originalIndex = this.sampleToOriginalIndex[frame.index] ?? 0;
    const targetIndex = Math.min(originalIndex, this.decodedFrames.length - 1);

    if (!this.compositeCanvas || !this.compositeCtx) {
      this.compositeCanvas = document.createElement('canvas');
      this.compositeCanvas.width = this.canvasWidth;
      this.compositeCanvas.height = this.canvasHeight;
      this.compositeCtx = requireContext(this.compositeCanvas, true);
    }
    if (!this.compositePatchCanvas || !this.compositePatchCtx) {
      this.compositePatchCanvas = document.createElement('canvas');
      this.compositePatchCtx = requireContext(this.compositePatchCanvas);
    }

    const plan = planCompositeRange(this.renderedUpTo, targetIndex);
    if (plan.reset) {
      this.compositeCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
      this.compositeState = { pendingClearRect: null, pendingRestoreSnapshot: null };
      // canvas と DisposalState は既にリセット後の(=未合成の)状態になった
      // ため、renderedUpTo もここで一旦 null に戻しておく。これを怠ると、
      // 直後の合成ループで例外が起きたときに「canvas は空にリセットされて
      // いるのに renderedUpTo は古い値のまま」という食い違いが生まれる。
      this.renderedUpTo = null;
    }

    for (let i = plan.from; i <= targetIndex; i++) {
      applyFrameToCanvas(
        this.compositeCtx,
        this.compositePatchCanvas,
        this.compositePatchCtx,
        this.decodedFrames[i],
        this.compositeState,
      );
      // canvas の実状態と renderedUpTo を常に一致させるため、1フレーム
      // 適用するたびに更新する(詳細は上のメソッド doc コメントを参照)。
      this.renderedUpTo = i;
    }

    return canvasToBlob(this.compositeCanvas, 'image/png');
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rawFrames = null;
    this.decodePromise = null;
    this.decodedFrames = [];
    this.resetCompositeState();
    // scan() を経由していない(呼ばれる前・呼ばれていない)場合の
    // 保険として、ここでも世代を進めておく。通常経路では scan() の
    // finally が既に進めているため無害な重複インクリメントになる。
    this.parseGeneration += 1;
  }
}
