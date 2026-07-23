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

  private seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = timeSec;
    });
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
    const video = await this.ensureVideo();
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
      const frame = await this.runExclusive(async (v) => {
        await this.seekTo(v, 0);
        return this.captureFrame(v, grayCtx, 0, 0, width, height);
      });
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

      const timestampMs = t;
      const frame = await this.runExclusive(async (v) => {
        await this.seekTo(v, timestampMs / 1000);
        return this.captureFrame(v, grayCtx, index, timestampMs, width, height);
      });

      if (opts.signal?.aborted) {
        return;
      }

      sampled += 1;
      index += 1;
      opts.onProgress?.(sampled, estimatedTotal);
      yield frame;
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
