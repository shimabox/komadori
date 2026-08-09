export interface SettingsPanelInitial {
  thresholdPercent: number;
  intervalMs: number;
}

export interface SettingsPanelCallbacks {
  /** しきい値スライダーが変更されたときに呼ばれる(現在値を渡す) */
  onThresholdChange: (thresholdPercent: number) => void;
}

export interface GifOptions {
  /** 全フレーム共通のフレーム遅延(ミリ秒) */
  delayMs: number;
  /** 出力の最大幅(px)。null はフル解像度(縮小しない) */
  maxWidth: number | null;
  /** 量子化の最大色数 */
  maxColors: number;
}

export interface SettingsPanelHandle {
  element: HTMLElement;
  getThresholdPercent(): number;
  getIntervalMs(): number;
  /** GIF出力(フレーム遅延・最大幅・色数)の現在値をまとめて取得する */
  getGifOptions(): GifOptions;
  /** スキャン中は true にして操作できないようにする */
  setDisabled(disabled: boolean): void;
}

const MIN_THRESHOLD_PERCENT = 0.5;
const MAX_THRESHOLD_PERCENT = 30;
const THRESHOLD_STEP = 0.5;
const MIN_INTERVAL_MS = 20;
const INTERVAL_STEP = 10;

const DEFAULT_GIF_DELAY_MS = 500;
const MIN_GIF_DELAY_MS = 50;
const MAX_GIF_DELAY_MS = 3000;
const GIF_DELAY_STEP = 50;
/** 最大幅の選択肢(px)。null は「フル解像度」を表す */
const GIF_MAX_WIDTH_OPTIONS: (number | null)[] = [320, 480, 640, 960, 1280, null];
const DEFAULT_GIF_MAX_WIDTH = 640;
/** 色数の選択肢 */
const GIF_MAX_COLORS_OPTIONS = [256, 128, 64, 32];
const DEFAULT_GIF_MAX_COLORS = 256;
/** select 要素で「フル解像度(maxWidth = null)」を表す特別な value */
const FULL_RESOLUTION_VALUE = 'full';

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
  thresholdLabel.setAttribute('for', 'komadori-threshold-slider');

  const thresholdValueEl = document.createElement('span');
  thresholdValueEl.className = 'settings-value';

  thresholdLabel.append('しきい値(変化率) ', thresholdValueEl);

  const thresholdSlider = document.createElement('input');
  thresholdSlider.type = 'range';
  thresholdSlider.id = 'komadori-threshold-slider';
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
  intervalLabel.setAttribute('for', 'komadori-interval-input');
  intervalLabel.textContent = 'サンプリング間隔(ミリ秒)';

  const intervalInput = document.createElement('input');
  intervalInput.type = 'number';
  intervalInput.id = 'komadori-interval-input';
  intervalInput.min = String(MIN_INTERVAL_MS);
  intervalInput.step = String(INTERVAL_STEP);
  intervalInput.value = String(initial.intervalMs);
  intervalInput.inputMode = 'numeric';

  intervalRow.append(intervalLabel, intervalInput);

  const intervalHint = document.createElement('p');
  intervalHint.className = 'settings-hint';
  intervalHint.textContent =
    '動画が長くサンプル数の上限を超える場合は、この間隔より広い間隔が自動的に使われます。';

  // GIF出力設定群であることが視覚的に分かるよう、スキャン設定群とは別に
  // 小見出し(h3)を挟む(settings-heading はパネル全体の見出しとして既に使われているため)。
  const gifHeading = document.createElement('h3');
  gifHeading.className = 'settings-subheading';
  gifHeading.textContent = 'GIF出力';

  // フレーム遅延
  const gifDelayRow = document.createElement('div');
  gifDelayRow.className = 'settings-row';

  const gifDelayLabel = document.createElement('label');
  gifDelayLabel.className = 'settings-label';
  gifDelayLabel.setAttribute('for', 'komadori-gif-delay-slider');

  const gifDelayValueEl = document.createElement('span');
  gifDelayValueEl.className = 'settings-value';

  gifDelayLabel.append('フレーム遅延 ', gifDelayValueEl);

  const gifDelaySlider = document.createElement('input');
  gifDelaySlider.type = 'range';
  gifDelaySlider.id = 'komadori-gif-delay-slider';
  gifDelaySlider.min = String(MIN_GIF_DELAY_MS);
  gifDelaySlider.max = String(MAX_GIF_DELAY_MS);
  gifDelaySlider.step = String(GIF_DELAY_STEP);
  gifDelaySlider.value = String(DEFAULT_GIF_DELAY_MS);

  function refreshGifDelayLabel(): void {
    gifDelayValueEl.textContent = `${gifDelaySlider.value}ms`;
  }
  refreshGifDelayLabel();

  gifDelaySlider.addEventListener('input', refreshGifDelayLabel);

  gifDelayRow.append(gifDelayLabel, gifDelaySlider);

  // 最大幅
  const gifMaxWidthRow = document.createElement('div');
  gifMaxWidthRow.className = 'settings-row';

  const gifMaxWidthLabel = document.createElement('label');
  gifMaxWidthLabel.className = 'settings-label';
  gifMaxWidthLabel.setAttribute('for', 'komadori-gif-maxwidth-select');
  gifMaxWidthLabel.textContent = '最大幅';

  const gifMaxWidthSelect = document.createElement('select');
  gifMaxWidthSelect.id = 'komadori-gif-maxwidth-select';
  for (const width of GIF_MAX_WIDTH_OPTIONS) {
    const option = document.createElement('option');
    option.value = width === null ? FULL_RESOLUTION_VALUE : String(width);
    option.textContent = width === null ? 'フル解像度' : `${width}px`;
    gifMaxWidthSelect.append(option);
  }
  gifMaxWidthSelect.value = String(DEFAULT_GIF_MAX_WIDTH);

  gifMaxWidthRow.append(gifMaxWidthLabel, gifMaxWidthSelect);

  // 色数
  const gifMaxColorsRow = document.createElement('div');
  gifMaxColorsRow.className = 'settings-row';

  const gifMaxColorsLabel = document.createElement('label');
  gifMaxColorsLabel.className = 'settings-label';
  gifMaxColorsLabel.setAttribute('for', 'komadori-gif-maxcolors-select');
  gifMaxColorsLabel.textContent = '色数';

  const gifMaxColorsSelect = document.createElement('select');
  gifMaxColorsSelect.id = 'komadori-gif-maxcolors-select';
  for (const colors of GIF_MAX_COLORS_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(colors);
    option.textContent = `${colors}色`;
    gifMaxColorsSelect.append(option);
  }
  gifMaxColorsSelect.value = String(DEFAULT_GIF_MAX_COLORS);

  gifMaxColorsRow.append(gifMaxColorsLabel, gifMaxColorsSelect);

  const gifHint = document.createElement('p');
  gifHint.className = 'settings-hint';
  gifHint.textContent =
    'フレーム遅延は全フレーム共通の固定値になるため、もとの動画のテンポは再現されません。';

  element.append(
    thresholdRow,
    intervalRow,
    intervalHint,
    gifHeading,
    gifDelayRow,
    gifMaxWidthRow,
    gifMaxColorsRow,
    gifHint,
  );

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

  function getGifOptions(): GifOptions {
    const delayValue = Number(gifDelaySlider.value);
    const delayMs = Number.isFinite(delayValue) ? delayValue : DEFAULT_GIF_DELAY_MS;

    const maxWidth =
      gifMaxWidthSelect.value === FULL_RESOLUTION_VALUE ? null : Number(gifMaxWidthSelect.value);

    const maxColorsValue = Number(gifMaxColorsSelect.value);
    const maxColors = Number.isFinite(maxColorsValue) ? maxColorsValue : DEFAULT_GIF_MAX_COLORS;

    return { delayMs, maxWidth, maxColors };
  }

  function setDisabled(disabled: boolean): void {
    thresholdSlider.disabled = disabled;
    intervalInput.disabled = disabled;
    gifDelaySlider.disabled = disabled;
    gifMaxWidthSelect.disabled = disabled;
    gifMaxColorsSelect.disabled = disabled;
  }

  return { element, getThresholdPercent, getIntervalMs, getGifOptions, setDisabled };
}
