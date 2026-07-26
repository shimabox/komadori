import { describe, expect, it } from 'vitest';
import {
  diffPercent,
  GRAY_GRID_SIZE,
  NOISE_FLOOR,
  tileDiffPercent,
  toGray64,
  type ImageDataLike,
} from './diff';

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

  it('64x64 より小さい単色画像でも、黒セルが混ざらず全セルが同じ輝度値になる(正方形)', () => {
    // 0.299*10 + 0.587*20 + 0.114*30 = 18.6 -> round -> 19
    const image = makeSolidImage(32, 32, [10, 20, 30]);
    const result = toGray64(image);
    const expected = Math.round(0.299 * 10 + 0.587 * 20 + 0.114 * 30);
    expect(result.every((v) => v === expected)).toBe(true);
  });

  it('64x64 より小さい単色画像でも、黒セルが混ざらず全セルが同じ輝度値になる(非正方形)', () => {
    const image = makeSolidImage(10, 50, [90, 150, 60]);
    const result = toGray64(image);
    const expected = Math.round(0.299 * 90 + 0.587 * 150 + 0.114 * 60);
    expect(result.every((v) => v === expected)).toBe(true);
  });

  it('1x1 の単色画像でも全セルがその画素の輝度値になる', () => {
    const image = makeSolidImage(1, 1, [128, 64, 32]);
    const result = toGray64(image);
    const expected = Math.round(0.299 * 128 + 0.587 * 64 + 0.114 * 32);
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

describe('tileDiffPercent', () => {
  it('(a) 同一入力なら差分は 0% になる', () => {
    const a = new Uint8Array(4096).fill(123);
    const b = new Uint8Array(4096).fill(123);
    expect(tileDiffPercent(a, b)).toBe(0);
  });

  it('(b) 全画素が同量変化する(グローバルな変化)場合、diffPercent と同等のスコアになる', () => {
    const a = new Uint8Array(4096).fill(0);
    const b = new Uint8Array(4096).fill(51); // 51/255 = 20%
    expect(tileDiffPercent(a, b)).toBeCloseTo(20, 5);
    expect(tileDiffPercent(a, b)).toBeCloseTo(diffPercent(a, b), 5);
  });

  it('(c) 1タイル内のみの局所変化は、全体平均に薄められず高スコアになる', () => {
    const a = new Uint8Array(4096).fill(0);
    const b = new Uint8Array(4096).fill(0);

    // 8x8 タイル(64x64 グリッドを 8x8 分割)のうち、
    // 左上から4列目・3行目のタイル(1始まり、x: 24-31, y: 16-23)だけを最大差分にする。
    const tileXStart = 24;
    const tileYStart = 16;
    for (let y = tileYStart; y < tileYStart + 8; y++) {
      for (let x = tileXStart; x < tileXStart + 8; x++) {
        b[y * GRAY_GRID_SIZE + x] = 255;
      }
    }

    const tileScore = tileDiffPercent(a, b);
    const globalScore = diffPercent(a, b);

    // 変化した画素は 4096 画素中 64 画素だけなので、全体平均では大きく薄められる
    // (64*255/4096/255*100 = 1.5625%)。タイル分割ならその局所タイルの平均差分が
    // そのまま最大値として出るため 100% になる。
    expect(globalScore).toBeCloseTo(1.5625, 4);
    expect(tileScore).toBe(100);
    expect(tileScore).toBeGreaterThan(globalScore);
  });

  it('(d) ノイズフロア未満の微小差はスコア 0 になる', () => {
    const a = new Uint8Array(4096).fill(100);

    // NOISE_FLOOR(10) ちょうど未満(絶対差9)は 0 として切り捨てられる
    const bBelowFloor = new Uint8Array(4096).fill(100 + (NOISE_FLOOR - 1));
    expect(tileDiffPercent(a, bBelowFloor)).toBe(0);

    // NOISE_FLOOR ちょうど(絶対差10)は切り捨てられず有効な差分として扱われる
    const bAtFloor = new Uint8Array(4096).fill(100 + NOISE_FLOOR);
    expect(tileDiffPercent(a, bAtFloor)).toBeCloseTo((NOISE_FLOOR / 255) * 100, 5);
  });

  it('(e) 長さが一致しない配列を渡しても例外を投げず、有限の値を返す', () => {
    const a = new Uint8Array(4096).fill(200);
    const shortB = new Uint8Array(2048).fill(0);

    let result = 0;
    expect(() => {
      result = tileDiffPercent(a, shortB);
    }).not.toThrow();
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it('(e) 空配列同士なら差分は 0 になる', () => {
    expect(tileDiffPercent(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });

  it('(e) 片方が空配列の場合も例外を投げず 0 を返す', () => {
    const a = new Uint8Array(4096).fill(200);
    expect(tileDiffPercent(a, new Uint8Array(0))).toBe(0);
  });
});
