export type ZeroWorkload = {
  readonly name: string;
  readonly challenge: string;
  readonly zeroSourceUrl: URL;
  readonly rustSourceUrl: URL;
  readonly reference: (seed: number, rounds: number) => number;
};

const directory = new URL("./workloads/", import.meta.url);

export const zeroWorkloads: readonly ZeroWorkload[] = [
  workload("01-affine", "straight-line wrapping arithmetic", affineReference),
  workload(
    "02-diamond",
    "loop-carried value with a control-flow diamond",
    diamondReference,
  ),
  workload("03-call-graph", "multi-function call graph", callGraphReference),
  workload(
    "04-branch-forest",
    "nested predicates and signed remainder",
    branchForestReference,
  ),
  workload(
    "05-nested-loop",
    "nested bounded folds with carried state",
    nestedLoopReference,
  ),
  workload(
    "06-broad-module",
    "broad and deep call graph",
    broadModuleReference,
  ),
  workload(
    "07-shared-call-dag",
    "shared callee reached through two call paths",
    sharedCallDagReference,
  ),
  workload(
    "08-wide-binding-frontier",
    "wide block-local live-value frontier",
    wideBindingFrontierReference,
  ),
  workload(
    "09-partial-lazy",
    "partial arithmetic guarded by lazy control",
    partialLazyReference,
  ),
  workload(
    "10-dead-module",
    "large unreachable function set",
    deadModuleReference,
  ),
  workload(
    "11-polynomial",
    "monolithic nonlinear recurrence",
    polynomialReference,
  ),
  workload(
    "12-deep-polynomial-chain",
    "nonlinear recurrence behind a deep unique call chain",
    polynomialReference,
  ),
  workload(
    "13-shared-polynomial-dag",
    "nonlinear recurrence behind a shared call DAG",
    polynomialReference,
  ),
  workload(
    "14-dynamic-nested-fold",
    "value-dependent nested fold",
    dynamicNestedFoldReference,
  ),
  workload(
    "15-fixed-affine-seven",
    "fixed affine fold at the linear-lowering boundary",
    fixedAffineFoldReference(7),
  ),
  workload(
    "16-fixed-affine-eight",
    "fixed affine fold at the exponentiation boundary",
    fixedAffineFoldReference(8),
  ),
  workload(
    "17-fixed-affine-sixteen",
    "fixed affine fold with moderate composition depth",
    fixedAffineFoldReference(16),
  ),
  workload(
    "18-fixed-affine-thirty-two",
    "fixed affine fold with larger composition depth",
    fixedAffineFoldReference(32),
  ),
  workload(
    "19-affine-pretransform",
    "fixed affine fold after affine state preparation",
    affineRegionReference(
      (value) => (Math.imul(value, 3) + 5) | 0,
      (value) => value,
    ),
  ),
  workload(
    "20-affine-reset",
    "fixed affine fold from a constant replacement state",
    affineRegionReference(
      () => 5,
      (value) => value,
    ),
  ),
  workload(
    "21-affine-posttransform",
    "fixed affine fold before affine result finishing",
    affineRegionReference(
      (value) => value,
      (value) => (Math.imul(value, 3) + 5) | 0,
    ),
  ),
  workload(
    "22-affine-sandwich",
    "fixed affine fold between affine preparation and finishing",
    affineRegionReference(
      (value) => (Math.imul(value, 3) + 5) | 0,
      (value) => (Math.imul(value, 7) - 11) | 0,
    ),
  ),
  workload(
    "23-shared-leaf-fanout-five",
    "shared pure leaf one reference beyond the copy cap",
    sharedLeafFanoutFiveReference,
  ),
  workload(
    "24-over-budget-call-chain",
    "nonlinear scalar call chain beyond the expansion budget",
    overBudgetCallChainReference,
  ),
  workload(
    "25-wide-frontier-thirty-two",
    "thirty-two simultaneously live scalar bindings",
    wideFrontierThirtyTwoReference,
  ),
  workload(
    "26-oversized-nested-fold",
    "nested nonlinear fold beyond the composition budget",
    oversizedNestedFoldReference,
  ),
];

function workload(
  name: string,
  challenge: string,
  reference: (seed: number, rounds: number) => number,
): ZeroWorkload {
  return {
    name,
    challenge,
    zeroSourceUrl: new URL(`${name}.zero`, directory),
    rustSourceUrl: new URL(`${name}.rs`, directory),
    reference,
  };
}

function repeat(
  rounds: number,
  seed: number,
  step: (value: number) => number,
): number {
  let state = seed | 0;
  for (let remaining = rounds; remaining > 0; remaining -= 1) {
    state = step(state);
  }
  return state;
}

function affine(value: number): number {
  return (Math.imul(value, 1_664_525) + 1_013_904_223) | 0;
}

function affineReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, affine);
}

function diamond(value: number): number {
  const mixed = affine(value);
  return mixed < 0 ? (mixed + 12_345) | 0 : (mixed - 12_345) | 0;
}

function diamondReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, diamond);
}

function callGraphReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    const mixed = affine(value);
    return mixed < 0
      ? (Math.imul(mixed, 3) + 7) | 0
      : (Math.imul(mixed, 5) - 11) | 0;
  });
}

function branchForestReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    const mixed = (Math.imul(value, 1_103_515_245) + 12_345) | 0;
    if (mixed % 7 === 0) return (mixed + 17) | 0;
    if (mixed % 5 === 0) return (mixed - 31) | 0;
    if (mixed < 0) return (Math.imul(mixed, 3) + 1) | 0;
    return (Math.imul(mixed, 5) - 1) | 0;
  });
}

function nestedLoopReference(seed: number, rounds: number): number {
  return repeat(
    rounds,
    seed,
    (outer) =>
      repeat(4, outer, (inner) => {
        const mixed = affine(inner);
        return mixed < 0 ? (mixed + 97) | 0 : (mixed - 89) | 0;
      }),
  );
}

function broadModuleReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    const left = (Math.imul(value, 3) + 17) | 0;
    const right = (Math.imul(value, 5) - 29) | 0;
    const joined = (left + right) | 0;
    const classified = joined < 0 ? (joined + 101) | 0 : (joined - 103) | 0;
    const rotated = (Math.imul(classified, 9) + 7) | 0;
    return rotated % 11 === 0 ? (rotated + left) | 0 : (rotated - right) | 0;
  });
}

function sharedCallDagReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    const left = (Math.imul(affine(value), 3) + 17) | 0;
    const right = (Math.imul(affine(value), 5) - 29) | 0;
    return (left + right) | 0;
  });
}

function wideBindingFrontierReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    const a = (Math.imul(value, 3) + 17) | 0;
    const b = (Math.imul(value, 5) - 29) | 0;
    const c = (Math.imul(value, 7) + 43) | 0;
    const d = (Math.imul(value, 11) - 61) | 0;
    return (Math.imul((a + b) | 0, (c - d) | 0) + ((a + d) | 0)) | 0;
  });
}

function partialLazyReference(seed: number, rounds: number): number {
  return repeat(
    rounds,
    seed,
    (value) => value === 0 ? 1 : (Math.trunc(1_000_000_000 / value) + 17) | 0,
  );
}

function deadModuleReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, affine);
}

function polynomial(value: number): number {
  const mixed = (value + 78) | 0;
  return (
    Math.imul(Math.imul(mixed, mixed), 3) + Math.imul(mixed, 5) + 17
  ) | 0;
}

function polynomialReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, polynomial);
}

function dynamicNestedFoldReference(seed: number, rounds: number): number {
  return repeat(
    rounds,
    seed,
    (value) => repeat(value % 7, value, affine),
  );
}

function fixedAffineFoldReference(
  innerRounds: number,
): (seed: number, rounds: number) => number {
  return (seed, rounds) =>
    repeat(rounds, seed, (value) => repeat(innerRounds, value, affine));
}

function affineRegionReference(
  prepare: (value: number) => number,
  finish: (value: number) => number,
): (seed: number, rounds: number) => number {
  return (seed, rounds) =>
    repeat(
      rounds,
      seed,
      (value) => finish(repeat(8, prepare(value), affine)),
    );
}

function sharedLeafFanoutFiveReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    const shifted = (input: number) => (input + 78) | 0;
    const left = Math.imul(shifted(value), shifted((value + 1) | 0));
    const right = Math.imul(
      shifted((value + 2) | 0),
      shifted((value + 3) | 0),
    );
    return (left + right + shifted((value + 4) | 0)) | 0;
  });
}

function overBudgetCallChainReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    let state = polynomial(value);
    for (let stage = 0; stage < 16; stage += 1) {
      state = (Math.imul(state, 3) + 7) | 0;
    }
    return state;
  });
}

function wideFrontierThirtyTwoReference(seed: number, rounds: number): number {
  return repeat(rounds, seed, (value) => {
    let sum = 0;
    for (let index = 0; index < 32; index += 1) {
      const term = (
        Math.imul(value, index + 2) + (index * 2 + 1)
      ) | 0;
      sum = (sum + term) | 0;
    }
    return Math.imul(sum, sum);
  });
}

function oversizedNestedFoldReference(seed: number, rounds: number): number {
  return repeat(
    rounds,
    seed,
    (value) => repeat(8, value, oversizedNestedStep),
  );
}

function oversizedNestedStep(value: number): number {
  const mixed = (value + 78) | 0;
  const square = Math.imul(mixed, mixed);
  const cube = Math.imul(square, mixed);
  const left = (Math.imul(cube, 3) + Math.imul(square, 5)) | 0;
  const right = (Math.imul(mixed, 7) + 11) | 0;
  const joined = (left + right) | 0;
  const twisted = (Math.imul(joined, mixed) + 19) | 0;
  return (Math.imul(twisted, twisted) + joined + 23) | 0;
}
