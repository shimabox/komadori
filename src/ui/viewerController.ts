import type { FrameSource } from '../core/frameSource';
import type { SampledFrame } from '../core/types';
import { createViewer } from './viewer';
import type { ViewerFrameData } from './viewer';
import { computeViewerCounter, findAdjacentFrame } from './viewerNav';
import type { ViewerNavDirection } from './viewerNav';

/** viewer 用フル解像度キャッシュ(frameIndex -> objectURL)の上限件数。超過分は古い順に revoke する */
const FULL_RES_CACHE_LIMIT = 20;

export interface ViewerControllerDeps {
  getFrames: () => SampledFrame[];
  getSelected: () => ReadonlySet<number>;
  getSession: () => number;
  getFrameSource: () => FrameSource | null;
  enqueueRenderFull: (source: FrameSource, frame: SampledFrame, session: number) => Promise<Blob>;
  /** viewer 内の採用チェックボックス切替時に呼ぶ。selected の更新・resultsList への反映は呼び出し側(main.ts)が行う */
  onToggleAdopt: (frameIndex: number, adopted: boolean) => void;
  /** viewer の PNG 保存ボタン押下時に呼ぶ */
  onDownload: (frameIndex: number) => void;
}

export interface ViewerController {
  element: HTMLElement;
  /** サムネイルクリック・「ビューアで見る」ボタンから viewer を開く */
  openAt(frameIndex: number, openerElement: HTMLElement): void;
  /**
   * viewer が開いている間に、しきい値変更・採用切替などで表示内容が
   * 古くなった際に呼ぶ。viewer が閉じていれば何もしない。
   */
  sync(): void;
  /** viewer を(閉じるコールバックを発火させずに)強制的に閉じる。ファイル切替時に使う */
  closeSilently(): void;
  /** フル解像度・サムネイルの objectURL キャッシュを両方とも解放する。ファイル切替時に使う */
  clearCaches(): void;
}

