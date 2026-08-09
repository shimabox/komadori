import { describe, expect, it } from 'vitest';
import { computeGifSize } from './gifExport';

describe('computeGifSize', () => {
  it('元幅が最大幅より小さいとき、拡大せず元サイズを返す', () => {
    expect(computeGifSize(320, 180, 640)).toEqual({ width: 320, height: 180 });
  });

  it('元幅が最大幅と等しいとき、拡大せず元サイズを返す', () => {
    expect(computeGifSize(640, 360, 640)).toEqual({ width: 640, height: 360 });
  });

  it('元幅が最大幅より大きいとき、アスペクト比を保って縮小する', () => {
    // 1280x720 -> 幅640に縮小。720 * 640 / 1280 = 360(端数なし)
    expect(computeGifSize(1280, 720, 640)).toEqual({ width: 640, height: 360 });
  });

  it('maxWidthがnullのとき元サイズを返す', () => {
    expect(computeGifSize(1920, 1080, null)).toEqual({ width: 1920, height: 1080 });
  });

  it('高さの端数が丸められる', () => {
    // 1000x333 -> 幅320に縮小。333 * 320 / 1000 = 106.56 -> round -> 107
    expect(computeGifSize(1000, 333, 320)).toEqual({ width: 320, height: 107 });
  });

  it('極端に細長い画像でも高さが1px未満にならない', () => {
    // 2000x1 -> 幅320に縮小すると 1 * 320 / 2000 = 0.16 -> round -> 0 になってしまうため
    // 最小1pxへクランプされる
    expect(computeGifSize(2000, 1, 320)).toEqual({ width: 320, height: 1 });
  });
});
