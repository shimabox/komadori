import './style.css';
import { extractChangedFrames } from './core/extractor';
import { buildFrameFileName, detectFileKind, formatBytes, stripExtension } from './core/format';
import type { FrameSource } from './core/frameSource';
import { createGifEncoder } from './core/gifExport';
import { GifSource } from './core/gifSource';
import { createRenderQueue } from './core/renderQueue';
import type { SampledFrame } from './core/types';
import { VideoSource } from './core/videoSource';
import { createZip } from './core/zip';
import { createDropzone } from './ui/dropzone';
import { createNotice } from './ui/notice';
import { createProgressPanel } from './ui/progressPanel';
import { shouldEnableRescan } from './ui/rescan';
import { createResultsList } from './ui/resultsList';
import { createSettingsPanel } from './ui/settingsPanel';
import { createViewerController } from './ui/viewerController';

const DEFAULT_THRESHOLD_PERCENT = 3;
const DEFAULT_INTERVAL_MS = 200;
const MAX_SAMPLES = 600;
const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;

// GIF 書き出しは設定パネルを持たず、以下の固定値で常に生成する(采配役が
// 実測して決定済み。変更しない)。60秒の動画から抽出した約40枚の採用フレームで
// 幅640pxなら約1MB・遅延300msなら12秒の再生になり、長い動画を短いGIFに
// まとめて共有する用途の目安(再生時間5〜15秒程度)に収まる。
const GIF_FRAME_DELAY_MS = 300;
const GIF_MAX_WIDTH_PX = 640;
const GIF_MAX_COLORS = 256;

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
        動画・GIF の「変化点」フレームだけを検出し、静止画として抽出・ダウンロードします。
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
      <p>著作権のある動画・GIF から抽出した画像・GIF は、権利者の許諾の範囲内でご利用ください。</p>
      <nav class="app-footer-links" aria-label="関連リンク">
        <a
          href="https://x.com/shimabox"
          target="_blank"
          rel="me noopener noreferrer"
        >@shimabox</a>
        <span aria-hidden="true">·</span>
        <a
          href="https://github.com/shimabox/komadori"
          target="_blank"
          rel="noopener noreferrer"
        >GitHub</a>
      </nav>
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
// ZIP / GIF 書き出しの中断用。スキャン用の abortController とはライフサイクルが
// 異なる(スキャン完了後にしか書き出しは始まらない)ため別に持つ。書き出し中で
// なければ null。null かどうかで「書き出し進行中か」の判定も兼ねる。
let exportAbortController: AbortController | null = null;
let currentSession = 0;
// 再スキャン用に保持するファイル本体。対応形式であることが確定してから
// (detectFileKind() が 'unknown' でないと分かってから)代入する。非対応形式で
// 早期return するパスでは代入しないことで、無効なファイルを再スキャン対象として
// 抱えないようにする。
let currentFile: File | null = null;
// スキャン開始時に「指定した」サンプリング間隔(settingsPanel.getIntervalMs() の
// 戻り値をそのまま記録する)。MAX_SAMPLES の制約で実際に使われる間隔(実効値)は
// これより広くなることがあるが、再スキャン要否の判定は必ず指定値同士で比較する
// (実効値と比較すると、スキャン直後で何も変えていないのにボタンが有効になって
// しまうため)。未スキャンの間は null。
let scannedIntervalMs: number | null = null;

// renderFull 呼び出しの直列化キュー。viewer のフル解像度生成と PNG/ZIP
// ダウンロードが同じ FrameSource.renderFull(動画は共有 video 要素のシーク)を
// 使うため、同時実行するとシークが混線する。全呼び出しをこの経由にする。
const renderQueue = createRenderQueue({ getSession: () => currentSession });

// ---- UI コンポーネントの生成 ----
const notice = createNotice();

const settingsPanel = createSettingsPanel(
  { thresholdPercent: DEFAULT_THRESHOLD_PERCENT, intervalMs: DEFAULT_INTERVAL_MS },
  {
    onThresholdChange: () => applyThreshold(),
    onIntervalChange: () => updateRescanState(),
    onRescan: () => {
      if (currentFile) {
        void handleFile(currentFile);
      }
    },
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
    viewerController.sync();
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
  onSelectAll: (adopted) => {
    selected = adopted ? new Set(frames.map((f) => f.index)) : new Set();
    resultsList.applySelection(selected);
    viewerController.sync();
  },
  onOpenViewer: (frameIndex, openerElement) => {
    viewerController.openAt(frameIndex, openerElement);
  },
  onCancelExport: () => {
    exportAbortController?.abort();
  },
});

