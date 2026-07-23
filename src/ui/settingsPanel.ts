export interface SettingsPanelInitial {
  thresholdPercent: number;
  intervalMs: number;
}

export interface SettingsPanelCallbacks {
  /** しきい値スライダーが変更されたときに呼ばれる(現在値を渡す) */
  onThresholdChange: (thresholdPercent: number) => void;
}

export interface SettingsPanelHandle {
  element: HTMLElement;
  getThresholdPercent(): number;
  getIntervalMs(): number;
  /** スキャン中は true にして操作できないようにする */
  setDisabled(disabled: boolean): void;
}

const MIN_THRESHOLD_PERCENT = 0.5;
const MAX_THRESHOLD_PERCENT = 30;
const THRESHOLD_STEP = 0.5;
const MIN_INTERVAL_MS = 20;
const INTERVAL_STEP = 10;

/** しきい値スライダーとサンプリング間隔の設定パネルを作る */
export function createSettingsPanel(
  initial: SettingsPanelInitial,
  callbacks: SettingsPanelCallbacks,
): SettingsPanelHandle {
  const element = document.createElement('section');
  element.className = 'settings-panel';

  const heading = document.createElement('h2');
  heading.className = 'settings-heading';
  heading.textContent = '設定';
  element.append(heading);

  // しきい値スライダー
  const thresholdRow = document.createElement('div');
  thresholdRow.className = 'settings-row';

  const thresholdLabel = document.createElement('label');
  thresholdLabel.className = 'settings-label';
  thresholdLabel.setAttribute('for', 'bunkatsu-threshold-slider');

  const thresholdValueEl = document.createElement('span');
  thresholdValueEl.className = 'settings-value';

  thresholdLabel.append('しきい値(変化率) ', thresholdValueEl);

  const thresholdSlider = document.createElement('input');
  thresholdSlider.type = 'range';
  thresholdSlider.id = 'bunkatsu-threshold-slider';
  thresholdSlider.min = String(MIN_THRESHOLD_PERCENT);
  thresholdSlider.max = String(MAX_THRESHOLD_PERCENT);
  thresholdSlider.step = String(THRESHOLD_STEP);
  thresholdSlider.value = String(initial.thresholdPercent);

  function refreshThresholdLabel(): void {
    const value = Number(thresholdSlider.value);
    thresholdValueEl.textContent = `${value.toFixed(1)}%`;
  }
  refreshThresholdLabel();

  thresholdSlider.addEventListener('input', () => {
    refreshThresholdLabel();
    callbacks.onThresholdChange(Number(thresholdSlider.value));
  });

  thresholdRow.append(thresholdLabel, thresholdSlider);

  // サンプリング間隔
  const intervalRow = document.createElement('div');
  intervalRow.className = 'settings-row';

  const intervalLabel = document.createElement('label');
  intervalLabel.className = 'settings-label';
  intervalLabel.setAttribute('for', 'bunkatsu-interval-input');
  intervalLabel.textContent = 'サンプリング間隔(ミリ秒)';

  const intervalInput = document.createElement('input');
  intervalInput.type = 'number';
  intervalInput.id = 'bunkatsu-interval-input';
  intervalInput.min = String(MIN_INTERVAL_MS);
  intervalInput.step = String(INTERVAL_STEP);
  intervalInput.value = String(initial.intervalMs);
  intervalInput.inputMode = 'numeric';

  intervalRow.append(intervalLabel, intervalInput);

  const intervalHint = document.createElement('p');
  intervalHint.className = 'settings-hint';
  intervalHint.textContent =
    '動画が長くサンプル数の上限を超える場合は、この間隔より広い間隔が自動的に使われます。';

  element.append(thresholdRow, intervalRow, intervalHint);

  function getThresholdPercent(): number {
    const value = Number(thresholdSlider.value);
    return Number.isFinite(value) ? value : initial.thresholdPercent;
  }

  function getIntervalMs(): number {
    const value = Number(intervalInput.value);
    if (!Number.isFinite(value) || value < MIN_INTERVAL_MS) {
      return initial.intervalMs;
    }
    return value;
  }

  function setDisabled(disabled: boolean): void {
    thresholdSlider.disabled = disabled;
    intervalInput.disabled = disabled;
  }

  return { element, getThresholdPercent, getIntervalMs, setDisabled };
}
