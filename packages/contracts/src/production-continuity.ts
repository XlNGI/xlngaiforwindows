import type { ProductionFact, ProductionInstruction, ProductionIssue } from './production.js';

export type ProductionFactState = {
  ending: Map<string, ProductionFact>;
  locked: Map<string, ProductionFact>;
};

export function productionFactKey(fact: ProductionFact): string {
  return fact.comparison
    ? JSON.stringify([
        fact.comparison.entity.kind,
        fact.comparison.entity.id,
        fact.comparison.attribute,
      ])
    : `legacy:${fact.key}`;
}

function findFact(values: Map<string, ProductionFact>, fact: ProductionFact) {
  return (
    values.get(productionFactKey(fact)) ??
    [...values.values()].find(
      (other) => other.key === fact.key && (!other.comparison || !fact.comparison),
    )
  );
}

function relation(a: ProductionFact, b: ProductionFact): 'equal' | 'different' | 'unverified' {
  if (a.comparison && b.comparison)
    return a.comparison.state === b.comparison.state ? 'equal' : 'different';
  return !a.comparison && !b.comparison && a.value === b.value ? 'equal' : 'unverified';
}

function setFact(values: Map<string, ProductionFact>, fact: ProductionFact): void {
  const previous = findFact(values, fact);
  if (previous) values.delete(productionFactKey(previous));
  values.set(productionFactKey(fact), fact);
}

export function emptyProductionFacts(): ProductionFactState {
  return { ending: new Map(), locked: new Map() };
}

export function seedProductionFacts(
  continuity: ProductionInstruction['continuity'],
): ProductionFactState {
  return {
    ending: new Map(
      [...continuity.before, ...continuity.locked].map((f) => [productionFactKey(f), f]),
    ),
    locked: new Map(continuity.locked.map((f) => [productionFactKey(f), f])),
  };
}

/** Missing evidence and prose variation are never proof of a state contradiction. */
export function mergeProductionFacts(
  into: Map<string, ProductionFact>,
  incoming: Map<string, ProductionFact>,
  locked = false,
): ProductionIssue[] {
  const issues: ProductionIssue[] = [];
  for (const fact of incoming.values()) {
    const previous = findFact(into, fact);
    const compared = previous && relation(previous, fact);
    if (compared && compared !== 'equal')
      issues.push({
        code: locked
          ? 'LOCKED_FACT_CHANGED'
          : compared === 'different'
            ? 'CONTINUITY_CONFLICT'
            : 'CONTINUITY_UNVERIFIED',
        message: `前置对象对状态「${fact.key}」${locked ? '的锁定值发生变化' : compared === 'different' ? '给出了不同的结构化值' : '的文字不同，缺少可比较证据，请核实；不要补造前置剧情'}。`,
      });
    setFact(into, fact);
  }
  return issues;
}

/** Used by graph validation and ordered scene compilation. Mutates only local fact maps. */
export function applyProductionFacts(
  state: ProductionFactState,
  continuity: ProductionInstruction['continuity'],
  requireBeforeEvidence = false,
): ProductionIssue[] {
  const issues: ProductionIssue[] = [];
  for (const fact of continuity.before) {
    const previous = findFact(state.ending, fact);
    const compared = previous && relation(previous, fact);
    if ((!previous && requireBeforeEvidence) || (compared && compared !== 'equal'))
      issues.push({
        code: compared === 'different' ? 'CONTINUITY_CONFLICT' : 'CONTINUITY_UNVERIFIED',
        message:
          compared === 'different'
            ? `开始状态「${fact.key}」与前置结构化状态矛盾。`
            : `开始状态「${fact.key}」缺少可比较的前置证据，请核实；不要补造前置剧情。`,
      });
  }
  issues.push(
    ...mergeProductionFacts(
      state.locked,
      new Map(continuity.locked.map((f) => [productionFactKey(f), f])),
      true,
    ),
  );
  for (const fact of [...continuity.before, ...continuity.after]) {
    const lock = findFact(state.locked, fact);
    if (lock && relation(lock, fact) !== 'equal')
      issues.push({
        code: 'LOCKED_FACT_CHANGED',
        message: `锁定状态「${fact.key}」发生变化或缺少等值证据。`,
      });
    setFact(state.ending, fact);
  }
  for (const fact of state.locked.values()) setFact(state.ending, fact);
  return issues;
}
