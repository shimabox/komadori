import { zip } from 'fflate';
import type { AsyncZippable } from 'fflate';

/** ZIP に詰める 1 ファイル分の情報 */
export interface ZipSourceEntry {
  /** ZIP 内でのファイル名(フォルダ分けはしない) */
  filename: string;
  /** ファイルの中身(`FrameSource.renderFull` 等で得た PNG Blob) */
  blob: Blob;
}

/**
 * fflate の非同期(コールバック)API を Promise でラップする。
 * コールバックの引数型は `zip` の `FlateCallback` からの文脈推論に任せる
 * (手動で `Uint8Array` と注釈すると `ArrayBuffer` 由来の情報が失われ、
 * `Blob` コンストラクタへ渡す際に型エラーになるため)。
 */
function zipAsync(files: AsyncZippable): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    zip(files, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });
}

/**
 * 複数フレームの PNG Blob から ZIP ファイルを生成する。
 * フォルダ分けはせず、ファイル名をキーにしたフラットな構成にする。
 */
export async function createZip(entries: ZipSourceEntry[]): Promise<Blob> {
  const files: AsyncZippable = {};
  for (const entry of entries) {
    const buffer = await entry.blob.arrayBuffer();
    files[entry.filename] = new Uint8Array(buffer);
  }

  const zippedBytes = await zipAsync(files);
  return new Blob([zippedBytes], { type: 'application/zip' });
}
