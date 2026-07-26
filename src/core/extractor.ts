import { tileDiffPercent } from './diff';
import type { SampledFrame } from './types';

/**
 * サンプル済みフレーム列としきい値(%)から、採用すべきフレームを判定する。
 *
 * - 先頭フレームは常に採用する。
 * - 以降は「直前に採用したフレーム」との `tileDiffPercent`(タイル分割+ノイズフロア方式の
 *   差分率。局所領域(タイル)ごとの最大値)が `thresholdPercent` 以上の
 *   フレームを採用する(直前の"サンプル"ではない点に注意。ゆっくり進む累積変化も
 *   拾うための確定済みロジック)。
 */
export function extractChangedFrames(
  frames: SampledFrame[],
  thresholdPercent: number,
): SampledFrame[] {
  const adopted: SampledFrame[] = [];
  let lastAdopted: SampledFrame | null = null;

  for (const frame of frames) {
    if (lastAdopted === null) {
      adopted.push(frame);
      lastAdopted = frame;
      continue;
    }

    const diff = tileDiffPercent(lastAdopted.gray64, frame.gray64);
    if (diff >= thresholdPercent) {
      adopted.push(frame);
      lastAdopted = frame;
    }
  }

  return adopted;
}
