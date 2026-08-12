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
 * - サンプリング間隔が対象ファイルに対して意味を持たない(`intervalApplicable
 *   === false`)ならfalse。GifSourceはサンプリング間隔を参照せず、全フレームを
 *   対象にmaxSamplesで均等間引きするだけなので、GIFに対しては間隔を変えて
 *   再スキャンしても結果が変わらない。「押しても何も変わらないボタン」を
 *   有効にしないため、他の条件に関わらずここで弾く
 * - ファイル未読み込み(`hasFile === false`)なら再スキャンできないのでfalse
 * - 未スキャン(`scannedIntervalMs === null`)ならfalse
 * - 指定値が直前のスキャン時から変わっていなければ(再スキャンする意味が
 *   ないので)false
 * - それ以外(ファイルがあり、間隔が意味を持ち、スキャン済みで、値が
 *   変わっている)ならtrue
 */
export function shouldEnableRescan(
  hasFile: boolean,
  scannedIntervalMs: number | null,
  requestedIntervalMs: number,
  intervalApplicable: boolean,
): boolean {
  if (!intervalApplicable || !hasFile || scannedIntervalMs === null) {
    return false;
  }
  return requestedIntervalMs !== scannedIntervalMs;
}