/** ビューア(ライトボックス)の状態・objectURL キャッシュ・前後送りなどの制御をまとめて持つコントローラを作る */
export function createViewerController(deps: ViewerControllerDeps): ViewerController {
  // ---- viewer(ライトボックス)関連の状態 ----
  // viewer が表示中のフレームの index。閉じている間は null。
  let viewerOpenFrameIndex: number | null = null;
  // viewer 内「採用のみ表示」トグルの現在値(オーナーはこのコントローラ。前後送りの
  // 対象決定に使うため、viewer からの通知をここへミラーする)。
  let viewerAdoptedOnly = false;
  // frameIndex -> サムネイル用 objectURL(表示直後の即時表示用。フル解像度と違い
  // 上限は設けず、ファイル切替時にまとめて revoke する)。
  const thumbUrlCache = new Map<number, string>();
  // frameIndex -> フル解像度 objectURL。上限 FULL_RES_CACHE_LIMIT 件、超過時は古い順に revoke する。
  const fullResCache = new Map<number, string>();
  // frameIndex -> 生成中の Promise(同じフレームへの renderFull 二重発行を防ぐ)。
  const fullResInFlight = new Map<number, Promise<void>>();

  // ---- viewer のフル解像度キャッシュ ----
  function addToFullResCache(frameIndex: number, url: string): void {
    fullResCache.set(frameIndex, url);
    if (fullResCache.size <= FULL_RES_CACHE_LIMIT) {
      return;
    }
    // 古い順(Map の挿入順)に revoke するが、viewer が表示中のフレームだけは
    // 追い出し対象から除外する(除外しないと、高速送りでキューに溜まった
    // 生成タスクが後から完了した際に、いま見ている画像の URL が追い出されて
    // しまい得るため)。表示中フレームをスキップしてもなお上限を超えていれば
    // 次に古いものを追い出す。
    for (const [candidateIndex, candidateUrl] of fullResCache) {
      if (fullResCache.size <= FULL_RES_CACHE_LIMIT) {
        break;
      }
      if (candidateIndex === viewerOpenFrameIndex) {
        continue;
      }
      fullResCache.delete(candidateIndex);
      URL.revokeObjectURL(candidateUrl);
    }
  }

  function clearFullResCache(): void {
    for (const url of fullResCache.values()) {
      URL.revokeObjectURL(url);
    }
    fullResCache.clear();
    fullResInFlight.clear();
  }

  function clearThumbUrlCache(): void {
    for (const url of thumbUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    thumbUrlCache.clear();
  }

  function getViewerThumbUrl(frame: SampledFrame): string {
    let url = thumbUrlCache.get(frame.index);
    if (!url) {
      url = URL.createObjectURL(frame.thumbnail);
      thumbUrlCache.set(frame.index, url);
    }
    return url;
  }

  /**
   * 指定フレームのフル解像度が未取得・未生成中であれば、直列化キュー経由で
   * 生成を開始する。完了時、まだそのフレームが viewer に表示中であれば
   * (表示中フレームと生成完了フレームが一致する場合のみ)差し替える。
   * 高速送り中に古いフレームの生成が遅れて完了しても、現在の表示を
   * 上書きしないようにするためのトークン代わりに `viewerOpenFrameIndex` の
   * 一致チェックを使う。
   */
  function ensureFullRes(frame: SampledFrame): void {
    if (fullResCache.has(frame.index) || fullResInFlight.has(frame.index)) {
      return;
    }
    const source = deps.getFrameSource();
    if (!source) {
      return;
    }
    const session = deps.getSession();

    // `task` は下の .then ハンドラ内から参照する(ハンドラは非同期に実行される
    // ため、その時点では既に代入済みで安全)。ファイル切替で fullResInFlight が
    // clearFullResCache() によって一括 clear された後、新セッションが同じ
    // frame.index を再登録している可能性があるため、削除は「自分が登録した
    // エントリの場合のみ」(参照の同一性で判定)行う。こうしないと、遅れて
    // 完了した旧タスクが新エントリを誤って削除し、二重発行防止が壊れる
    // (二重生成されると fullResCache.set の上書きで先行 URL が revoke されずに
    // リークする)。
    const task: Promise<void> = deps.enqueueRenderFull(source, frame, session).then(
      (blob) => {
        if (fullResInFlight.get(frame.index) === task) {
          fullResInFlight.delete(frame.index);
        }
        if (session !== deps.getSession()) {
          return;
        }
        const url = URL.createObjectURL(blob);
        addToFullResCache(frame.index, url);
        if (viewerOpenFrameIndex === frame.index && viewer.isOpen()) {
          viewer.applyFullImage(url);
        }
      },
      (error) => {
        // in-flight から外してから再描画する。先に外しておかないと、
        // buildViewerFrameData の isLoadingFull が「まだ生成中」のままになり、
        // ローディング表示が消えなくなってしまう。
        if (fullResInFlight.get(frame.index) === task) {
          fullResInFlight.delete(frame.index);
        }
        if (session !== deps.getSession()) {
          return;
        }
        console.error(error);
        // フル解像度の取得に失敗した場合はサムネイル表示のまま。次回このフレームを
        // 表示した際は(fullResInFlight にエントリが残っていないため)再試行される。
        if (viewerOpenFrameIndex === frame.index && viewer.isOpen()) {
          viewer.update(buildViewerFrameData(frame));
        }
      },
    );

    fullResInFlight.set(frame.index, task);
  }

  /** 現在の frames / selected / viewerAdoptedOnly から、viewer に渡す表示データを組み立てる */
  function buildViewerFrameData(frame: SampledFrame): ViewerFrameData {
    const frames = deps.getFrames();
    const selected = deps.getSelected();
    // カウンタ(「n / 総数」)は「採用のみ表示」の状態に応じて基準を切り替える。
    // OFF なら全フレーム基準、ON なら採用フレーム基準(findAdjacentFrame と同じ
    // プール定義を使う純関数)。
    const { position, total } = computeViewerCounter(
      frames,
      frame.index,
      selected,
      viewerAdoptedOnly,
    );
    const hasPrev =
      findAdjacentFrame(frames, frame.index, 'prev', selected, viewerAdoptedOnly) !== null;
    const hasNext =
      findAdjacentFrame(frames, frame.index, 'next', selected, viewerAdoptedOnly) !== null;
    const cachedUrl = fullResCache.get(frame.index);

    return {
      frameIndex: frame.index,
      position,
      total,
      timestampMs: frame.timestampMs,
      imageUrl: cachedUrl ?? getViewerThumbUrl(frame),
      adopted: selected.has(frame.index),
      hasPrev,
      hasNext,
      adoptedCount: selected.size,
      isLoadingFull: cachedUrl === undefined && fullResInFlight.has(frame.index),
    };
  }

  /** サムネイルクリック・「ビューアで見る」ボタンから viewer を開く */
  function openViewerAt(frameIndex: number, openerElement: HTMLElement): void {
    const frame = deps.getFrames().find((f) => f.index === frameIndex);
    if (!frame) {
      return;
    }
    viewerOpenFrameIndex = frame.index;
    viewerAdoptedOnly = false;
    ensureFullRes(frame);
    viewer.open(buildViewerFrameData(frame), openerElement);
  }

  /** viewer 内の ← → ボタン/キー操作から呼ばれる */
  function navigateViewer(direction: ViewerNavDirection): void {
    if (viewerOpenFrameIndex === null) {
      return;
    }
    const next = findAdjacentFrame(
      deps.getFrames(),
      viewerOpenFrameIndex,
      direction,
      deps.getSelected(),
      viewerAdoptedOnly,
    );
    if (!next) {
      return;
    }
    viewerOpenFrameIndex = next.index;
    ensureFullRes(next);
    viewer.update(buildViewerFrameData(next));
  }

  /**
   * viewer が開いている間に、しきい値変更・採用切替などで表示内容が
   * 古くなった際に呼ぶ。viewer が閉じていれば何もしない。
   */
  function syncViewerDisplay(): void {
    if (viewerOpenFrameIndex === null) {
      return;
    }
    const frame = deps.getFrames().find((f) => f.index === viewerOpenFrameIndex);
    if (!frame) {
      closeViewerSilently();
      return;
    }
    // 表示中フレームのフル解像度キャッシュが(上限による追い出し等で)無い
    // 状態でここに来ても、フル解像度へ復帰できるようにする。既にキャッシュ
    // 済み・生成中であれば ensureFullRes 内でそのまま no-op になる。
    ensureFullRes(frame);
    viewer.update(buildViewerFrameData(frame));
  }

  /** viewer を(閉じるコールバックを発火させずに)強制的に閉じる。ファイル切替時に使う */
  function closeViewerSilently(): void {
    viewer.close();
    viewerOpenFrameIndex = null;
  }

  const viewer = createViewer({
    onNavigate: (direction) => navigateViewer(direction),
    onToggleAdopt: (frameIndex, adopted) => {
      deps.onToggleAdopt(frameIndex, adopted);
      syncViewerDisplay();
    },
    onAdoptedOnlyChange: (adoptedOnly) => {
      viewerAdoptedOnly = adoptedOnly;
      syncViewerDisplay();
    },
    onDownload: (frameIndex) => {
      deps.onDownload(frameIndex);
    },
    onClose: () => {
      viewerOpenFrameIndex = null;
    },
  });

  return {
    element: viewer.element,
    openAt: openViewerAt,
    sync: syncViewerDisplay,
    closeSilently: closeViewerSilently,
    clearCaches: () => {
      clearFullResCache();
      clearThumbUrlCache();
    },
  };
}
