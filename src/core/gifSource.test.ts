import { describe, expect, it } from 'vitest';
import { planCompositeRange } from './gifSource';

describe('planCompositeRange', () => {
  it('未合成(renderedUpTo = null)なら、リセット不要で 0 から合成を開始する', () => {
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
