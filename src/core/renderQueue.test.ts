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

  it('積んだ時点で既にセッションがずれていたらrenderFullが呼ばれずにrejectする', async () => {
    let session = 1;
    const renderFull = vi.fn().mockResolvedValue(new Blob());
    const source = makeFakeSource(renderFull);
    const queue = createRenderQueue({ getSession: () => session });

    session = 2;
    const p = queue.enqueue(source, makeFrame(0), 1);

    await expect(p).rejects.toThrow();
    expect(renderFull).not.toHaveBeenCalled();
  });

  it('キューで待っている間にセッションが切り替わったらrenderFullが呼ばれずにrejectする', async () => {
    // セッションの判定が「積んだ瞬間」ではなく「実行直前」に行われることを固定する。
    // 上のテストは enqueue 前に既にセッションがずれているため、積んだ瞬間に判定する
    // 実装でも通ってしまい、この性質を守れない。ここでは先行タスクでキューを塞ぎ、
    // セッションが一致したまま2件目を積んでから切り替えることで、待ち行列にいる間の
    // 切り替えを再現する。
    let session = 1;
    const first = deferred<Blob>();
    const calls: number[] = [];
    const renderFull = vi.fn((frame: SampledFrame) => {
      calls.push(frame.index);
      return frame.index === 0 ? first.promise : Promise.resolve(new Blob());
    });
    const source = makeFakeSource(renderFull);
    const queue = createRenderQueue({ getSession: () => session });

    // 1件目でキューを塞ぐ。2件目を積む時点ではセッションはまだ一致している。
    const p1 = queue.enqueue(source, makeFrame(0), 1);
    const p2 = queue.enqueue(source, makeFrame(1), 1);

    // 1件目のコールバックが実際に走って renderFull を呼ぶまで待つ。ここで待たずに
    // セッションを変えると、まだ動いていない1件目まで拒否されてしまい、狙った
    // 「2件目だけが待ち行列で拒否される」状況にならない。
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([0]);

    // 2件目が実行される前(= 待ち行列にいる間)にファイルが切り替わった状況。
    session = 2;

    first.resolve(new Blob());
    await expect(p1).resolves.toBeInstanceOf(Blob);
    await expect(p2).rejects.toThrow();

    // 2件目の renderFull は呼ばれない(旧 source は dispose 済みの可能性があるため)。
    expect(calls).toEqual([0]);
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
