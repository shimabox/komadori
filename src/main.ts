import './style.css';
import { extractChangedFrames } from './core/extractor';
import type { FrameSource } from './core/frameSource';
import { createGifEncoder } from './core/gifExport';
import { GifSource } from './core/gifSource';
import type { SampledFrame } from './core/types';
import { VideoSource } from './core/videoSource';
import { createZip } from './core/zip';
import { createDropzone } from './ui/dropzone';
import { createNotice } from './ui/notice';
import { createProgressPanel } from './ui/progressPanel';
import { createResultsList } from './ui/resultsList';
import { createSettingsPanel } from './ui/settingsPanel';
import { createViewer } from './ui/viewer';
import type { ViewerFrameData } from './ui/viewer';
import { computeViewerCounter, findAdjacentFrame } from './ui/viewerNav';
import type { ViewerNavDirection } from './ui/viewerNav';

const DEFAULT_THRESHOLD_PERCENT = 3;
const DEFAULT_INTERVAL_MS = 200;
const MAX_SAMPLES = 600;
const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;
const GIF_EXTENSION = /\.gif$/i;
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|avi|mkv|ogv|ogg)$/i;
/** viewer 用フル解像度キャッシュ(frameIndex -> objectURL)の上限件数。超過分は古い順に revoke する */
const FULL_RES_CACHE_LIMIT = 20;

type FileKind = 'gif' | 'video' | 'unknown';

function detectFileKind(file: File): FileKind {
  if (file.type === 'image/gif' || GIF_EXTENSION.test(file.name)) {
    return 'gif';
  }
  if (file.type.startsWith('video/') || VIDEO_EXTENSION.test(file.name)) {
    return 'video';
  }
  return 'unknown';
}

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

function formatFileTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mss = String(millis).padStart(3, '0');
  return `${mm}m${ss}s${mss}`;
}

/** ファイル名規則: {4桁ゼロ埋め連番}_{mm}m{ss}s{ミリ秒3桁}.png */
function buildFrameFileName(sequence: number, timestampMs: number): string {
  const seq = String(sequence).padStart(4, '0');
  return `${seq}_${formatFileTimestamp(timestampMs)}.png`;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // 即時に revoke するとダウンロードが開始する前に無効化されてしまうブラウザがあるため、
  // 少し遅らせてから解放する。
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const appRootMaybe = document.querySelector<HTMLDivElement>('#app');
if (!appRootMaybe) {
  throw new Error('#app 要素が見つかりません');
}
// `requireSlot` などのクロージャから参照する際も non-null と分かるよう束縛し直す
const appRoot: HTMLDivElement = appRootMaybe;

appRoot.innerHTML = `
  <div class="app-shell">
    <header class="app-header">
      <h1 class="app-title">komadori</h1>
      <p class="app-tagline">
        動画・GIF の「変化点」フレームだけを検出し、静止画やアニメーションGIFとして抽出・ダウンロードします。
      </p>
    </header>
    <main class="app-main">
      <div data-slot="dropzone"></div>
      <div data-slot="notice"></div>
      <div data-slot="settings"></div>
      <div data-slot="progress"></div>
      <div data-slot="results"></div>
    </main>
    <footer class="app-footer">
      <p>読み込んだファイルはサーバーに送信されません。解析・抽出はすべてこのブラウザの中だけで行われます。</p>
    </footer>
    <div data-slot="viewer"></div>
  </div>
`;

function requireSlot(name: string): HTMLElement {
  const el = appRoot.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!el) {
    throw new Error(`data-slot="${name}" が見つかりません`);
  }
  return el;
}

// ---- アプリケーション状態 ----
// (単一ファイル・単一スキャンの単純な状態遷移。新しいファイルが読み込まれるたびに
//  session を進め、進行中の古いスキャンからの書き込みを無視できるようにする)
let frameSource: FrameSource | null = null;
let frames: SampledFrame[] = [];
let selected = new Set<number>();
let currentFileBaseName = 'frames';
let abortController: AbortController | null = null;
let currentSession = 0;

