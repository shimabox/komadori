export interface ProgressPanelCallbacks {
  onCancel: () => void;
}

export interface ProgressPanelHandle {
  element: HTMLElement;
  /** スキャン開始時に呼ぶ(表示して 0% にリセットする) */
  start(): void;
  /** 進捗コールバックから呼ぶ */
  update(sampled: number, estimatedTotal: number): void;
  /** スキャン終了時(完了・キャンセルどちらでも)に呼ぶ */
  stop(): void;
}

/** スキャン進捗バーとキャンセルボタンを作る */
export function createProgressPanel(callbacks: ProgressPanelCallbacks): ProgressPanelHandle {
  const element = document.createElement('section');
  element.className = 'progress-panel';
  element.hidden = true;

  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  track.append(fill);

  const infoRow = document.createElement('div');
  infoRow.className = 'progress-info';

  const text = document.createElement('span');
  text.className = 'progress-text';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'progress-cancel';
  cancelButton.textContent = 'キャンセル';
  cancelButton.addEventListener('click', () => {
    cancelButton.disabled = true;
    text.textContent = 'キャンセル中…';
    callbacks.onCancel();
  });

  infoRow.append(text, cancelButton);
  element.append(track, infoRow);

  function start(): void {
    element.hidden = false;
    fill.style.width = '0%';
    text.textContent = 'スキャン準備中…';
    cancelButton.disabled = false;
  }

  function update(sampled: number, estimatedTotal: number): void {
    const percent = estimatedTotal > 0 ? Math.min(100, (sampled / estimatedTotal) * 100) : 0;
    fill.style.width = `${percent}%`;
    text.textContent = `スキャン中… ${sampled} / ${estimatedTotal}`;
  }

  function stop(): void {
    element.hidden = true;
  }

  return { element, start, update, stop };
}
