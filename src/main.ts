import './style.css';
import { extractChangedFrames } from './core/extractor';
import type { FrameSource } from './core/frameSource';
import { GifSource } from './core/gifSource';
import type { SampledFrame } from './core/types';
import { VideoSource } from './core/videoSource';
import { createZip } from './core/zip';
import { createDropzone } from './ui/dropzone';
import { createNotice } from './ui/notice';
import { createProgressPanel } from './ui/progressPanel';
import { createResultsList } from './ui/resultsList';
import { createSettingsPanel } from './ui/settingsPanel';

const DEFAULT_THRESHOLD_PERCENT = 3;
const DEFAULT_INTERVAL_MS = 200;
const MAX_SAMPLES = 600;
const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;
const GIF_EXTENSION = /\.gif$/i;
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|avi|mkv|ogv|ogg)$/i;

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
      <h1 class="app-title">bunkatsu</h1>
      <p class="app-tagline">
        動画・GIF の「変化点」フレームだけを検出して静止画として抽出・ダウンロードします。
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
  },
  onDownloadOne: (frameIndex) => {
    void downloadOne(frameIndex);
  },
  onDownloadZip: () => {
    void downloadZip();
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
    const blob = await source.renderFull(frame);
    triggerBlobDownload(blob, buildFrameFileName(sequence, frame.timestampMs));
  } catch (error) {
    console.error(error);
    notice.add('error', 'PNG の生成に失敗しました。');
  }
}

async function downloadZip(): Promise<void> {
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
      const { sequence, frame } = targets[i];
      resultsList.setZipButtonLabel(`生成中… (${i + 1}/${targets.length})`);
      const blob = await source.renderFull(frame);
      entries.push({ filename: buildFrameFileName(sequence, frame.timestampMs), blob });
    }

    resultsList.setZipButtonLabel('ZIP にまとめています…');
    const zipBlob = await createZip(entries);
    triggerBlobDownload(zipBlob, `${currentFileBaseName}_frames.zip`);
  } catch (error) {
    console.error(error);
    notice.add('error', 'ZIP の生成に失敗しました。');
  } finally {
    resultsList.resetZipButtonLabel();
    resultsList.setZipButtonEnabled(true);
  }
}
