import type { FrameSource } from './frameSource';
import type { SampledFrame } from './types';

export interface RenderQueue {
  /** renderFull 呼び出しの直列化キューに積む */
  enqueue(source: FrameSource, frame: SampledFrame, session: number): Promise<Blob>;
}

export interface RenderQueueDeps {
  /** 「積んだ時点」と「実行直前」でセッションがずれていないか確認するために呼ぶ */
  getSession: () => number;
}

/**
 * renderFull の直列化キュー。viewer のフル解像度生成と PNG/ZIP ダウンロードが
 * 同じ FrameSource.renderFull(動画は共有 video 要素のシーク)を使うため、
 * 同時実行するとシークが混線する。呼び出し元(downloadOne / downloadZip /
 * viewer 用の ensureFullRes)は必ずこの enqueue 経由で renderFull を呼ぶ。
 *
 * `session` は呼び出し側が「積んだ時点」の currentSession を渡す。キュー内の
 * 順番が回ってきて実際に実行する直前にも session を再確認し、その間に
 * ファイルが切り替わっていたら(session !== 現在の session)、旧 source の
 * renderFull は呼ばずに中断扱いで reject する。旧 source は handleFile で
 * 既に dispose 済みの可能性があり、dispose 後の renderFull 挙動は
 * FrameSource の実装依存で「速やかに失敗する」保証がないため、そもそも
 * 呼び出さないことで新セッションの呼び出しが待たされることを防ぐ。
 * reject 後は呼び出し元の既存の `session !== currentSession` ガードが
 * 静かに無視する(videoSource 等の中断エラーと同じ扱い)。
 */
export function createRenderQueue(deps: RenderQueueDeps): RenderQueue {
  let renderQueue: Promise<unknown> = Promise.resolve();

  function enqueue(source: FrameSource, frame: SampledFrame, session: number): Promise<Blob> {
    const run = renderQueue.then(() => {
      if (session !== deps.getSession()) {
        return Promise.reject(new DOMException('セッションが切り替わりました', 'AbortError'));
      }
      return source.renderFull(frame);
    });
    // 直前の呼び出しが失敗してもキューは止めず、次の呼び出しへ進む
    renderQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { enqueue };
}
