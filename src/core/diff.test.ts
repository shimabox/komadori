import { describe, expect, it } from 'vitest';
import { diffPercent, GRAY_GRID_SIZE, toGray64, type ImageDataLike } from './diff';

/** 単色で塗りつぶした ImageDataLike を作る */
function makeSolidImage(
  width: number,
  height: number,
  rgb: [number, number, number],
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
  }
  return { data, width, height };
}

/** 左半分が黒、右半分が白の ImageDataLike を作る */
function makeSplitImage(width: number, height: number): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const value = x < width / 2 ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('toGray64', () => {
  it('出力の長さが 4096 (64x64) になる', () => {
    const image = makeSolidImage(320, 180, [10, 20, 30]);
    const result = toGray64(image);
    expect(result.length).toBe(GRAY_GRID_SIZE * GRAY_GRID_SIZE);
  });

  it('単色画像は全セルが同じ輝度値になる', () => {
    // 0.299*200 + 0.587*100 + 0.114*50 = 124.2 -> round -> 124
    const image = makeSolidImage(256, 128, [200, 100, 50]);
    const result = toGray64(image);
    const expected = Math.round(0.299 * 200 + 0.587 * 100 + 0.114 * 50);
    expect(result.every((v) => v === expected)).toBe(true);
  });

  it('左右で明暗が分かれた画像は、左端のセルが暗く右端のセルが明るくなる', () => {
    const image = makeSplitImage(128, 64);
    const result = toGray64(image);
    // 出力は 64x64。各行の左端セル(黒側)と右端セル(白側)を比較する。
    for (let gy = 0; gy < GRAY_GRID_SIZE; gy++) {
      const leftCell = result[gy * GRAY_GRID_SIZE + 0];
      const rightCell = result[gy * GRAY_GRID_SIZE + (GRAY_GRID_SIZE - 1)];
      expect(leftCell).toBe(0);
      expect(rightCell).toBe(255);
    }
  });

  it('幅・高さが 0 の場合は例外を投げず全 0 の配列を返す', () => {
    const result = toGray64({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    expect(result.length).toBe(GRAY_GRID_SIZE * GRAY_GRID_SIZE);
    expect(result.every((v) => v === 0)).toBe(true);
  });
});

describe('diffPercent', () => {
  it('同一配列同士なら差分は 0% になる', () => {
    const a = new Uint8Array(4096).fill(123);
    const b = new Uint8Array(4096).fill(123);
    expect(diffPercent(a, b)).toBe(0);
  });

  it('全画素が 0 と 255 なら差分は 100% になる', () => {
    const a = new Uint8Array(4096).fill(0);
    const b = new Uint8Array(4096).fill(255);
    expect(diffPercent(a, b)).toBe(100);
  });

  it('既知の入力に対して妥当な差分率を返す', () => {
    const a = new Uint8Array(4096).fill(0);
    const b = new Uint8Array(4096).fill(51); // 51/255 = 20%
    expect(diffPercent(a, b)).toBeCloseTo(20, 5);
  });

  it('一部の画素だけが異なる場合、その割合に応じた差分率になる', () => {
    const a = new Uint8Array(4096).fill(0);
    const b = new Uint8Array(4096).fill(0);
    // 半分の画素だけ最大差分(255)にする -> 平均は 255 * 0.5 = 127.5 -> 50%
    for (let i = 0; i < 2048; i++) {
      b[i] = 255;
    }
    expect(diffPercent(a, b)).toBeCloseTo(50, 5);
  });
});
