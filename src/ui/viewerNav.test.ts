import { describe, expect, it } from 'vitest';
import { computeViewerCounter, findAdjacentFrame } from './viewerNav';
import type { SampledFrame } from '../core/types';

function makeFrame(index: number): SampledFrame {
  return {
    index,
    timestampMs: index * 200,
    gray64: new Uint8Array(4096),
    thumbnail: new Blob(),
    width: 100,
    height: 100,
  };
}

describe('findAdjacentFrame', () => {
  const frames = [0, 1, 2, 3, 4].map(makeFrame);

  it('通常送り: next で次のフレームを返す', () => {
    const result = findAdjacentFrame(frames, 1, 'next', new Set(), false);
    expect(result?.index).toBe(2);
  });

  it('通常送り: prev で前のフレームを返す', () => {
    const result = findAdjacentFrame(frames, 2, 'prev', new Set(), false);
    expect(result?.index).toBe(1);
  });

  it('端(末尾): 最後のフレームで next すると null を返す', () => {
    const result = findAdjacentFrame(frames, 4, 'next', new Set(), false);
    expect(result).toBeNull();
  });

  it('端(先頭): 先頭フレームで prev すると null を返す', () => {
    const result = findAdjacentFrame(frames, 0, 'prev', new Set(), false);
    expect(result).toBeNull();
  });

  it('「採用のみ」フィルタ: 採用フレームだけを対象に next する', () => {
    const adopted = new Set([0, 2, 4]);
    const result = findAdjacentFrame(frames, 0, 'next', adopted, true);
    expect(result?.index).toBe(2);
  });

  it('「採用のみ」フィルタ: 採用フレームだけを対象に prev する', () => {
    const adopted = new Set([0, 2, 4]);
    const result = findAdjacentFrame(frames, 4, 'prev', adopted, true);
    expect(result?.index).toBe(2);
  });

  it('採用0件: 「採用のみ」ON かつ採用フレームが1件もなければ null を返す', () => {
    const result = findAdjacentFrame(frames, 2, 'next', new Set(), true);
    expect(result).toBeNull();
  });

  it('現在フレームがフィルタ対象外: 採用を外した現在フレームからでも次の採用フレームへ送れる(next)', () => {
    // 現在フレームは index=1 だが adoptedSet には含まれていない(採用を外した直後を想定)。
    const adopted = new Set([0, 3]);
    const result = findAdjacentFrame(frames, 1, 'next', adopted, true);
    expect(result?.index).toBe(3);
  });

  it('現在フレームがフィルタ対象外: 採用を外した現在フレームからでも前の採用フレームへ送れる(prev)', () => {
    const adopted = new Set([0, 3]);
    const result = findAdjacentFrame(frames, 1, 'prev', adopted, true);
    expect(result?.index).toBe(0);
  });

  it('空配列を渡すと null を返す', () => {
    expect(findAdjacentFrame([], 0, 'next', new Set(), false)).toBeNull();
  });
});

describe('computeViewerCounter', () => {
  const frames = [0, 1, 2, 3, 4].map(makeFrame);

  it('「採用のみ表示」OFF: 全フレーム基準の position/total を返す', () => {
    const result = computeViewerCounter(frames, 2, new Set(), false);
    expect(result).toEqual({ position: 3, total: 5 });
  });

  it('「採用のみ表示」OFF: 先頭フレームは position 1', () => {
    const result = computeViewerCounter(frames, 0, new Set(), false);
    expect(result).toEqual({ position: 1, total: 5 });
  });

  it('「採用のみ表示」ON: 採用フレーム基準の position/total を返す', () => {
    const adopted = new Set([0, 2, 4]);
    // index=2 は採用済みフレームのうち2番目(0番目, 2番目, 4番目のうちの2番目)
    const result = computeViewerCounter(frames, 2, adopted, true);
    expect(result).toEqual({ position: 2, total: 3 });
  });

  it('「採用のみ表示」ON: 現在フレームが採用プールに含まれない場合、position は null', () => {
    // index=1 は採用されていない(採用を外した直後を想定)。total は採用数のまま。
    const adopted = new Set([0, 2, 4]);
    const result = computeViewerCounter(frames, 1, adopted, true);
    expect(result).toEqual({ position: null, total: 3 });
  });

  it('採用0件で「採用のみ表示」ON: position は null、total は 0', () => {
    const result = computeViewerCounter(frames, 2, new Set(), true);
    expect(result).toEqual({ position: null, total: 0 });
  });

  it('空配列を渡すと position は null、total は 0', () => {
    expect(computeViewerCounter([], 0, new Set(), false)).toEqual({ position: null, total: 0 });
  });
});