// ---- viewer(ライトボックス)関連の状態 ----
// viewer が表示中のフレームの index。閉じている間は null。
let viewerOpenFrameIndex: number | null = null;
// viewer 内「採用のみ表示」トグルの現在値(オーナーは main.ts。前後送りの
// 対象決定に使うため、viewer からの通知をここへミラーする)。
let viewerAdoptedOnly = false;
// frameIndex -> サムネイル用 objectURL(表示直後の即時表示用。フル解像度と違い
// 上限は設けず、ファイル切替時にまとめて revoke する)。
const thumbUrlCache = new Map<number, string>();
// frameIndex -> フル解像度 objectURL。上限 FULL_RES_CACHE_LIMIT 件、超過時は古い順に revoke する。
const fullResCache = new Map<number, string>();
// frameIndex -> 生成中の Promise(同じフレームへの renderFull 二重発行を防ぐ)。
const fullResInFlight = new Map<number, Promise<void>>();
// renderFull 呼び出しの直列化キュー。viewer のフル解像度生成と PNG/ZIP
// ダウンロードが同じ FrameSource.renderFull(動画は共有 video 要素のシーク)を
// 使うため、同時実行するとシークが混線する。全呼び出しをこの Promise 経由にする。
let renderQueue: Promise<unknown> = Promise.resolve();

// ---- UI コンポーネントの生成 ----
const notice = createNotice();

const settingsPanel = createSettingsPanel(
  { thresholdPercent: DEFAULT_THRESHOLD_PERCENT, intervalMs: DEFAULT_INTERVAL_MS },
  {
    onThresholdChange: () => applyThreshold(),
  },
);

const progressPanel = createProgressPanel({
  onCancel: () => {
    abortController?.abort();
  },
});

const resultsList = createResultsList({
  onToggle: (frameIndex, adopted) => {
    if (adopted) {
      selected.add(frameIndex);
    } else {
      selected.delete(frameIndex);
    }
    syncViewerDisplay();
  },
  onDownloadOne: (frameIndex) => {
    void downloadOne(frameIndex);
  },
  onDownloadZip: () => {
    void downloadZip();
  },
  onDownloadGif: () => {
    void downloadGif();
  },
  onOpenViewer: (frameIndex, openerElement) => {
    openViewerAt(frameIndex, openerElement);
  },
});

const viewer = createViewer({
  onNavigate: (direction) => navigateViewer(direction),
  onToggleAdopt: (frameIndex, adopted) => {
    if (adopted) {
      selected.add(frameIndex);
    } else {
      selected.delete(frameIndex);
    }
    resultsList.applySelection(selected);
    syncViewerDisplay();
  },
  onAdoptedOnlyChange: (adoptedOnly) => {
    viewerAdoptedOnly = adoptedOnly;
    syncViewerDisplay();
  },
  onDownload: (frameIndex) => {
    void downloadOne(frameIndex);
  },
  onClose: () => {
    viewerOpenFrameIndex = null;
  },
});

const dropzone = createDropzone({
  onFileSelected: (file) => {
    void handleFile(file);
  },
});

requireSlot('dropzone').append(dropzone.element);
requireSlot('notice').append(notice.element);
requireSlot('settings').append(settingsPanel.element);
requireSlot('progress').append(progressPanel.element);
requireSlot('results').append(resultsList.element);
requireSlot('viewer').append(viewer.element);

// ---- しきい値の再評価(再デコードなし) ----
function computeSelection(): Set<number> {
  const threshold = settingsPanel.getThresholdPercent();
  const adopted = extractChangedFrames(frames, threshold);
  return new Set(adopted.map((f) => f.index));
}

function applyThreshold(): void {
  if (frames.length === 0) {
    return;
  }
  selected = computeSelection();
  resultsList.applySelection(selected);
  syncViewerDisplay();
}

