import { toGray64 } from './diff';
import type { FrameSource } from './frameSource';
import type { SampledFrame, ScanOptions } from './types';

const GRAY_SIZE = 64;
const THUMBNAIL_MAX_WIDTH = 360;
const THUMBNAIL_QUALITY = 0.85;

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
 * 再利用される共有 Promise ―― 例えば動画のメタデータ読み込み Promise ――
 * を、たまたま最初に待っていた呼び出しの abort で汚さないようにするため)。
 * abort を待つために張ったリスナーは、どちらが先に解決してもここで
 * 確実に解除する。
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

/**
 * `<video>` + seek + canvas を用いて動画からフレーム列を生成する `FrameSource` 実装。
 *
 * `requestVideoFrameCallback` は使わず、`currentTime` を進めて `seeked` イベントを
 * 待つ方式に統一する(互換性優先。ブラウザによる seek 精度のズレは許容する)。
 */
export class VideoSource implements FrameSource {
  private readonly objectUrl: string;
  private video: HTMLVideoElement | null = null;
  private videoReadyPromise: Promise<HTMLVideoElement> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(file: File) {
    this.objectUrl = URL.createObjectURL(file);
  }

  private runExclusive<T>(task: (video: HTMLVideoElement) => Promise<T>): Promise<T> {
    const run = this.queue.then(
      () => this.ensureVideo().then(task),
      () => this.ensureVideo().then(task),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ensureVideo(): Promise<HTMLVideoElement> {
    if (this.videoReadyPromise) {
      return this.videoReadyPromise;
    }

    this.videoReadyPromise = new Promise<HTMLVideoElement>((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';

      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        this.video = video;
        resolve(video);
      };
      const onError = () => {
        cleanup();
        reject(new Error('動画の読み込みに失敗しました。対応していない形式の可能性があります。'));
      };

      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      video.src = this.objectUrl;
    });

    return this.videoReadyPromise;
  }

  /**
   * `currentTime` を設定し、`seeked` イベントを待つ。
   *
   * - seek 中に動画のデコードエラー等で `error` イベントが発火した場合は
   *   reject し、`seeked` を待ち続けてハングしないようにする。
   * - `signal` が渡されていて abort された場合も速やかに reject し、
   *   待機がいつまでも解決されない状態を避ける(呼び出し側は abort による
   *   reject かどうかを `signal.aborted` で判定して静かに終了してよい)。
   * - どの経路で settle した場合でも、登録したイベントリスナーは必ず
   *   すべて解除する(リーク防止)。
   */
  private seekTo(video: HTMLVideoElement, timeSec: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(this.createAbortError());
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('動画のシークに失敗しました。対応していない形式の可能性があります。'));
      };
      const onAbort = () => {
        cleanup();
        reject(this.createAbortError());
      };

      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });

      video.currentTime = timeSec;
    });
  }

  private createAbortError(): DOMException {
    return new DOMException('中断されました', 'AbortError');
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
    // メタデータ読み込み待ち(ensureVideo)は複数回呼び出される共有 Promise なので
    // signal による reject を混ぜ込まず、待機側を race させて abort を検知する。
    const video = await raceWithAbort(this.ensureVideo(), opts.signal);
    if (!video) {
      return;
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    const rawDurationMs = video.duration * 1000;
    const durationMs = Number.isFinite(rawDurationMs) ? Math.max(0, rawDurationMs) : 0;
    const maxSamples = Math.max(1, opts.maxSamples);

    const grayCanvas = document.createElement('canvas');
    grayCanvas.width = GRAY_SIZE;
    grayCanvas.height = GRAY_SIZE;
    const grayCtx = requireContext(grayCanvas, true);

    if (durationMs <= 0) {
      // duration が取得できない特殊なファイルは、先頭 1 フレームのみ扱う。
      if (opts.signal?.aborted) {
        return;
      }
      const frame = await this.captureAt(0, 0, grayCtx, width, height, opts.signal);
      if (!frame || opts.signal?.aborted) {
        return;
      }
      opts.onProgress?.(1, 1);
      yield frame;
      return;
    }

    const effectiveIntervalMs = Math.max(opts.intervalMs, Math.ceil(durationMs / maxSamples));
    const estimatedTotal = Math.min(maxSamples, Math.floor(durationMs / effectiveIntervalMs) + 1);

    let sampled = 0;
    let index = 0;
    for (let t = 0; t <= durationMs && sampled < maxSamples; t += effectiveIntervalMs) {
      if (opts.signal?.aborted) {
        return;
      }

      const frame = await this.captureAt(t, index, grayCtx, width, height, opts.signal);
      if (!frame || opts.signal?.aborted) {
        return;
      }

      sampled += 1;
      index += 1;
      opts.onProgress?.(sampled, estimatedTotal);
      yield frame;
    }
  }

  /**
   * 指定タイムスタンプへ seek してフレームを取得する。`signal` が abort された
   * ことによる失敗(=`seekTo` が AbortError を reject)は静かに `null` を返し、
   * それ以外の失敗(デコードエラー等)はそのまま再 throw して呼び出し元の
   * 通常のエラーフローに乗せる。
   */
  private async captureAt(
    timestampMs: number,
    index: number,
    grayCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    signal: AbortSignal | undefined,
  ): Promise<SampledFrame | null> {
    try {
      return await this.runExclusive(async (v) => {
        await this.seekTo(v, timestampMs / 1000, signal);
        return this.captureFrame(v, grayCtx, index, timestampMs, width, height);
      });
    } catch (error) {
      if (signal?.aborted) {
        return null;
      }
      throw error;
    }
  }

  private async captureFrame(
    video: HTMLVideoElement,
    grayCtx: CanvasRenderingContext2D,
    index: number,
    timestampMs: number,
    width: number,
    height: number,
  ): Promise<SampledFrame> {
    grayCtx.clearRect(0, 0, GRAY_SIZE, GRAY_SIZE);
    grayCtx.drawImage(video, 0, 0, GRAY_SIZE, GRAY_SIZE);
    const imageData = grayCtx.getImageData(0, 0, GRAY_SIZE, GRAY_SIZE);
    const gray64 = toGray64(imageData);

    const thumbnail = await this.renderThumbnail(video, width, height);

    return { index, timestampMs, gray64, thumbnail, width, height };
  }

  renderFull(frame: SampledFrame): Promise<Blob> {
    return this.runExclusive(async (video) => {
      await this.seekTo(video, frame.timestampMs / 1000);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = requireContext(canvas);
      ctx.drawImage(video, 0, 0);
      return canvasToBlob(canvas, 'image/png');
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    URL.revokeObjectURL(this.objectUrl);

    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
  }
}