const viewerController = createViewerController({
  getFrames: () => frames,
  getSelected: () => selected,
  getSession: () => currentSession,
  getFrameSource: () => frameSource,
  enqueueRenderFull: (source, frame, session) => enqueueRenderFull(source, frame, session),
  onToggleAdopt: (frameIndex, adopted) => {
    if (adopted) {
      selected.add(frameIndex);
    } else {
      selected.delete(frameIndex);
    }
    resultsList.applySelection(selected);
  },
  onDownload: (frameIndex) => {
    void downloadOne(frameIndex);
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
requireSlot('viewer').append(viewerController.element);

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
  viewerController.sync();
}

// ---- 再スキャンボタンの有効/無効の反映 ----
// 間隔入力の変更時・スキャン完了時(および早期returnで終わった場合)に呼び、
// 実態(currentFile の有無、直前にスキャンした指定間隔、現在の入力値)から
// shouldEnableRescan() で有効/無効を判定して settingsPanel へ反映する。
// スキャン中の一時的な無効化は settingsPanel.setDisabled() が別途担当するため、
// ここでは「スキャンしていない前提での本来あるべき状態」だけを渡せばよい。
function updateRescanState(): void {
  const enabled = shouldEnableRescan(
    currentFile !== null,
    scannedIntervalMs,
    settingsPanel.getIntervalMs(),
  );
  settingsPanel.setRescanEnabled(enabled);
}

// ---- renderFull の直列化キュー ----
// viewer のフル解像度生成と PNG/ZIP ダウンロードが同じ FrameSource.renderFull
// (動画は共有 video 要素のシーク)を使うため、同時実行するとシークが混線する。
// 呼び出し元(downloadOne / downloadZip / viewer 用の ensureFullRes)は
// 必ずこの関数経由で renderFull を呼ぶ。直列化・セッション再確認・
// signal(書き出しキャンセル)再確認の詳細な挙動と理由は
// core/renderQueue.ts のコメントを参照。
function enqueueRenderFull(
  source: FrameSource,
  frame: SampledFrame,
  session: number,
  signal?: AbortSignal,
): Promise<Blob> {
  return renderQueue.enqueue(source, frame, session, signal);
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
  // 進行中の ZIP / GIF 書き出しも中断する(直後の frameSource.dispose() で
  // renderFull が失敗するため放置しても止まるが、明示的に abort して次の
  // フレーム境界で静かに抜けさせる)。null に戻すのはここで行い、旧書き出しの
  // finally 側は「自分が積んだ controller のままか」を確認してから触る。
  exportAbortController?.abort();
  exportAbortController = null;
  frameSource?.dispose();
  frameSource = null;
  frames = [];
  selected = new Set();

  // currentFile / scannedIntervalMs もここで一旦クリアする。対応形式であることが
  // 確定してから(下の detectFileKind() のチェック後に)currentFile を
  // 再設定するため、非対応形式で早期returnした場合はここでのクリアが最終状態
  // となり、無効なファイル(あるいは前回選択していた別ファイル)が再スキャン
  // 対象として残り続けることはない。
  currentFile = null;
  scannedIntervalMs = null;

  // ファイル切替時は viewer を強制クローズし、フル解像度/サムネイルの
  // objectURL キャッシュを全て revoke する(session ガードパターンを踏襲)。
  viewerController.closeSilently();
  viewerController.clearCaches();

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
    // currentFile は上で既に null にクリア済み(対応形式と確定できなかった
    // ため代入しない)。設定パネル側の再スキャンボタンの見た目も
    // 「ファイル未読み込み」の状態へ合わせておく。
    updateRescanState();
    return;
  }

  // ここまで来て初めて「対応形式のファイル」と確定するので、再スキャン用に保持する。
  currentFile = file;

  const source: FrameSource = kind === 'gif' ? new GifSource(file) : new VideoSource(file);
  frameSource = source;

  const controller = new AbortController();
  abortController = controller;

  settingsPanel.setDisabled(true);
  progressPanel.start();

  let scanFailed = false;

  try {
    // ここで取得した値(指定値)をそのまま scannedIntervalMs として記録する。
    // MAX_SAMPLES の上限により source.scan() 内部で実際に使われる間隔(実効値)は
    // これより広がることがあるが、再スキャン要否の判定は必ず「指定値」同士で
    // 比較する(実効値と比較すると、スキャン直後で何も変えていないのに
    // 再スキャンボタンが有効になってしまうため)。
    const intervalMs = settingsPanel.getIntervalMs();
    scannedIntervalMs = intervalMs;

    const scanOptions = {
      intervalMs,
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
    // 0件で終わった場合も scannedIntervalMs は更新済みなので、ボタンの状態を
    // 実態(currentFile はある・この間隔で一応スキャン済み)に合わせておく。
    updateRescanState();
    return;
  }

  selected = computeSelection();
  resultsList.finalize(selected);
  // スキャン完了。ここまでで scannedIntervalMs は今回使った指定値に更新済みなので、
  // 通常は現在の入力値と一致して再スキャンボタンは無効になる(スキャン中は
  // 設定パネルが disabled のため、スキャン中に間隔を変えることはできない)。
  updateRescanState();
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

  if (exportAbortController) {
    // 書き出し中は startExport() が ZIP / GIF 両ボタンを無効化しているため
    // 通常は到達しないが、二重起動をここでも防ぐ。
    return;
  }

  const plan = buildDownloadPlan(selected);
  const targets = Array.from(plan.values());

  const controller = new AbortController();
  exportAbortController = controller;
  resultsList.startExport('zip');

  try {
    const entries: { filename: string; blob: Blob }[] = [];
    for (let i = 0; i < targets.length; i++) {
      if (session !== currentSession || controller.signal.aborted) {
        return;
      }

      const { sequence, frame } = targets[i];
      resultsList.setExportProgress(`生成中… (${i + 1}/${targets.length})`);

      const blob = await enqueueRenderFull(source, frame, session, controller.signal);
      if (session !== currentSession || controller.signal.aborted) {
        return;
      }

      entries.push({ filename: buildFrameFileName(sequence, frame.timestampMs), blob });
    }

    if (session !== currentSession || controller.signal.aborted) {
      return;
    }
    resultsList.setExportProgress('ZIP にまとめています…');

    const zipBlob = await createZip(entries, { signal: controller.signal });
    if (session !== currentSession || controller.signal.aborted) {
      return;
    }

    triggerBlobDownload(zipBlob, `${baseName}_frames.zip`);
  } catch (error) {
    // キャンセル起因の失敗(createZip の AbortError や、ファイル切替による
    // renderFull の失敗)はエラー表示しない。
    if (session !== currentSession || controller.signal.aborted) {
      return;
    }
    console.error(error);
    notice.add('error', 'ZIP の生成に失敗しました。');
  } finally {
    // handleFile がファイル切替時に新しい値へ差し替えている可能性があるため、
    // 自分が積んだ controller のままのときだけ片付ける。
    if (exportAbortController === controller) {
      exportAbortController = null;
    }
    // 新セッション側の ZIP / GIF ボタンは handleFile 冒頭の resultsList.reset() /
    // finalize() が初期化・復元する前提なので、旧セッションの後始末で
    // 新しい画面の状態を上書きしないようにする。
    if (session === currentSession) {
      resultsList.finishExport();
    }
  }
}

async function downloadGif(): Promise<void> {
  // downloadZip 同様、開始時点の session とファイル名を束縛する。GIF 名も
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

  if (exportAbortController) {
    // 書き出し中は startExport() が ZIP / GIF 両ボタンを無効化しているため
    // 通常は到達しないが、二重起動をここでも防ぐ。
    return;
  }

  const plan = buildDownloadPlan(selected);
  const targets = Array.from(plan.values());

  const controller = new AbortController();
  exportAbortController = controller;
  resultsList.startExport('gif');

  try {
    const encoder = createGifEncoder({ maxWidth: GIF_MAX_WIDTH_PX, maxColors: GIF_MAX_COLORS });

    for (let i = 0; i < targets.length; i++) {
      if (session !== currentSession || controller.signal.aborted) {
        return;
      }

      const { frame } = targets[i];
      resultsList.setExportProgress(`生成中… (${i + 1}/${targets.length})`);

      const blob = await enqueueRenderFull(source, frame, session, controller.signal);
      if (session !== currentSession || controller.signal.aborted) {
        return;
      }

      await encoder.addFrame(blob, GIF_FRAME_DELAY_MS);
    }

    if (session !== currentSession || controller.signal.aborted) {
      return;
    }
    resultsList.setExportProgress('GIF を書き出しています…');

    const gifBlob = encoder.finish();
    if (session !== currentSession || controller.signal.aborted) {
      return;
    }

    triggerBlobDownload(gifBlob, `${baseName}_frames.gif`);
  } catch (error) {
    // キャンセル起因の失敗(ファイル切替による renderFull の失敗など)は
    // エラー表示しない。
    if (session !== currentSession || controller.signal.aborted) {
      return;
    }
    console.error(error);
    notice.add('error', 'GIF の生成に失敗しました。');
  } finally {
    // handleFile がファイル切替時に新しい値へ差し替えている可能性があるため、
    // 自分が積んだ controller のままのときだけ片付ける。
    if (exportAbortController === controller) {
      exportAbortController = null;
    }
    // 新セッション側の ZIP / GIF ボタンは handleFile 冒頭の resultsList.reset() /
    // finalize() が初期化・復元する前提なので、旧セッションの後始末で
    // 新しい画面の状態を上書きしないようにする。
    if (session === currentSession) {
      resultsList.finishExport();
    }
  }
}
