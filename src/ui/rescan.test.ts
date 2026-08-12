import { describe, expect, it } from 'vitest';
import { shouldEnableRescan } from './rescan';

describe('shouldEnableRescan', () => {
  it('ファイル未読み込みならfalse(値が異なっていても)', () => {
    expect(shouldEnableRescan(false, 200, 300, true)).toBe(false);
  });

  it('未スキャン(scannedIntervalMsがnull)ならfalse', () => {
    expect(shouldEnableRescan(true, null, 300, true)).toBe(false);
  });

  it('指定値がスキャン時の値と同じならfalse(再スキャン不要)', () => {
    expect(shouldEnableRescan(true, 200, 200, true)).toBe(false);
  });

  it('指定値がスキャン時の値と異なればtrue', () => {
    expect(shouldEnableRescan(true, 200, 300, true)).toBe(true);
  });

  it('ファイルあり・未スキャンでも値が異なっていてもfalse(未スキャンが優先)', () => {
    expect(shouldEnableRescan(true, null, 200, true)).toBe(false);
  });

  it('小数値でも差があればtrue', () => {
    expect(shouldEnableRescan(true, 200.5, 200.6, true)).toBe(true);
  });

  it('小数値で一致していればfalse', () => {
    expect(shouldEnableRescan(true, 200.5, 200.5, true)).toBe(false);
  });

  it('MAX_SAMPLES制約で実効間隔が広げられていても、指定値同士の比較なのでfalse', () => {
    // 実効値ではなく「指定した」値同士を比較する設計を確認する。
    // (例: 長い動画で指定200msが実際には500msとして使われても、scannedIntervalMs
    //  には呼び出し側が指定値の200msを記録している前提なので、指定値が
    //  変わっていなければfalseになる)
    expect(shouldEnableRescan(true, 200, 200, true)).toBe(false);
  });

  it('不正値(NaN)が指定値に来てもスキャン時の値と一致しなければtrue', () => {
    expect(shouldEnableRescan(true, 200, Number.NaN, true)).toBe(true);
  });

  it('スキャン時・指定値ともに0でも、値の一致として扱いfalse', () => {
    expect(shouldEnableRescan(true, 0, 0, true)).toBe(false);
  });

  it('intervalApplicableがfalse(GIF等)なら、値が異なっていてもfalse', () => {
    // GifSourceはサンプリング間隔を参照しないため、GIFに対しては間隔を
    // 変えて再スキャンしても結果が変わらない。「押しても何も変わらない
    // ボタン」を有効にしないための条件。
    expect(shouldEnableRescan(true, 200, 300, false)).toBe(false);
  });

  it('intervalApplicableがfalseなら、ファイルあり・スキャン済み・値が異なる場合でもfalse', () => {
    expect(shouldEnableRescan(true, 100, 999, false)).toBe(false);
  });

  it('intervalApplicableがtrue(動画)なら、従来どおり値が異なればtrue', () => {
    expect(shouldEnableRescan(true, 200, 300, true)).toBe(true);
  });

  it('intervalApplicableがfalseでもhasFileがfalseならfalse(組み合わせの確認)', () => {
    expect(shouldEnableRescan(false, 200, 300, false)).toBe(false);
  });
});
