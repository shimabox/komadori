import type { ViewerNavDirection } from './viewerNav';

/**
 * viewer(ライトボックス)が1回の表示更新で必要とするデータ。
 * フレーム配列・採用状態のオーナーは main.ts であり、viewer はここで渡された
 * 内容を表示するだけの独立コンポーネントとする。
 */
export interface ViewerFrameData {
  frameIndex: number;
  /**
   * 表示中フレームの、対象プール内での 1 始まりの位置。「採用のみ表示」OFF なら
   * 全フレーム基準、ON なら採用フレーム基準になる(呼び出し側がどちらの基準で
   * 算出するかを切り替える)。対象プールに現在フレームが含まれない場合
   * (「採用のみ表示」ON で現在フレームの採用を外した場合など)は `null` になり、
   * viewer はプレースホルダー(「–」)を表示する。
   */
  position: number | null;
  /** position の分母(「採用のみ表示」OFF なら全フレーム数、ON なら採用フレーム数) */
  total: number;
  timestampMs: number;
  /** 現在表示する画像の URL(サムネイルまたはフル解像度) */
  imageUrl: string;
  adopted: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  /** 採用中フレームの総数(「採用のみ」トグルの空状態メッセージ判定に使う) */
  adoptedCount: number;
  /** true の間、フル解像度への差し替え待ちであることを示す簡易インジケータを出す */
  isLoadingFull: boolean;
}

export interface ViewerCallbacks {
  /** ← → ボタン/キー操作で前後送りが要求されたときに呼ばれる */
  onNavigate: (direction: ViewerNavDirection) => void;
  /** viewer 内の採用チェックボックスが切り替えられたときに呼ばれる */
  onToggleAdopt: (frameIndex: number, adopted: boolean) => void;
  /** 「採用のみ表示」トグルが切り替えられたときに呼ばれる */
  onAdoptedOnlyChange: (adoptedOnly: boolean) => void;
  /** PNG 保存ボタンが押されたときに呼ばれる */
  onDownload: (frameIndex: number) => void;
  /** 閉じられたときに呼ばれる(Esc・背景クリック・閉じるボタンいずれも経由) */
  onClose: () => void;
}

export interface ViewerHandle {
  element: HTMLElement;
  /** viewer を開き、指定フレームの内容を表示する。openerElement は閉じた際にフォーカスを戻す対象 */
  open(data: ViewerFrameData, openerElement?: HTMLElement | null): void;
  /** 表示中の内容を更新する(送り・チェック同期・しきい値変更の反映などに使う) */
  update(data: ViewerFrameData): void;
  /** 表示中フレームの画像だけをフル解像度のものに差し替える(ローディング表示も解除する) */
  applyFullImage(url: string): void;
  /** viewer を閉じる(開く前のフォーカス位置へ復帰する) */
  close(): void;
  /** 開いているかどうか */
  isOpen(): boolean;
}

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

