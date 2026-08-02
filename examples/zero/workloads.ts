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
