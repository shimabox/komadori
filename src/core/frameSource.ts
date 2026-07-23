import type { SampledFrame, ScanOptions } from './types';

/**
 * 動画/GIF からフレームを供給する共通インターフェース。
 * `videoSource.ts`(<video> + canvas)と `gifSource.ts`(gifuct-js)の
 * それぞれが実装する。
 */
export interface FrameSource {
  /** サンプリングしながらフレームを順に供給する(進捗コールバック・中断シグナル付き) */
  scan(opts: ScanOptions): AsyncGenerator<SampledFrame>;
  /** 指定フレームのフル解像度 PNG を再取得する(動画: 該当時刻へ再 seek / GIF: 再デコード・合成) */
  renderFull(frame: SampledFrame): Promise<Blob>;
  /** objectURL 等の後始末を行う */
  dispose(): void;
}
