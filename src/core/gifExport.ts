import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { GifencColor, GifencColorFormat, WriteFrameOptions } from 'gifenc';

/** 不透明フレームの quantize / applyPalette フォーマット。両者で必ず同じ値を使う必要がある */
const OPAQUE_FORMAT: GifencColorFormat = 'rgb565';
/**
 * 透明画素を含むフレームの quantize / applyPalette フォーマット。
 * GIF が持てる透過は1ビット(不透明/透明の2値)だけなので、量子化時は
 * `oneBitAlpha: true` と組み合わせて使う。
 */
const TRANSPARENT_FORMAT: GifencColorFormat = 'rgba4444';

export interface GifEncodeOptions {
  /** 出力の最大幅(px)。null はフル解像度(縮小しない) */
  maxWidth: number | null;
  /** 量子化の最大色数 */
  maxColors: number;
}

export interface GifEncoderHandle {
  /** 1フレーム分の PNG Blob をデコードし、GIF ストリームへ1フレーム書き込む */
  addFrame(pngBlob: Blob, delayMs: number): Promise<void>;
  /** ストリームを終端し、GIF 全体を表す Blob を返す */
  finish(): Blob;
}

function requireContext(
  canvas: HTMLCanvasElement,
  willReadFrequently = false,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently });
  if (!ctx) {
    throw new Error('2D canvas コンテキストを取得できませんでした');
  }
  return ctx;
}

/**
 * アスペクト比を保ったまま maxWidth に収まるサイズを返す純粋関数。
 *
 * - maxWidth が null、または元幅が maxWidth 以下のときは拡大せず元サイズを返す
 * - 縮小するときは `height = round(srcHeight * width / srcWidth)` で高さを
 *   再計算し、アスペクト比を維持する
 * - 幅・高さとも最小 1px を保証する(極端に細長い画像で 0px にならないようにする)
 */
export function computeGifSize(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number | null,
): { width: number; height: number } {
  if (maxWidth === null || srcWidth <= maxWidth) {
    return { width: Math.max(1, srcWidth), height: Math.max(1, srcHeight) };
  }
  const width = Math.max(1, maxWidth);
  const height = Math.max(1, Math.round((srcHeight * width) / srcWidth));
  return { width, height };
}

/**
 * RGBA ピクセル列を1回走査し、アルファが 255 未満(完全不透明でない)の画素が
 * 1つでもあるかを判定する。動画由来のフレームはほぼ常に false になり、
 * 透過 GIF 由来のフレームだけ true になる。
 */
export function hasTransparentPixel(rgba: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) {
      return true;
    }
  }
  return false;
}

/**
 * 量子化後のパレットから、アルファが 0(完全透明)の最初のエントリの
 * インデックスを探す。RGB(3要素)のパレットや、アルファ0のエントリが
 * 存在しない場合は null を返す(呼び出し側は透過なしにフォールバックする)。
 */
export function findTransparentPaletteIndex(palette: GifencColor[]): number | null {
  for (let i = 0; i < palette.length; i++) {
    const color = palette[i];
    if (color.length === 4 && color[3] === 0) {
      return i;
    }
  }
  return null;
}

/**
 * canvas や ImageBitmap に触れない、GIF ストリームの低レベル書き込み口。
 * インデックス化済みのビットマップとパレットだけを受け取り、フレームを
 * 書き込むたびに直後の内部バッファを Blob チャンクへ吐き出してカーソルを
 * 巻き戻す。これにより gifenc の内部バッファが GIF 全体を溜め込むことを防ぐ
 * (詳細は writeFrame 内のコメントを参照)。
 *
 * canvas に依存しないため、gifExport.test.ts から直接呼び出して
 * 一括版(GIFEncoder に全フレーム書いてから bytesView を1回取る)との
 * 出力バイト一致を検証する回帰テストに使う目的でエクスポートしている。
 */
export function createGifChunkWriter(): {
  writeFrame(indexed: Uint8Array, width: number, height: number, opts: WriteFrameOptions): void;
  finish(): Blob;
} {
  const gif = GIFEncoder();
  const chunks: Blob[] = [];
  // finish() 済みかどうかと、その結果の Blob(finish() を冪等にするために保持する)。
  let finishedBlob: Blob | null = null;

  function flush(): void {
    // bytesView() は内部バッファへの直接ビュー(コピーなし)だが、
    // new Blob([...]) に渡した時点で Blob コンストラクタが同期的に
    // バイト列をコピーするため、この直後に stream.reset() で内部バッファの
    // カーソルを巻き戻して使い回しても、既に積んだ Blob チャンクの内容は
    // 保持される。
    chunks.push(new Blob([gif.stream.bytesView()]));
  }

  function writeFrame(
    indexed: Uint8Array,
    width: number,
    height: number,
    opts: WriteFrameOptions,
  ): void {
    if (finishedBlob) {
      // finish() 後の writeFrame() は呼び出し側のバグである(トレーラーを
      // 書いた後に追記しても壊れた GIF にしかならない)。黙って無視して
      // 気付かれないまま壊れた出力を返すより、ここで例外にして早期に
      // 検知できるようにする。
      throw new Error('createGifChunkWriter: finish() 後に writeFrame() を呼ぶことはできません');
    }
    gif.writeFrame(indexed, width, height, opts);
    flush();
    // gif.reset() ではなく gif.stream.reset() を使う。
    //
    // gif.reset() は内部ストリームのカーソルを巻き戻すだけでなく、GIFEncoder
    // 自身が持つ「ヘッダ(ロジカルスクリーン記述子・グローバルカラーテーブル)
    // を書き込み済み」という内部フラグまでリセットしてしまう。そのため次に
    // writeFrame を呼んだときに auto モードが再び先頭フレーム扱いとなり、
    // ヘッダとグローバルカラーテーブルを2回目以降のフレームにも書き込んで
    // しまい、GIF として壊れたバイト列になる。
    //
    // 一方 gif.stream.reset()(gif.stream が公開する、内部バッファを持つ
    // stream サブオブジェクトの reset)は書き込みカーソルだけを0に戻し、
    // 上記の「ヘッダ書き込み済み」フラグには触れない。そのため2フレーム目
    // 以降も通常どおりフレームデータだけが追記される。gif.stream は README
    // に公開 API として存在は明記されているが、この reset の使い分けは
    // README に明記されていない準内部的な挙動のため、gifExport.test.ts の
    // 回帰テスト(一括版と分割版の出力バイト完全一致)で gifenc の
    // バージョンアップ時にも検知できるようガードしている。
    gif.stream.reset();
  }

  function finish(): Blob {
    // finish() は冪等にする。2回目以降に gif.finish() を再度呼ぶと、
    // トレーラーがもう一度書き込まれ、その時点の(既に空になっている)
    // stream の中身が新しいチャンクとして chunks に重複して積まれてしまい、
    // 壊れた Blob が返ってしまう。そのため初回に生成した Blob を保持して
    // おき、2回目以降は同じ Blob をそのまま返す。
    if (finishedBlob) {
      return finishedBlob;
    }
    gif.finish();
    flush();
    finishedBlob = new Blob(chunks, { type: 'image/gif' });
    return finishedBlob;
  }

  return { writeFrame, finish };
}

