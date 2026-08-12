import { describe, expect, it } from 'vitest';
import { pickIndicesByInterval, planCompositeRange } from './gifSource';

describe('pickIndicesByInterval', () => {
  it('間隔がディレイより細かい場合、全フレームを採用する', () => {
    // 10 フレーム、各ディレイ 100ms(総再生時間 1000ms)。間隔 20ms は
    // ディレイ(100ms)より細かいため、実効間隔も 20ms のままとなり全フレームが
    // グリッド点に到達して採用される。
    const delaysMs = Array.from({ length: 10 }, () => 100);
    expect(pickIndicesByInterval(delaysMs, 20, 600)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('間隔がディレイの倍数のとき、等間隔で採用する', () => {
    // 各ディレイ 50ms、間隔 150ms(= 50ms の 3 倍)。開始時刻は 0, 50, 100, 150, ...
    // なので、150ms ごとの倍数に到達するフレーム(index 0, 3, 6, 9, ...)が採用される。
    const delaysMs = Array.from({ length: 12 }, () => 50);
    expect(pickIndicesByInterval(delaysMs, 150, 600)).toEqual([0, 3, 6, 9]);
  });

  it('ディレイが不均一な場合、index均等ではなく時間軸に沿って採用する', () => {
    // 前半 20 フレームが 20ms、後半 5 フレームが 1000ms(総再生時間 5400ms)の
    // 不均一ディレイGIF。采配役が検証に使うケースと同じ期待値を確認する。
    const delaysMs = [...Array<number>(20).fill(20), ...Array<number>(5).fill(1000)];

    // 間隔20ms → 実効間隔もほぼ20msのままなので全フレーム(25件)が採用される。
    expect(pickIndicesByInterval(delaysMs, 20, 600)).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );

    // 間隔200ms → index 0, 10, 20, 21, 22, 23, 24 の7件。
    expect(pickIndicesByInterval(delaysMs, 200, 600)).toEqual([0, 10, 20, 21, 22, 23, 24]);

    // 間隔1000ms → index 0, 21, 22, 23, 24 の5件。
    expect(pickIndicesByInterval(delaysMs, 1000, 600)).toEqual([0, 21, 22, 23, 24]);
  });

  it('上限超過で実効間隔が広がり、maxSamples件に収まる', () => {
    // 100 フレーム、各ディレイ 10ms(総再生時間 1000ms)。間隔 10ms のままだと
    // 100 件になり maxSamples(10)を超えるため、実効間隔は
    // Math.ceil(1000 / 10) = 100ms まで広がり、10 件ちょうどに収まる。
    const delaysMs = Array.from({ length: 100 }, () => 10);
    const result = pickIndicesByInterval(delaysMs, 10, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('フレームが1枚のみの場合、index 0のみを返す', () => {
    expect(pickIndicesByInterval([100], 200, 600)).toEqual([0]);
  });

  it('空配列の場合、空配列を返す', () => {
    expect(pickIndicesByInterval([], 200, 600)).toEqual([]);
  });

  it('先頭フレーム(index 0)は常に採用される', () => {
    const delaysMs = [5000, 10, 10, 10];
    expect(pickIndicesByInterval(delaysMs, 20, 600)[0]).toBe(0);
  });

  it('同じフレームを二度採用しない(戻り値に重複がない)', () => {
    const delaysMs = Array.from({ length: 30 }, () => 33);
    const result = pickIndicesByInterval(delaysMs, 20, 600);
    expect(new Set(result).size).toBe(result.length);
  });
});

describe('planCompositeRange', () => {
  it('未合成(renderedUpTo = null)なら、0 から合成を開始する', () => {
    expect(planCompositeRange(null, 5)).toEqual({ reset: true, from: 0 });
  });

  it('目標が合成済みより後ろなら、合成済み+1 から続きを合成する(リセット不要)', () => {
    expect(planCompositeRange(3, 7)).toEqual({ reset: false, from: 4 });
  });

  it('目標が合成済みと同じなら、from が目標を上回りループが回らない(再合成不要)', () => {
    const plan = planCompositeRange(5, 5);
    expect(plan.reset).toBe(false);
    expect(plan.from).toBeGreaterThan(5);
  });

  it('目標が合成済みより前なら、リセットして 0 から合成し直す', () => {
    expect(planCompositeRange(9, 2)).toEqual({ reset: true, from: 0 });
  });
});
