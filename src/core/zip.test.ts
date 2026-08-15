import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createZip } from './zip';
import type { ZipSourceEntry } from './zip';

function makeEntry(filename: string, content: string): ZipSourceEntry {
  return { filename, blob: new Blob([content]) };
}

describe('createZip', () => {
  it('渡したエントリをフラットな構成の ZIP にまとめる', async () => {
    const zipBlob = await createZip([makeEntry('a.png', 'aaa'), makeEntry('b.png', 'bbb')]);

    expect(zipBlob.type).toBe('application/zip');
    const unzipped = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()));
    expect(Object.keys(unzipped).sort()).toEqual(['a.png', 'b.png']);
    expect(new TextDecoder().decode(unzipped['a.png'])).toBe('aaa');
    expect(new TextDecoder().decode(unzipped['b.png'])).toBe('bbb');
  });

  it('signal を渡さない従来どおりの呼び出しでも動く', async () => {
    const zipBlob = await createZip([makeEntry('a.png', 'aaa')], {});
    expect(zipBlob.size).toBeGreaterThan(0);
  });

  it('abort 済みの signal を渡すと AbortError で reject する', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      createZip([makeEntry('a.png', 'aaa')], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('生成の途中で abort されても AbortError で reject する', async () => {
    const controller = new AbortController();
    // createZip は最初の await(blob.arrayBuffer)で必ず一度は処理を譲るため、
    // 呼び出し直後に abort すれば「開始後・完了前」の中断を再現できる。
    const promise = createZip(
      [makeEntry('a.png', 'a'.repeat(1024)), makeEntry('b.png', 'b'.repeat(1024))],
      { signal: controller.signal },
    );
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
