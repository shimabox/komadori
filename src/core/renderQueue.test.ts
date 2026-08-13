import { describe, expect, it, vi } from 'vitest';
import { createRenderQueue } from './renderQueue';
import type { FrameSource } from './frameSource';
import type { SampledFrame } from './types';

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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** renderFull の解決/拒否を外側から制御できる偽の FrameSource */
function makeFakeSource(renderFull: FrameSource['renderFull']): FrameSource {
  return {
    scan: async function* () {
      // no-op
    },
    renderFull,
    dispose: () => {},
  };
}

describe('createRenderQueue', () => {
  it('複数の呼び出しが直列に実行される(2つ目は1つ目が解決するまで呼ばれない)', async () => {
    const first = deferred<Blob>();
    const calls: number[] = [];
    const renderFull = vi.fn((frame: SampledFrame) => {
      calls.push(frame.index);
      return frame.index === 0 ? first.promise : Promise.resolve(new Blob());
    });
    const source = makeFakeSource(renderFull);
    const queue = createRenderQueue({ getSession: () => 1 });

    const p1 = queue.enqueue(source, makeFrame(0), 1);
    const p2 = queue.enqueue(source, makeFrame(1), 1);

    // 1つ目がまだ解決していない間は、2つ目の renderFull は呼ばれない
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([0]);

    first.resolve(new Blob());
    await p1;
    await p2;

    expect(calls).toEqual([0, 1]);
  });

  it('直前の呼び出しがrejectしても次の呼び出しが実行される', async () => {
    const renderFull = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(new Blob());
    const source = makeFakeSource(renderFull);
    const queue = createRenderQueue({ getSession: () => 1 });

    const p1 = queue.enqueue(source, makeFrame(0), 1);
    const p2 = queue.enqueue(source, makeFrame(1), 1);

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBeInstanceOf(Blob);
    expect(renderFull).toHaveBeenCalledTimes(2);
  });

  it('積んだ時点とセッションがずれていたらrenderFullが呼ばれずにrejectする', async () => {
    let session = 1;
    const renderFull = vi.fn().mockResolvedValue(new Blob());
    const source = makeFakeSource(renderFull);
    const queue = createRenderQueue({ getSession: () => session });

    session = 2; // enqueue前にセッションが変わっている想定(実行直前の再チェック対象)
    const p = queue.enqueue(source, makeFrame(0), 1);

    await expect(p).rejects.toThrow();
    expect(renderFull).not.toHaveBeenCalled();
  });

  it('rejectされるエラーがAbortErrorである', async () => {
    let session = 1;
    const renderFull = vi.fn().mockResolvedValue(new Blob());
    const source = makeFakeSource(renderFull);
    const queue = createRenderQueue({ getSession: () => session });

    session = 2;
    const p = queue.enqueue(source, makeFrame(0), 1);

    try {
      await p;
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    }
  });
});
