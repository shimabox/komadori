import { describe, expect, it } from 'vitest';
import { extractChangedFrames } from './extractor';
import type { SampledFrame } from './types';

/** gray64 を単一の輝度値で埋めたテスト用フレームを作る */
function makeFrame(index: number, value: number, timestampMs = index * 200): SampledFrame {
  return {
    index,
    timestampMs,
    gray64: new Uint8Array(4096).fill(value),
    thumbnail: new Blob(),
    width: 100,
    height: 100,
  };
}

describe('extractChangedFrames', () => {
  it('先頭フレームは常に採用される', () => {
    const frames = [makeFrame(0, 128)];
    const result = extractChangedFrames(frames, 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(frames[0]);
  });

  it('しきい値未満の変化は不採用になる', () => {
    // diff(0, 1) = 1/255*100 ≈ 0.39% < 3%
    const frames = [makeFrame(0, 0), makeFrame(1, 1)];
    const result = extractChangedFrames(frames, 3);
    expect(result).toEqual([frames[0]]);
  });

  it('しきい値以上の変化は採用される', () => {
    // diff(0, 100) = 100/255*100 ≈ 39.2% >= 3%
    const frames = [makeFrame(0, 0), makeFrame(1, 100)];
    const result = extractChangedFrames(frames, 3);
    expect(result).toEqual(frames);
  });

  it('比較対象は「直前サンプル」ではなく「直前に採用したフレーム」になる', () => {
    // frame0=0, frame1=2 (diff from frame0 ≈0.78% -> 不採用),
    // frame2=4 (直前サンプルの frame1 との diff ≈0.78% -> 誤実装なら不採用になってしまうが、
    //           直前に採用した frame0 との diff ≈1.57% -> しきい値1%以上なので採用されるべき)
    const frames = [makeFrame(0, 0), makeFrame(1, 2), makeFrame(2, 4)];
    const result = extractChangedFrames(frames, 1);
    expect(result.map((f) => f.index)).toEqual([0, 2]);
  });

  it('採用がスキップされた後も比較基準(直前採用フレーム)が正しく更新される', () => {
    // frame0=0 (採用), frame1=1 (diff 0.39% -> 不採用),
    // frame2=2 (frame0 との diff 0.78% -> 不採用のまま), frame3=10 (frame0 との diff 3.9% -> 採用)
    // 採用後は frame3 が新しい基準になる。frame4=11 は frame3 との diff 0.39% -> 不採用。
    const frames = [
      makeFrame(0, 0),
      makeFrame(1, 1),
      makeFrame(2, 2),
      makeFrame(3, 10),
      makeFrame(4, 11),
    ];
    const result = extractChangedFrames(frames, 3);
    expect(result.map((f) => f.index)).toEqual([0, 3]);
  });

  it('しきい値を変えると採用結果が変わる', () => {
    const frames = [makeFrame(0, 0), makeFrame(1, 5), makeFrame(2, 10)];
    const lowThreshold = extractChangedFrames(frames, 1);
    const highThreshold = extractChangedFrames(frames, 10);
    expect(lowThreshold.length).toBeGreaterThan(highThreshold.length);
    expect(lowThreshold.map((f) => f.index)).toEqual([0, 1, 2]);
    expect(highThreshold.map((f) => f.index)).toEqual([0]);
  });

  it('空配列を渡すと空配列を返す', () => {
    expect(extractChangedFrames([], 3)).toEqual([]);
  });
});