/**
 * 採用フレームの PNG を1枚ずつ受け取り、1本のアニメーション GIF へ逐次エンコードする。
 *
 * GIF の論理画面サイズは全フレーム共通である必要があるため、描画用 canvas と
 * 出力サイズは最初の `addFrame` 呼び出し時(= 最初のフレームの寸法から
 * `computeGifSize` で確定)に固定し、以降のフレームは同じサイズへ描画する
 * (GIF ソースのフレームごとに寸法が異なるケースは想定していない)。
 * フル解像度 PNG をまとめてメモリに保持しなくて済むよう、呼び出し元
 * (main.ts の downloadGif)が1フレームずつ渡す前提の設計にしている。
 * GIF ストリーム自体の書き込みも `createGifChunkWriter` を介して行うため、
 * gifenc の内部バッファに GIF 全体を溜め込むこともない。
 */
export function createGifEncoder(opts: GifEncodeOptions): GifEncoderHandle {
  const writer = createGifChunkWriter();
  // canvas・出力サイズは最初のフレームで確定させ、以降は使い回す
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let size: { width: number; height: number } | null = null;
  let frameCount = 0;

  async function addFrame(pngBlob: Blob, delayMs: number): Promise<void> {
    const bitmap = await createImageBitmap(pngBlob);
    try {
      if (!canvas || !ctx || !size) {
        size = computeGifSize(bitmap.width, bitmap.height, opts.maxWidth);
        canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        ctx = requireContext(canvas, true);
      }

      ctx.clearRect(0, 0, size.width, size.height);
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      const imageData = ctx.getImageData(0, 0, size.width, size.height);

      // 透明画素を1つでも含む場合(透過 GIF 由来の入力)だけ rgba4444 +
      // oneBitAlpha に切り替える。透明画素がない場合(動画入力はほぼ常に
      // こちら)は従来どおり rgb565 で量子化し、画質は変えない。
      const transparent = hasTransparentPixel(imageData.data);
      const format = transparent ? TRANSPARENT_FORMAT : OPAQUE_FORMAT;
      const palette = quantize(imageData.data, opts.maxColors, {
        format,
        ...(transparent ? { oneBitAlpha: true } : {}),
      });
      const index = applyPalette(imageData.data, palette, format);

      // 透明画素があってもパレット側にアルファ0のエントリが残らなかった
      // 場合は、透過なしとして扱う(処理を落とさないフォールバック)。
      const transparentIndex = transparent ? findTransparentPaletteIndex(palette) : null;

      writer.writeFrame(index, size.width, size.height, {
        palette,
        delay: delayMs,
        // 無限ループにするための repeat は先頭フレームにのみ指定する
        ...(frameCount === 0 ? { repeat: 0 } : {}),
        // dispose は「このフレームを表示した"後"」の後始末を指定するオプションで、
        // 効果が現れるのは次フレームの描画前である。そのため「透過を使う
        // フレーム自身」に付けても意味がない。例えば不透明なフレームNの次に
        // 透過フレームN+1が来た場合、透過が効くかどうかを左右するのは
        // フレームNのdisposeであり、フレームN+1のdisposeはさらに次(N+2)の
        // ためのものである。透過フレームだけにdisposeを付けると、直前が
        // 不透明フレームだったケースでN+1の透明部分にNの絵が残ってしまう。
        //
        // このエンコーダは各フレームで毎回 canvas 全面を描画し直しており
        // 部分描画はしないため、不透明フレームに dispose: 2(背景色に戻す)を
        // 指定しても見た目は変わらない(次フレームが全面を上書きするため)。
        // よって透過の有無に関わらず、常に dispose: 2 を指定する。
        dispose: 2,
        ...(transparentIndex !== null ? { transparent: true, transparentIndex } : {}),
      });
      frameCount += 1;
    } finally {
      bitmap.close();
    }
  }

  function finish(): Blob {
    return writer.finish();
  }

  return { addFrame, finish };
}