/** サムネイルクリック等から開く、拡大表示+前後送りの viewer(ライトボックス)を作る */
export function createViewer(callbacks: ViewerCallbacks): ViewerHandle {
  const overlay = document.createElement('div');
  overlay.className = 'viewer-overlay';
  overlay.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'viewer-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'フレームビューア');

  const header = document.createElement('div');
  header.className = 'viewer-header';

  const counter = document.createElement('span');
  counter.className = 'viewer-counter';

  const adoptedOnlyLabel = document.createElement('label');
  adoptedOnlyLabel.className = 'viewer-adopted-only';
  const adoptedOnlyCheckbox = document.createElement('input');
  adoptedOnlyCheckbox.type = 'checkbox';
  const adoptedOnlyText = document.createElement('span');
  adoptedOnlyText.textContent = '採用のみ表示';
  adoptedOnlyLabel.append(adoptedOnlyCheckbox, adoptedOnlyText);

  const adoptedOnlyHint = document.createElement('span');
  adoptedOnlyHint.className = 'viewer-adopted-only-hint';
  adoptedOnlyHint.textContent = '(採用中のフレームがありません)';
  adoptedOnlyHint.hidden = true;

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'viewer-close';
  closeButton.textContent = '閉じる';
  closeButton.setAttribute('aria-label', 'ビューアを閉じる');

  header.append(counter, adoptedOnlyLabel, adoptedOnlyHint, closeButton);

  const body = document.createElement('div');
  body.className = 'viewer-body';

  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'viewer-nav-button viewer-nav-button--prev';
  prevButton.textContent = '←';
  prevButton.setAttribute('aria-label', '前のフレーム');

  const imageWrap = document.createElement('div');
  imageWrap.className = 'viewer-image-wrap';
  const image = document.createElement('img');
  image.className = 'viewer-image';
  image.alt = '';
  const loadingHint = document.createElement('span');
  loadingHint.className = 'viewer-loading-hint';
  loadingHint.textContent = '元解像度を読み込み中…';
  loadingHint.hidden = true;
  imageWrap.append(image, loadingHint);

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'viewer-nav-button viewer-nav-button--next';
  nextButton.textContent = '→';
  nextButton.setAttribute('aria-label', '次のフレーム');

  body.append(prevButton, imageWrap, nextButton);

  const footer = document.createElement('div');
  footer.className = 'viewer-footer';

  const timestampEl = document.createElement('span');
  timestampEl.className = 'viewer-timestamp';

  const adoptLabel = document.createElement('label');
  adoptLabel.className = 'viewer-adopt';
  const adoptCheckbox = document.createElement('input');
  adoptCheckbox.type = 'checkbox';
  const adoptText = document.createElement('span');
  adoptText.textContent = '採用';
  adoptLabel.append(adoptCheckbox, adoptText);

  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'viewer-download';
  downloadButton.textContent = 'PNG 保存';

  footer.append(timestampEl, adoptLabel, downloadButton);

  dialog.append(header, body, footer);
  overlay.append(dialog);

  let current: ViewerFrameData | null = null;
  let openerElement: HTMLElement | null = null;
  let adoptedOnly = false;

  function render(): void {
    if (!current) {
      return;
    }
    counter.textContent = `${current.position ?? '–'} / ${current.total}`;
    timestampEl.textContent = formatDisplayTimestamp(current.timestampMs);
    image.src = current.imageUrl;
    image.alt = `${formatDisplayTimestamp(current.timestampMs)} 時点のフレーム`;
    adoptCheckbox.checked = current.adopted;
    prevButton.disabled = !current.hasPrev;
    nextButton.disabled = !current.hasNext;
    loadingHint.hidden = !current.isLoadingFull;
    adoptedOnlyHint.hidden = !(adoptedOnly && current.adoptedCount === 0);
  }

  function open(data: ViewerFrameData, opener?: HTMLElement | null): void {
    current = data;
    openerElement =
      opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    adoptedOnly = false;
    adoptedOnlyCheckbox.checked = false;
    overlay.hidden = false;
    render();
    document.addEventListener('keydown', onKeyDown);
    closeButton.focus();
  }

  function update(data: ViewerFrameData): void {
    if (overlay.hidden) {
      return;
    }
    current = data;
    render();
  }

  function applyFullImage(url: string): void {
    if (overlay.hidden || !current) {
      return;
    }
    current = { ...current, imageUrl: url, isLoadingFull: false };
    image.src = current.imageUrl;
    loadingHint.hidden = true;
  }

  function close(): void {
    if (overlay.hidden) {
      return;
    }
    overlay.hidden = true;
    current = null;
    document.removeEventListener('keydown', onKeyDown);
    const opener = openerElement;
    openerElement = null;
    if (opener && document.contains(opener)) {
      opener.focus();
    }
  }

  function isOpen(): boolean {
    return !overlay.hidden;
  }

  function requestClose(): void {
    close();
    callbacks.onClose();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!prevButton.disabled) {
        callbacks.onNavigate('prev');
      }
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (!nextButton.disabled) {
        callbacks.onNavigate('next');
      }
    }
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      requestClose();
    }
  });
  closeButton.addEventListener('click', () => requestClose());
  prevButton.addEventListener('click', () => callbacks.onNavigate('prev'));
  nextButton.addEventListener('click', () => callbacks.onNavigate('next'));
  adoptCheckbox.addEventListener('change', () => {
    if (!current) {
      return;
    }
    callbacks.onToggleAdopt(current.frameIndex, adoptCheckbox.checked);
  });
  adoptedOnlyCheckbox.addEventListener('change', () => {
    adoptedOnly = adoptedOnlyCheckbox.checked;
    if (current) {
      adoptedOnlyHint.hidden = !(adoptedOnly && current.adoptedCount === 0);
    }
    callbacks.onAdoptedOnlyChange(adoptedOnly);
  });
  downloadButton.addEventListener('click', () => {
    if (!current) {
      return;
    }
    callbacks.onDownload(current.frameIndex);
  });

  return {
    element: overlay,
    open,
    update,
    applyFullImage,
    close,
    isOpen,
  };
}
