import { describe, expect, it } from 'vitest';
import { shouldEnableDeselectAll, shouldEnableSelectAll } from './bulkSelection';

describe('shouldEnableSelectAll', () => {
  it('フレーム0件ならfalse', () => {
    expect(shouldEnableSelectAll(0, 0)).toBe(false);
  });

  it('全件選択済みならfalse', () => {
    expect(shouldEnableSelectAll(5, 5)).toBe(false);
  });

  it('一部選択なら(全選択の余地があるので)true', () => {
    expect(shouldEnableSelectAll(5, 2)).toBe(true);
  });

  it('選択0件でもフレームがあればtrue', () => {
    expect(shouldEnableSelectAll(5, 0)).toBe(true);
  });

  it('選択数が総数を超える異常値でもfalse(全件選択済み扱い)', () => {
    expect(shouldEnableSelectAll(5, 6)).toBe(false);
  });
});

describe('shouldEnableDeselectAll', () => {
  it('選択0件ならfalse', () => {
    expect(shouldEnableDeselectAll(0)).toBe(false);
  });

  it('選択が1件以上あればtrue', () => {
    expect(shouldEnableDeselectAll(1)).toBe(true);
  });

  it('選択数が大きくてもtrue', () => {
    expect(shouldEnableDeselectAll(100)).toBe(true);
  });
});
