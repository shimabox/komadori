import { describe, expect, it } from 'vitest';
import { extractChangedFrames } from './extractor';
import type { SampledFrame } from './types';

/**
 * gray64 を単一の輝度値で埋めたテスト用フレームを作る。
 * gray64 全体が一様な値になるため、フレーム間の差はどのタイルでも同じになり、
 * `tileDiffPercent` は実質的に「フレーム全体が一様に変化した場合」の
 * グローバルな変化を模した値になる。
 */
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
    // |0-12| = 12 はノイズフロア(10)以上なので切り捨てられず、
    // tileDiffPercent(0, 12) = 12/255*100 ≈ 4.71% という正のスコアになる。
    // ただし、その正のスコアがしきい値(6%)未満なので不採用になる
    // (「常に採用する」誤実装ではこのテストは落ちる)。
    const frames = [makeFrame(0, 0), makeFrame(1, 12)];
    const result = extractChangedFrames(frames, 6);
    expect(result).toEqual([frames[0]]);
  });

  it('しきい値以上の変化は採用される', () => {
    // |0-100| = 100 はノイズフロア以上。tileDiffPercent(0, 100) = 100/255*100 ≈ 39.2% >= 3%
    const frames = [makeFrame(0, 0), makeFrame(1, 100)];
    const result = extractChangedFrames(frames, 3);
    expect(result).toEqual(frames);
  });

  it('比較対象は「直前サンプル」ではなく「直前に採用したフレーム」になる', () => {
    // frame0=0, frame1=15 (diff from frame0 = 15 -> 15/255*100≈5.88% -> しきい値8%未満なので不採用),
    // frame2=30 (直前サンプルの frame1 との diff = 15 -> ≈5.88%で誤実装なら不採用になってしまうが、
    //           直前に採用した frame0 との diff = 30 -> ≈11.76% はしきい値8%以上なので採用されるべき)
    const frames = [makeFrame(0, 0), makeFrame(1, 15), makeFrame(2, 30)];
    const result = extractChangedFrames(frames, 8);
    expect(result.map((f) => f.index)).toEqual([0, 2]);
  });

  it('採用がスキップされた後も比較基準(直前採用フレーム)が正しく更新される', () => {
    // frame0=0 (採用),
    // frame1=5 (frame0 との diff=5 はノイズフロア未満で 0% -> 不採用),
    // frame2=8 (frame0 との diff=8 もノイズフロア未満で 0% -> 不採用のまま),
    // frame3=40 (frame0 との diff=40 -> 40/255*100≈15.69% はしきい値6%以上なので採用),
    // 採用後は frame3 が新しい基準になる。frame4=42 は frame3 との diff=2 でノイズフロア未満 -> 不採用。
    const frames = [
      makeFrame(0, 0),
      makeFrame(1, 5),
      makeFrame(2, 8),
      makeFrame(3, 40),
      makeFrame(4, 42),
    ];
    const result = extractChangedFrames(frames, 6);
    expect(result.map((f) => f.index)).toEqual([0, 3]);
  });

  it('しきい値を変えると採用結果が変わる', () => {
    const frames = [makeFrame(0, 0), makeFrame(1, 15), makeFrame(2, 30)];
    const lowThreshold = extractChangedFrames(frames, 2);
    const highThreshold = extractChangedFrames(frames, 20);
    expect(lowThreshold.length).toBeGreaterThan(highThreshold.length);
    expect(lowThreshold.map((f) => f.index)).toEqual([0, 1, 2]);
    expect(highThreshold.map((f) => f.index)).toEqual([0]);
  });

  it('空配列を渡すと空配列を返す', () => {
    expect(extractChangedFrames([], 3)).toEqual([]);
  });
});
