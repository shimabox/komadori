import { zip } from 'fflate';
import type { AsyncZippable } from 'fflate';

/** ZIP に詰める 1 ファイル分の情報 */
export interface ZipSourceEntry {
  /** ZIP 内でのファイル名(フォルダ分けはしない) */
  filename: string;
  /** ファイルの中身(`FrameSource.renderFull` 等で得た PNG Blob) */
  blob: Blob;
}

export interface CreateZipOptions {
  /** 中断シグナル。abort されると生成を打ち切り、AbortError で reject する */
  signal?: AbortSignal;
}

function createAbortError(): DOMException {
  return new DOMException('ZIP の生成がキャンセルされました', 'AbortError');
}

/**
 * fflate の非同期(コールバック)API を Promise でラップする。
 * コールバックの引数型は `zip` の `FlateCallback` からの文脈推論に任せる
 * (手動で `Uint8Array` と注釈すると `ArrayBuffer` 由来の情報が失われ、
 * `Blob` コンストラクタへ渡す際に型エラーになるため)。
 *
 * signal が abort されたら、zip() が返す終了関数(AsyncTerminable)で圧縮処理
 * 自体を止めて AbortError で reject する。終了関数を呼んだ後は fflate 側から
 * コールバックは呼ばれない(型定義に明記)ため、reject はここで自前で行う。
 */
function zipAsync(files: AsyncZippable, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const terminable = zip(files, (err, data) => {
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
    function onAbort(): void {
      terminable();
      reject(createAbortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 複数フレームの PNG Blob から ZIP ファイルを生成する。
 * フォルダ分けはせず、ファイル名をキーにしたフラットな構成にする。
 * options.signal が abort されると AbortError で reject する。
 */
export async function createZip(
  entries: ZipSourceEntry[],
  options?: CreateZipOptions,
): Promise<Blob> {
  const signal = options?.signal;
  const files: AsyncZippable = {};
  for (const entry of entries) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const buffer = await entry.blob.arrayBuffer();
    files[entry.filename] = new Uint8Array(buffer);
  }

  const zippedBytes = await zipAsync(files, signal);
  return new Blob([zippedBytes], { type: 'application/zip' });
}
