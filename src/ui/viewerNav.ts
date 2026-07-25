import type { SampledFrame } from '../core/types';

/** 前後送りの方向 */
export type ViewerNavDirection = 'next' | 'prev';

/**
 * viewer の前後送り対象を決定する純関数(DOM 非依存)。
 *
 * - `adoptedOnly` が true の場合、送り対象は `adoptedSet` に含まれるフレームのみになる
 *   (現在表示中のフレーム自体が `adoptedSet` に含まれているかどうかは問わない。
 *   採用を外した直後のフレームからでも、次に採用されているフレームへ送れる)。
 * - `frames` は呼び出し側(main.ts)が保持するサンプリング順(= `frame.index` 昇順)の配列
 *   であることを前提とする。
 * - 見つからない場合(先頭/末尾に達した、対象プールが空、等)は `null` を返す。ラップアラウンドはしない。
 */
export function findAdjacentFrame(
  frames: readonly SampledFrame[],
  currentFrameIndex: number,
  direction: ViewerNavDirection,
  adoptedSet: ReadonlySet<number>,
  adoptedOnly: boolean,
): SampledFrame | null {
  const pool = adoptedOnly ? frames.filter((f) => adoptedSet.has(f.index)) : frames;
  if (pool.length === 0) {
    return null;
  }

  if (direction === 'next') {
    for (const frame of pool) {
      if (frame.index > currentFrameIndex) {
        return frame;
      }
    }
    return null;
  }

  let candidate: SampledFrame | null = null;
  for (const frame of pool) {
    if (frame.index < currentFrameIndex) {
      candidate = frame;
    } else {
      break;
    }
  }
  return candidate;
}
