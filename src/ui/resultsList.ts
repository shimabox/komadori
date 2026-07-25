import type { SampledFrame } from '../core/types';

export interface ResultsListCallbacks {
  /** チェックボックスが手動で切り替えられたときに呼ばれる */
  onToggle: (frameIndex: number, adopted: boolean) => void;
  /** 個別ダウンロードボタンが押されたときに呼ばれる */
  onDownloadOne: (frameIndex: number) => void;
  /** ZIP 一括ダウンロードボタンが押されたときに呼ばれる */
  onDownloadZip: () => void;
  /**
   * viewer を開く操作(サムネイルクリック、または「ビューアで見る」ボタン)が
   * 行われたときに呼ばれる。`openerElement` は viewer を閉じた際にフォーカスを
   * 戻すべき要素(クリックされたサムネイルやボタン)
   */
  onOpenViewer: (frameIndex: number, openerElement: HTMLElement) => void;
}

export interface ResultsListHandle {
  element: HTMLElement;
  /** 新しいファイルを読み込む際に、表示中のグリッドを全て破棄する */
  reset(): void;
  /** スキャン中に1フレームずつ追加する(チェックボックス・ダウンロードボタンは無効のまま追加する) */
  appendFrame(frame: SampledFrame): void;
  /** スキャン終了後に呼ぶ。全アイテムの操作を有効化し、選択状態を反映する */
  finalize(selected: ReadonlySet<number>): void;
  /** しきい値変更時に呼ぶ。選択状態(チェック)のみを再構築なしで更新する */
  applySelection(selected: ReadonlySet<number>): void;
  /** ZIP ボタンの有効/無効を切り替える */
  setZipButtonEnabled(enabled: boolean): void;
  /** ZIP ボタンのラベルを一時的に変更する(生成中の進捗表示用) */
  setZipButtonLabel(label: string): void;
  /** ZIP ボタンのラベルを既定のものに戻す */
  resetZipButtonLabel(): void;
}

interface ItemRefs {
  checkbox: HTMLInputElement;
  downloadButton: HTMLButtonElement;
  thumbnailUrl: string;
}

const DEFAULT_ZIP_BUTTON_LABEL = '選択したフレームを ZIP でダウンロード';

function formatDisplayTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mss = String(millis).padStart(3, '0');
  return `${mm}:${ss}.${mss}`;
}

/** サムネイルグリッド(結果一覧)を作る */
export function createResultsList(callbacks: ResultsListCallbacks): ResultsListHandle {
  const element = document.createElement('section');
  element.className = 'results-panel';
  element.hidden = true;

  const header = document.createElement('div');
  header.className = 'results-header';

  const summary = document.createElement('span');
  summary.className = 'results-summary';

  const viewButton = document.createElement('button');
  viewButton.type = 'button';
  viewButton.className = 'results-view-button';
  viewButton.textContent = 'ビューアで見る';
  viewButton.disabled = true;
  viewButton.addEventListener('click', () => {
    const firstIndex = items.keys().next().value;
    if (firstIndex === undefined) {
      return;
    }
    callbacks.onOpenViewer(firstIndex, viewButton);
  });

  const zipButton = document.createElement('button');
  zipButton.type = 'button';
  zipButton.className = 'results-zip-button';
  zipButton.textContent = DEFAULT_ZIP_BUTTON_LABEL;
  zipButton.disabled = true;
  zipButton.addEventListener('click', () => callbacks.onDownloadZip());

  header.append(summary, viewButton, zipButton);

  const grid = document.createElement('div');
  grid.className = 'results-grid';

  element.append(header, grid);

  const items = new Map<number, ItemRefs>();
  // サムネイルクリックでの viewer 起動はスキャン完了(finalize)後のみ有効にする
  let viewerReady = false;

  function updateSummary(): void {
    let adopted = 0;
    for (const refs of items.values()) {
      if (refs.checkbox.checked) {
        adopted += 1;
      }
    }
    summary.textContent = `${items.size} 件中 ${adopted} 件を採用中`;
  }

  function reset(): void {
    for (const refs of items.values()) {
      URL.revokeObjectURL(refs.thumbnailUrl);
    }
    items.clear();
    grid.replaceChildren();
    element.hidden = true;
    zipButton.disabled = true;
    viewButton.disabled = true;
    viewerReady = false;
    resetZipButtonLabel();
    summary.textContent = '';
  }

  function appendFrame(frame: SampledFrame): void {
    element.hidden = false;

    const card = document.createElement('article');
    card.className = 'frame-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'frame-thumb-wrap';
    thumbWrap.setAttribute('role', 'button');
    thumbWrap.setAttribute('tabindex', '0');
    thumbWrap.setAttribute('aria-label', 'このフレームをビューアで開く');
    const thumbnailUrl = URL.createObjectURL(frame.thumbnail);
    const img = document.createElement('img');
    img.className = 'frame-thumb';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = thumbnailUrl;
    img.alt = `${formatDisplayTimestamp(frame.timestampMs)} 時点のフレーム`;
    thumbWrap.append(img);
    const openFromThumb = (): void => {
      if (!viewerReady) {
        return;
      }
      callbacks.onOpenViewer(frame.index, thumbWrap);
    };
    thumbWrap.addEventListener('click', openFromThumb);
    thumbWrap.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFromThumb();
      }
    });

    const meta = document.createElement('div');
    meta.className = 'frame-meta';

    const timestampEl = document.createElement('span');
    timestampEl.className = 'frame-timestamp';
    timestampEl.textContent = formatDisplayTimestamp(frame.timestampMs);

    const adoptLabel = document.createElement('label');
    adoptLabel.className = 'frame-adopt';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = true;
    checkbox.addEventListener('change', () => {
      callbacks.onToggle(frame.index, checkbox.checked);
      updateSummary();
    });
    const adoptText = document.createElement('span');
    adoptText.textContent = '採用';
    adoptLabel.append(checkbox, adoptText);

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'frame-download';
    downloadButton.textContent = 'PNG 保存';
    downloadButton.disabled = true;
    downloadButton.addEventListener('click', () => callbacks.onDownloadOne(frame.index));

    meta.append(timestampEl, adoptLabel, downloadButton);
    card.append(thumbWrap, meta);
    grid.append(card);

    items.set(frame.index, { checkbox, downloadButton, thumbnailUrl });
    updateSummary();
  }

  function applySelection(selected: ReadonlySet<number>): void {
    for (const [index, refs] of items) {
      refs.checkbox.checked = selected.has(index);
    }
    updateSummary();
  }

  function finalize(selected: ReadonlySet<number>): void {
    for (const refs of items.values()) {
      refs.checkbox.disabled = false;
      refs.downloadButton.disabled = false;
    }
    applySelection(selected);
    zipButton.disabled = items.size === 0;
    viewButton.disabled = items.size === 0;
    viewerReady = items.size > 0;
  }

  function setZipButtonEnabled(enabled: boolean): void {
    zipButton.disabled = !enabled;
  }

  function setZipButtonLabel(label: string): void {
    zipButton.textContent = label;
  }

  function resetZipButtonLabel(): void {
    zipButton.textContent = DEFAULT_ZIP_BUTTON_LABEL;
  }

  return {
    element,
    reset,
    appendFrame,
    finalize,
    applySelection,
    setZipButtonEnabled,
    setZipButtonLabel,
    resetZipButtonLabel,
  };
}
