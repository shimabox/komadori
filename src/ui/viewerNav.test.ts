import { describe, expect, it } from 'vitest';
import { findAdjacentFrame } from './viewerNav';
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
