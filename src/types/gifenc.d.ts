/**
 * `gifenc`(v1.0.3)には型定義が同梱されていない(package.json に `types` フィールドが
 * なく、`node_modules/gifenc` に `.d.ts` も存在しない。DefinitelyTyped にも
 * `@types/gifenc` はない)。そのため、実際に使う API(GIFEncoder / quantize /
 * applyPalette)だけを、README(node_modules/gifenc/README.md)の記載に合わせて
 * 最小限の範囲でアンビエント宣言する。
 */
declare module 'gifenc' {
  /** quantize / applyPalette が扱う色フォーマット */
  export type GifencColorFormat = 'rgb565' | 'rgb444' | 'rgba4444';

  /** パレット中の1色。format が rgba4444 のときのみ4要素(RGBA)になる */
  export type GifencColor = [number, number, number] | [number, number, number, number];

  export interface QuantizeOptions {
    /** 色フォーマット(既定 'rgb565') */
    format?: GifencColorFormat;
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  /** RGBA ピクセル列から最大 maxColors 色のパレットを生成する */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): GifencColor[];

  /** RGBA ピクセル列を、パレット中の最も近い色のインデックス列に変換する */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifencColor[],
    format?: GifencColorFormat,
  ): Uint8Array;

  export interface WriteFrameOptions {
    /** このフレームのカラーテーブル。先頭フレームでは必須 */
    palette?: GifencColor[];
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    /** フレーム表示時間(ミリ秒) */
    delay?: number;
    /** ループ回数。-1 = 1回のみ、0 = 無限ループ */
    repeat?: number;
    dispose?: number;
  }

  export interface GIFEncoderOptions {
    auto?: boolean;
    initialCapacity?: number;
  }

  /**
   * `gif.stream` が公開する内部ストリーム API。README には
   * `writeByte`/`writeBytes` のみ記載されているが、実体(dist/gifenc.esm.js
   * の `F()`)は `bytesView()`/`reset()` も持つ。フレームごとの分割出力
   * (gifExport.ts の `createGifChunkWriter`)で、`gif.reset()` ではなく
   * こちらの `reset()`(書き込みカーソルのみを戻す)を使うために必要な範囲
   * だけ宣言する。
   */
  export interface GifencStream {
    /** 内部バッファへの直接ビュー(コピーなし)を返す */
    bytesView(): Uint8Array<ArrayBuffer>;
    /** 書き込みカーソルだけを0へ戻す(ヘッダ書き込み済みフラグには触れない) */
    reset(): void;
    writeByte(value: number): void;
    writeBytes(bytes: Uint8Array, offset?: number, byteLength?: number): void;
  }

  export interface GIFEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void;
    finish(): void;
    /** 内部バッファのコピーを返す。`Blob` コンストラクタへそのまま渡せるよう
     *  `ArrayBuffer` 裏付けであることを明示する(`buffer` プロパティの型が
     *  `ArrayBuffer` である `gif.buffer` に由来するため、実体とも整合する) */
    bytes(): Uint8Array<ArrayBuffer>;
    /** 内部バッファへの直接ビュー(コピーなし)を返す */
    bytesView(): Uint8Array<ArrayBuffer>;
    writeHeader(): void;
    reset(): void;
    readonly buffer: ArrayBuffer;
    /** 内部ストリームサブ API。`gif.reset()` とは異なる「巻き戻し」の粒度を持つ */
    readonly stream: GifencStream;
  }

  export function GIFEncoder(options?: GIFEncoderOptions): GIFEncoderInstance;
}
