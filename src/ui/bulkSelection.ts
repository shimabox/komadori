/**
 * 「全選択」「全解除」ボタンの有効/無効を決める純関数群(DOM非依存)。
 *
 * どちらも「押しても何も起きない状態」を無効にするための判定。呼び出し側
 * (resultsList.ts の updateSummary())は、既にチェック数を数えているその場で
 * これらを呼び、ボタンの disabled を更新する。
 */

/**
 * 「全選択」ボタンを有効にすべきかどうかを判定する。
 *
 * - フレームが1件もなければ(全選択しても対象が無いので)false
 * - 既に全件選択済みならfalse
 * - それ以外(1件以上あり、未選択のフレームが残っている)ならtrue
 *
 * `selectedCount`が`totalCount`を上回るような異常値が来た場合も、
 * 「全件選択済みではない」とはみなさず(>=で判定するため)falseを返す。
 */
export function shouldEnableSelectAll(totalCount: number, selectedCount: number): boolean {
  if (totalCount <= 0) {
    return false;
  }
  return selectedCount < totalCount;
}

/**
 * 「全解除」ボタンを有効にすべきかどうかを判定する。
 *
 * 選択が1件以上あればtrue(総数は問わない)。
 */
export function shouldEnableDeselectAll(selectedCount: number): boolean {
  return selectedCount > 0;
}
