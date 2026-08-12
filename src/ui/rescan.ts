/**
 * 「この間隔で再スキャン」ボタンの有効/無効を決める純関数(DOM非依存)。
 *
 * 比較するのは「指定値」(ユーザーが設定パネルに入力した値)であって「実効値」
 * ではない。長い動画では上限サンプル数(MAX_SAMPLES)の制約により、指定した
 * 間隔より広い間隔が自動的に使われることがある。実効値と比較すると、
 * スキャン直後で何も変えていないのにボタンが有効になってしまうため、
 * 呼び出し側は必ずスキャン開始時に`getIntervalMs()`から取った値(指定値)を
 * `scannedIntervalMs`として保持し、それをここへ渡す。
 *
 * - ファイル未読み込み(`hasFile === false`)なら再スキャンできないのでfalse
 * - 未スキャン(`scannedIntervalMs === null`)ならfalse
 * - 指定値が直前のスキャン時から変わっていなければ(再スキャンする意味が
 *   ないので)false
 * - それ以外(ファイルがあり、スキャン済みで、値が変わっている)ならtrue
 */
export function shouldEnableRescan(
  hasFile: boolean,
  scannedIntervalMs: number | null,
  requestedIntervalMs: number,
): boolean {
  if (!hasFile || scannedIntervalMs === null) {
    return false;
  }
  return requestedIntervalMs !== scannedIntervalMs;
}
