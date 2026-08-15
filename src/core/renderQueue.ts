import type { FrameSource } from './frameSource';
import type { SampledFrame } from './types';

export interface RenderQueue {
  /**
   * renderFull 呼び出しの直列化キューに積む。signal を渡すと、キュー内で
   * 待っている間に abort された場合、実行直前の確認で renderFull を呼ばずに
   * AbortError で reject する(ZIP / GIF 書き出しのキャンセル用)
   */
  enqueue(
    source: FrameSource,
    frame: SampledFrame,
    session: number,
    signal?: AbortSignal,
  ): Promise<Blob>;
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
 *
 * `signal` も同様に実行直前に再確認する。呼び出し側(downloadZip / downloadGif)
 * は await の前後で abort を確認しているが、先行する PNG 保存や viewer の
 * フル解像度生成でキューが詰まっている場合、待機中に abort されたタスクが
 * その確認をすり抜けて実行されてしまう。実行直前の確認でそれを防ぎ、
 * キャンセル後に不要な renderFull(大きなフレームでは数秒かかる)を
 * 開始しないようにする。
 */
export function createRenderQueue(deps: RenderQueueDeps): RenderQueue {
  let renderQueue: Promise<unknown> = Promise.resolve();

  function enqueue(
    source: FrameSource,
    frame: SampledFrame,
    session: number,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const run = renderQueue.then(() => {
      if (session !== deps.getSession()) {
        return Promise.reject(new DOMException('セッションが切り替わりました', 'AbortError'));
      }
      if (signal?.aborted) {
        return Promise.reject(new DOMException('書き出しがキャンセルされました', 'AbortError'));
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
