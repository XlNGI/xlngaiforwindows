import { expect, it } from 'vitest';
import {
  applyProductionFacts,
  emptyProductionFacts,
  seedProductionFacts,
} from './production-continuity.js';
import type { ProductionFact, ProductionInstruction } from './production.js';

const continuity = (patch: Partial<ProductionInstruction['continuity']>) => ({
  predecessors: [],
  before: [],
  after: [],
  locked: [],
  constraints: [],
  ...patch,
});
const comparable = (value: string, state: string): ProductionFact => ({
  key: '信封位置',
  value,
  comparison: { entity: { kind: 'scene', id: 'saved-scene' }, attribute: 'letter.location', state },
});

it('compares stable identity/state across prose changes and distinguishes absent evidence', () => {
  const state = seedProductionFacts(continuity({ before: [comparable('手里', 'held')] }));
  expect(
    applyProductionFacts(
      state,
      continuity({ before: [comparable('在手中轻轻展开', 'held')] }),
      true,
    ),
  ).toEqual([]);
  expect(
    applyProductionFacts(state, continuity({ before: [comparable('桌面', 'table')] }), true).map(
      (issue) => issue.code,
    ),
  ).toContain('CONTINUITY_CONFLICT');
  expect(
    applyProductionFacts(
      emptyProductionFacts(),
      continuity({ before: [comparable('手里', 'held')] }),
      true,
    ).map((issue) => issue.code),
  ).toEqual(['CONTINUITY_UNVERIFIED']);
});

it('never reuses an obsolete legacy value after its fact changes representation', () => {
  const state = seedProductionFacts(continuity({ before: [{ key: '信封位置', value: '手里' }] }));
  applyProductionFacts(state, continuity({ after: [comparable('桌面', 'table')] }));
  expect(state.ending.size).toBe(1);
  expect(
    applyProductionFacts(
      state,
      continuity({ before: [{ key: '信封位置', value: '手里' }] }),
      true,
    ).map((issue) => issue.code),
  ).toEqual(['CONTINUITY_UNVERIFIED']);
});

it('preserves locks through display-key variation and blocks a conflicting stable state', () => {
  const state = seedProductionFacts(continuity({ locked: [comparable('手中', 'held')] }));
  expect(
    applyProductionFacts(
      state,
      continuity({ after: [{ ...comparable('仍拿着信封', 'held'), key: '信封动作' }] }),
    ),
  ).toEqual([]);
  expect(
    applyProductionFacts(state, continuity({ after: [comparable('放在桌面', 'table')] })).map(
      (issue) => issue.code,
    ),
  ).toEqual(['LOCKED_FACT_CHANGED']);
});
