export interface SettingsPanelInitial {
  thresholdPercent: number;
  intervalMs: number;
}

export interface SettingsPanelCallbacks {
  /** しきい値スライダーが変更されたときに呼ばれる(現在値を渡す) */
  onThresholdChange: (thresholdPercent: number) => void;
  /** サンプリング間隔の入力が変更されたときに呼ばれる(再スキャンボタンの有効/無効判定のトリガー用) */
  onIntervalChange: () => void;
  /** 「この間隔で再スキャン」ボタンがクリックされたときに呼ばれる */
  onRescan: () => void;
}

export interface SettingsPanelHandle {
  element: HTMLElement;
  getThresholdPercent(): number;
  getIntervalMs(): number;
  /**
   * スキャン中は true にして操作できないようにする。再スキャンボタンも
   * スキャン中は必ず無効化するが、`disabled(false)`(スキャン終了)で
   * 無条件に有効へ戻すことはしない(間隔を変えていないのに押せてしまう
   * ため)。再スキャンボタンの最終的な有効/無効は呼び出し側(main.ts)が
   * `setRescanEnabled()`で個別に判断・反映する。
   */
  setDisabled(disabled: boolean): void;
  /** 再スキャンボタンの有効/無効を設定する。有効/無効の判断ロジック自体は
   * 呼び出し側(main.ts, shouldEnableRescan)が持つ。ここでは反映のみ行う。
   * ただしスキャン中(setDisabled(true)の間)は常に無効を維持する。
   */
  setRescanEnabled(enabled: boolean): void;
}

const MIN_THRESHOLD_PERCENT = 0.5;
const MAX_THRESHOLD_PERCENT = 30;
const THRESHOLD_STEP = 0.5;
// GIFのディレイはgifuct-js上10ms単位で持てる((gce.delay || 10) * 10)ため、
// 下限をディレイの最小単位に合わせて10msにする。20msのままだと10msディレイの
// GIFで全フレームを採用できなくなる(実効間隔が最小ディレイより粗くなるため)。
const MIN_INTERVAL_MS = 10;
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

  intervalInput.addEventListener('input', () => {
    callbacks.onIntervalChange();
  });

  const rescanButton = document.createElement('button');
  rescanButton.type = 'button';
  rescanButton.className = 'settings-rescan-button';
  rescanButton.textContent = 'この間隔で再スキャン';
  // 初期状態は無効(ファイル未読み込み・未スキャンのため)。以降の有効/無効は
  // setRescanEnabled() 経由で呼び出し側(main.ts)が判断・反映する。
  rescanButton.disabled = true;
  rescanButton.addEventListener('click', () => {
    callbacks.onRescan();
  });

  intervalRow.append(intervalLabel, intervalInput, rescanButton);

  const intervalHint = document.createElement('p');
  intervalHint.className = 'settings-hint';
  intervalHint.textContent =
    '動画・GIFいずれも、長くサンプル数の上限を超える場合は、この間隔より広い間隔が自動的に使われます。間隔を変更した場合、反映するには「この間隔で再スキャン」を押してください。';

  element.append(thresholdRow, intervalRow, intervalHint);

  // 再スキャンボタンの「意図した」有効/無効状態(setRescanEnabled() で
  // main.ts から指定される)。スキャン中(setDisabled(true))はこの値に
  // 関わらず強制的に無効表示にするが、値自体は保持しておき、
  // setDisabled(false) で復元する際に使う(スキャン終了時に無条件で
  // 有効へ戻すと、間隔を変えていないのに押せてしまうため)。
  let rescanIntentEnabled = false;
  let isScanning = false;

  function refreshRescanButtonDisabled(): void {
    rescanButton.disabled = isScanning || !rescanIntentEnabled;
  }

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
    // 再スキャンボタンはスキャン中は必ず無効にするが、スキャン終了
    // (disabled === false)時に無条件で有効へ戻すことはしない。有効に
    // 戻してよいかどうかは rescanIntentEnabled(setRescanEnabled() で
    // main.ts が設定した値)に従う。
    isScanning = disabled;
    refreshRescanButtonDisabled();
  }

  function setRescanEnabled(enabled: boolean): void {
    rescanIntentEnabled = enabled;
    refreshRescanButtonDisabled();
  }

  return {
    element,
    getThresholdPercent,
    getIntervalMs,
    setDisabled,
    setRescanEnabled,
  };
}
