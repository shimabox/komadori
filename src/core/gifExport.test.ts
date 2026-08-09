import { GIFEncoder } from 'gifenc';
import { describe, expect, it } from 'vitest';
import {
  computeGifSize,
  createGifChunkWriter,
  findTransparentPaletteIndex,
  hasTransparentPixel,
} from './gifExport';

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

describe('hasTransparentPixel', () => {
  it('全画素が不透明(alpha=255)なら false を返す', () => {
    // 2画素分の RGBA。どちらも alpha=255
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(hasTransparentPixel(rgba)).toBe(false);
  });

  it('1画素でも alpha<255 の画素があれば true を返す', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]);
    expect(hasTransparentPixel(rgba)).toBe(true);
  });

  it('完全に透明(alpha=0)な画素があっても true を返す', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 0]);
    expect(hasTransparentPixel(rgba)).toBe(true);
  });

  it('空配列のとき false を返す', () => {
    expect(hasTransparentPixel(new Uint8ClampedArray(0))).toBe(false);
  });

  it('Uint8Array でも同様に判定できる', () => {
    const rgba = new Uint8Array([10, 20, 30, 40]);
    expect(hasTransparentPixel(rgba)).toBe(true);
  });
});

describe('findTransparentPaletteIndex', () => {
  it('アルファ0のエントリがあればそのインデックスを返す', () => {
    const palette: [number, number, number, number][] = [
      [255, 0, 0, 255],
      [0, 255, 0, 0],
      [0, 0, 255, 255],
    ];
    expect(findTransparentPaletteIndex(palette)).toBe(1);
  });

  it('アルファ0のエントリが複数あれば最初のインデックスを返す', () => {
    const palette: [number, number, number, number][] = [
      [255, 0, 0, 255],
      [0, 255, 0, 0],
      [0, 0, 255, 0],
    ];
    expect(findTransparentPaletteIndex(palette)).toBe(1);
  });

  it('アルファ0のエントリがなければ null を返す', () => {
    const palette: [number, number, number, number][] = [
      [255, 0, 0, 255],
      [0, 255, 0, 128],
    ];
    expect(findTransparentPaletteIndex(palette)).toBeNull();
  });

  it('3要素(RGB)のパレットであれば null を返す', () => {
    const palette: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
    ];
    expect(findTransparentPaletteIndex(palette)).toBeNull();
  });

  it('空のパレットであれば null を返す', () => {
    expect(findTransparentPaletteIndex([])).toBeNull();
  });
});

/**
 * P3(gifenc の内部バッファ分割出力)の回帰テスト。
 *
 * createGifChunkWriter は gif.stream.reset() という README に明記されていない
 * 準内部 API に依存しているため、gifenc がバージョンアップして reset() の
 * 挙動が変わった場合にここで検知できるようにする。
 *
 * 「一括版」(GIFEncoder に全フレームを書いてから bytesView を1回だけ取る)と
 * 「分割版」(フレームを書くたびに bytesView を取って gif.stream.reset() する)
 * が、同じフレーム列に対してバイト単位で完全に同じ出力になることを検証する。
 */
describe('GIF チャンク分割出力の回帰テスト', () => {
  // canvas 非依存。インデックス化済みのビットマップとパレットを手で組み立てる。
  const width = 2;
  const height = 2;
  const palette: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  const frames: Uint8Array[] = [
    new Uint8Array([0, 1, 2, 3]),
    new Uint8Array([3, 2, 1, 0]),
    new Uint8Array([1, 1, 2, 2]),
  ];

  async function encodeBulk(): Promise<Uint8Array> {
    const gif = GIFEncoder();
    frames.forEach((indexed, i) => {
      gif.writeFrame(indexed, width, height, {
        palette,
        delay: 100,
        ...(i === 0 ? { repeat: 0 } : {}),
      });
    });
    gif.finish();
    return gif.bytes();
  }

  async function encodeChunked(): Promise<Uint8Array> {
    // createGifEncoder は canvas/ImageBitmap に依存し Node 環境では使えないが、
    // createGifChunkWriter はインデックス化済みのビットマップとパレットだけを
    // 受け取る canvas 非依存の関数なので、ここで直接呼び出せる。
    const writer = createGifChunkWriter();
    frames.forEach((indexed, i) => {
      writer.writeFrame(indexed, width, height, {
        palette,
        delay: 100,
        ...(i === 0 ? { repeat: 0 } : {}),
      });
    });
    const blob = writer.finish();
    return new Uint8Array(await blob.arrayBuffer());
  }

  it('一括版と分割版の出力バイトが完全に一致する', async () => {
    const bulk = await encodeBulk();
    const chunked = await encodeChunked();
    expect(Array.from(chunked)).toEqual(Array.from(bulk));
  });
});