// ---- renderFull の直列化キュー ----
// viewer のフル解像度生成と PNG/ZIP ダウンロードが同じ FrameSource.renderFull
// (動画は共有 video 要素のシーク)を使うため、同時実行するとシークが混線する。
// 呼び出し元(downloadOne / downloadZip / viewer 用の ensureFullRes)は
// 必ずこの関数経由で renderFull を呼ぶ。
//
// `session` は呼び出し側が「積んだ時点」の currentSession を渡す。キュー内の
// 順番が回ってきて実際に実行する直前にも session を再確認し、その間に
// ファイルが切り替わっていたら(session !== currentSession)、旧 source の
// renderFull は呼ばずに中断扱いで reject する。旧 source は handleFile で
// 既に dispose 済みの可能性があり、dispose 後の renderFull 挙動は
// FrameSource の実装依存で「速やかに失敗する」保証がないため、そもそも
// 呼び出さないことで新セッションの呼び出しが待たされることを防ぐ。
// reject 後は呼び出し元の既存の `session !== currentSession` ガードが
// 静かに無視する(videoSource 等の中断エラーと同じ扱い)。
function enqueueRenderFull(
  source: FrameSource,
  frame: SampledFrame,
  session: number,
): Promise<Blob> {
  const run = renderQueue.then(() => {
    if (session !== currentSession) {
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
  const source = frameSource;
  if (!source) {
    return;
  }
  const session = currentSession;

  // `task` は下の .then ハンドラ内から参照する(ハンドラは非同期に実行される
  // ため、その時点では既に代入済みで安全)。ファイル切替で fullResInFlight が
  // clearFullResCache() によって一括 clear された後、新セッションが同じ
  // frame.index を再登録している可能性があるため、削除は「自分が登録した
  // エントリの場合のみ」(参照の同一性で判定)行う。こうしないと、遅れて
  // 完了した旧タスクが新エントリを誤って削除し、二重発行防止が壊れる
  // (二重生成されると fullResCache.set の上書きで先行 URL が revoke されずに
  // リークする)。
  const task: Promise<void> = enqueueRenderFull(source, frame, session).then(
    (blob) => {
      if (fullResInFlight.get(frame.index) === task) {
        fullResInFlight.delete(frame.index);
      }
      if (session !== currentSession) {
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
      if (session !== currentSession) {
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
  const frame = frames.find((f) => f.index === frameIndex);
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
    frames,
    viewerOpenFrameIndex,
    direction,
    selected,
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
  const frame = frames.find((f) => f.index === viewerOpenFrameIndex);
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

// ---- ファイル読み込み・スキャン ----
async function handleFile(file: File): Promise<void> {
  const session = ++currentSession;

  // 進行中のスキャンがあれば中断し、状態を初期化する。
  // ここで設定パネルを一旦必ず有効化しておく(非対応形式などスキャンを
  // 開始しない return パスを通っても、直前のスキャンの finally が
  // `session !== currentSession` で復元処理をスキップするため、ここで
  // 復元しないと設定パネルが無効のまま固まってしまう)。実際にスキャンを
  // 開始する場合は、この直後で改めて無効化する。
  abortController?.abort();
  abortController = null;
  frameSource?.dispose();
  frameSource = null;
  frames = [];
  selected = new Set();

  // ファイル切替時は viewer を強制クローズし、フル解像度/サムネイルの
  // objectURL キャッシュを全て revoke する(session ガードパターンを踏襲)。
  closeViewerSilently();
  clearFullResCache();
  clearThumbUrlCache();

  notice.clear();
  resultsList.reset();
  progressPanel.stop();
  settingsPanel.setDisabled(false);
  dropzone.setFileName(file.name);
  currentFileBaseName = stripExtension(file.name) || 'frames';

  if (file.size > LARGE_FILE_WARNING_BYTES) {
    notice.add(
      'warning',
      `ファイルサイズが 500MB を超えています(${formatBytes(file.size)})。処理に時間がかかる場合があります。`,
    );
  }

  const kind = detectFileKind(file);
  if (kind === 'unknown') {
    notice.add(
      'error',
      '対応していないファイル形式です。動画(mp4 / webm / mov など)または GIF ファイルを選択してください。',
    );
    return;
  }

  const source: FrameSource = kind === 'gif' ? new GifSource(file) : new VideoSource(file);
  frameSource = source;

  const controller = new AbortController();
  abortController = controller;

  settingsPanel.setDisabled(true);
  progressPanel.start();

  let scanFailed = false;

  try {
    const scanOptions = {
      intervalMs: settingsPanel.getIntervalMs(),
      maxSamples: MAX_SAMPLES,
      signal: controller.signal,
      onProgress: (sampled: number, estimatedTotal: number) => {
        if (session !== currentSession) {
          return;
        }
        progressPanel.update(sampled, estimatedTotal);
      },
    };

    for await (const frame of source.scan(scanOptions)) {
      if (session !== currentSession) {
        // 新しいファイルに切り替わっている場合は書き込みを中断する
        return;
      }
      frames.push(frame);
      resultsList.appendFrame(frame);
    }
  } catch (error) {
    if (session !== currentSession) {
      return;
    }
    scanFailed = true;
    console.error(error);
    const message = error instanceof Error ? error.message : '不明なエラーが発生しました。';
    notice.add('error', message);
  } finally {
    if (session === currentSession) {
      settingsPanel.setDisabled(false);
      progressPanel.stop();
      if (abortController === controller) {
        abortController = null;
      }
    }
  }

  if (session !== currentSession) {
    return;
  }

  if (frames.length === 0) {
    // scan() が例外を投げた場合は catch 側で既にエラーメッセージを表示済みなので、
    // ここでは正常終了(またはキャンセル)なのに 0 件だった場合だけメッセージを出す。
    if (!scanFailed && !controller.signal.aborted) {
      notice.add(
        'error',
        'フレームを取得できませんでした。ファイルが壊れているか、対応していない形式の可能性があります。',
      );
    }
    return;
  }

  selected = computeSelection();
  resultsList.finalize(selected);
}

// ---- ダウンロード関連 ----

/**
 * ダウンロード対象になっているフレーム群をタイムスタンプ昇順に並べ、1始まりの連番を振る。
 * 個別ダウンロード・ZIP ダウンロードで共通のロジックを使う。
 */
function buildDownloadPlan(
  targetIndices: ReadonlySet<number>,
): Map<number, { sequence: number; frame: SampledFrame }> {
  const group = frames
    .filter((f) => targetIndices.has(f.index))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const plan = new Map<number, { sequence: number; frame: SampledFrame }>();
  group.forEach((frame, i) => {
    plan.set(frame.index, { sequence: i + 1, frame });
  });
  return plan;
}

async function downloadOne(frameIndex: number): Promise<void> {
  // 開始時点の session を束縛しておく。renderFull の完了を待っている間に
  // 別ファイルへ切り替わっていたら(= session がずれていたら)、以降の
  // UI 操作やダウンロードは行わず静かに終了する(新しい画面にエラーを
  // 出さない。切替時に旧 source が dispose され renderFull が失敗しても
  // このチェックで黙って終わる)。
  const session = currentSession;
  const source = frameSource;
  if (!source) {
    return;
  }
  const frame = frames.find((f) => f.index === frameIndex);
  if (!frame) {
    return;
  }

  // 採用中のフレーム群に、ダウンロード対象のフレーム自身も含めて連番を採る
  // (除外中のフレームを個別ダウンロードした場合も、採用フレーム群の中での
  //  時系列順に沿った番号になるようにするため)。
  const targetIndices = new Set(selected);
  targetIndices.add(frameIndex);
  const plan = buildDownloadPlan(targetIndices);
  const sequence = plan.get(frameIndex)?.sequence ?? 1;

  try {
    const blob = await enqueueRenderFull(source, frame, session);
    if (session !== currentSession) {
      return;
    }
    triggerBlobDownload(blob, buildFrameFileName(sequence, frame.timestampMs));
  } catch (error) {
    if (session !== currentSession) {
      return;
    }
    console.error(error);
    notice.add('error', 'PNG の生成に失敗しました。');
  }
}

async function downloadZip(): Promise<void> {
  // downloadOne 同様、開始時点の session とファイル名を束縛する。ZIP 名は
  // 完了時点のグローバル状態(切り替わっているかもしれない)ではなく、
  // ここで束縛した baseName を使う。
  const session = currentSession;
  const baseName = currentFileBaseName;
  const source = frameSource;
  if (!source) {
    return;
  }
  if (selected.size === 0) {
    notice.add('warning', 'ダウンロード対象のフレームが選択されていません。');
    return;
  }

  const plan = buildDownloadPlan(selected);
  const targets = Array.from(plan.values());

  resultsList.setZipButtonEnabled(false);

  try {
    const entries: { filename: string; blob: Blob }[] = [];
    for (let i = 0; i < targets.length; i++) {
      if (session !== currentSession) {
        return;
      }

      const { sequence, frame } = targets[i];
      resultsList.setZipButtonLabel(`生成中… (${i + 1}/${targets.length})`);

      const blob = await enqueueRenderFull(source, frame, session);
      if (session !== currentSession) {
        return;
      }

      entries.push({ filename: buildFrameFileName(sequence, frame.timestampMs), blob });
    }

    if (session !== currentSession) {
      return;
    }
    resultsList.setZipButtonLabel('ZIP にまとめています…');

    const zipBlob = await createZip(entries);
    if (session !== currentSession) {
      return;
    }

    triggerBlobDownload(zipBlob, `${baseName}_frames.zip`);
  } catch (error) {
    if (session !== currentSession) {
      return;
    }
    console.error(error);
    notice.add('error', 'ZIP の生成に失敗しました。');
  } finally {
    // 新セッション側の ZIP ボタンは handleFile 冒頭の resultsList.reset() /
    // finalize() が初期化・復元する前提なので、旧セッションの後始末で
    // 新しい画面の状態を上書きしないようにする。
    if (session === currentSession) {
      resultsList.resetZipButtonLabel();
      resultsList.setZipButtonEnabled(true);
    }
  }
}

async function downloadGif(): Promise<void> {
  // downloadZip 同様、開始時点の session とファイル名を束縛する。GIF 名は
  // 完了時点のグローバル状態(切り替わっているかもしれない)ではなく、
  // ここで束縛した baseName を使う。
  const session = currentSession;
  const baseName = currentFileBaseName;
  const source = frameSource;
  if (!source) {
    return;
  }
  if (selected.size === 0) {
    notice.add('warning', 'ダウンロード対象のフレームが選択されていません。');
    return;
  }

  const plan = buildDownloadPlan(selected);
  const targets = Array.from(plan.values());
  const { delayMs, maxWidth, maxColors } = settingsPanel.getGifOptions();
  const encoder = createGifEncoder({ maxWidth, maxColors });

  resultsList.setGifButtonEnabled(false);

  try {
    for (let i = 0; i < targets.length; i++) {
      if (session !== currentSession) {
        return;
      }

      const { frame } = targets[i];
      resultsList.setGifButtonLabel(`生成中… (${i + 1}/${targets.length})`);

      const blob = await enqueueRenderFull(source, frame, session);
      if (session !== currentSession) {
        return;
      }

      // フル解像度 PNG をまとめて溜め込まず、1枚取得するたびに縮小・量子化して
      // エンコーダへ渡す(gifExport 側の設計。メモリ使用量を抑えるため)。
      await encoder.addFrame(blob, delayMs);
    }

    if (session !== currentSession) {
      return;
    }
    resultsList.setGifButtonLabel('GIF を書き出しています…');

    const gifBlob = encoder.finish();
    if (session !== currentSession) {
      return;
    }

    triggerBlobDownload(gifBlob, `${baseName}_frames.gif`);
  } catch (error) {
    if (session !== currentSession) {
      return;
    }
    console.error(error);
    notice.add('error', 'GIF の生成に失敗しました。');
  } finally {
    // 新セッション側の GIF ボタンは handleFile 冒頭の resultsList.reset() /
    // finalize() が初期化・復元する前提なので、旧セッションの後始末で
    // 新しい画面の状態を上書きしないようにする。
    if (session === currentSession) {
      resultsList.resetGifButtonLabel();
      resultsList.setGifButtonEnabled(true);
    }
  }
}
