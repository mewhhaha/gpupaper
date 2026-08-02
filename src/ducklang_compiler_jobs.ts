import { visitDucklangExpressionChildren } from "./ducklang_closures.ts";
import type {
  TypedDucklangExpression,
  TypedDucklangModule,
} from "./ducklang_types.ts";

export const ducklangCompilerJobSchemaVersion = 1 as const;

export type DucklangCompilerJobIR = {
  readonly schemaVersion: typeof ducklangCompilerJobSchemaVersion;
  readonly jobSourceOrdinals: Uint32Array;
  readonly jobSymbolIds: Uint32Array;
  readonly jobSourceStarts: Uint32Array;
  readonly jobSourceEnds: Uint32Array;
  readonly jobEstimatedWork: Uint32Array;
  readonly relocationStarts: Uint32Array;
  readonly relocationCounts: Uint32Array;
  readonly relocationTargetJobIds: Uint32Array;
  readonly semanticDependencyStarts: Uint32Array;
  readonly semanticDependencyCounts: Uint32Array;
  readonly semanticDependencyJobIds: Uint32Array;
  readonly relocationComponentIds: Uint32Array;
  readonly relocationComponentLevels: Uint32Array;
};

export type DucklangCompilerJobMetrics = {
  readonly jobCount: number;
  readonly estimatedWork: number;
  readonly relocationCount: number;
  readonly distinctRelocationEdgeCount: number;
  readonly semanticDependencyCount: number;
  readonly semanticMaximumFrontierJobCount: number;
  readonly semanticWeightedSpan: number;
  readonly semanticWorkToSpanRatio: number;
  readonly relocationComponentCount: number;
  readonly relocationCyclicComponentCount: number;
  readonly relocationCyclicJobCount: number;
  readonly relocationLevelCount: number;
  readonly relocationMaximumFrontierJobCount: number;
  readonly relocationWeightedSpan: number;
  readonly relocationWorkToSpanRatio: number;
};

export type AnalyzedDucklangCompilerJobs = {
  readonly package: DucklangCompilerJobIR;
  readonly metrics: DucklangCompilerJobMetrics;
};

const absent = 0xffff_ffff;

export function constructDucklangCompilerJobs(
  module: TypedDucklangModule,
): AnalyzedDucklangCompilerJobs {
  const symbolJobIds = new Map<number, number>();
  for (const [jobId, binding] of module.bindings.entries()) {
    if (symbolJobIds.has(binding.symbol.id)) {
      throw new TypeError(
        `Ducklang compiler jobs contain duplicate symbol ${binding.symbol.id}`,
      );
    }
    symbolJobIds.set(binding.symbol.id, jobId);
  }

  const expressions = [
    ...module.bindings.map((binding) => binding.value),
    module.result,
  ];
  const relocationStarts: number[] = [];
  const relocationCounts: number[] = [];
  const relocationTargetJobIds: number[] = [];
  const estimatedWork: number[] = [];

  for (const expression of expressions) {
    relocationStarts.push(relocationTargetJobIds.length);
    const inspection = inspectExpression(expression, symbolJobIds);
    relocationCounts.push(inspection.relocationTargetJobIds.length);
    relocationTargetJobIds.push(...inspection.relocationTargetJobIds);
    estimatedWork.push(inspection.nodeCount);
  }

  const relocationGraph = analyzeRelocationGraph(
    expressions.length,
    relocationStarts,
    relocationCounts,
    relocationTargetJobIds,
    estimatedWork,
  );
  const package_: DucklangCompilerJobIR = {
    schemaVersion: ducklangCompilerJobSchemaVersion,
    jobSourceOrdinals: Uint32Array.from(
      expressions.map((_, sourceOrdinal) => sourceOrdinal),
    ),
    jobSymbolIds: Uint32Array.from([
      ...module.bindings.map((binding) => binding.symbol.id),
      absent,
    ]),
    jobSourceStarts: Uint32Array.from([
      ...module.bindings.map((binding) => binding.span.start),
      module.result.span.start,
    ]),
    jobSourceEnds: Uint32Array.from([
      ...module.bindings.map((binding) => binding.span.end),
      module.result.span.end,
    ]),
    jobEstimatedWork: Uint32Array.from(estimatedWork),
    relocationStarts: Uint32Array.from(relocationStarts),
    relocationCounts: Uint32Array.from(relocationCounts),
    relocationTargetJobIds: Uint32Array.from(relocationTargetJobIds),
    semanticDependencyStarts: new Uint32Array(expressions.length),
    semanticDependencyCounts: new Uint32Array(expressions.length),
    semanticDependencyJobIds: new Uint32Array(),
    relocationComponentIds: Uint32Array.from(
      relocationGraph.jobComponentIds,
    ),
    relocationComponentLevels: Uint32Array.from(
      relocationGraph.componentLevels,
    ),
  };
  return validateDucklangCompilerJobs(package_);
}

export function validateDucklangCompilerJobs(
  package_: DucklangCompilerJobIR,
): AnalyzedDucklangCompilerJobs {
  if (package_.schemaVersion !== ducklangCompilerJobSchemaVersion) {
    throw new TypeError(
      `Ducklang compiler job schema version must be ${ducklangCompilerJobSchemaVersion}; received ${package_.schemaVersion}`,
    );
  }
  equalLengths(
    "job",
    package_.jobSourceOrdinals,
    package_.jobSymbolIds,
    package_.jobSourceStarts,
    package_.jobSourceEnds,
    package_.jobEstimatedWork,
    package_.relocationStarts,
    package_.relocationCounts,
    package_.semanticDependencyStarts,
    package_.semanticDependencyCounts,
    package_.relocationComponentIds,
  );
  const jobCount = package_.jobSourceOrdinals.length;
  if (jobCount === 0) {
    throw new RangeError(
      "Ducklang compiler jobs must include the module result",
    );
  }
  for (let jobId = 0; jobId < jobCount; jobId += 1) {
    if (package_.jobSourceOrdinals[jobId] !== jobId) {
      throw new RangeError(
        `Ducklang compiler job ${jobId} has source ordinal ${
          package_.jobSourceOrdinals[jobId]
        }; expected ${jobId}`,
      );
    }
    if (package_.jobSourceStarts[jobId] > package_.jobSourceEnds[jobId]) {
      throw new RangeError(
        `Ducklang compiler job ${jobId} source range ${
          package_.jobSourceStarts[jobId]
        }..${package_.jobSourceEnds[jobId]} is reversed`,
      );
    }
    if (package_.jobEstimatedWork[jobId] === 0) {
      throw new RangeError(
        `Ducklang compiler job ${jobId} has zero estimated work`,
      );
    }
  }
  const resultJobId = jobCount - 1;
  if (package_.jobSymbolIds[resultJobId] !== absent) {
    throw new RangeError(
      `Ducklang compiler result job ${resultJobId} has symbol ${
        package_.jobSymbolIds[resultJobId]
      }; expected absent`,
    );
  }
  const symbols = new Set<number>();
  for (let jobId = 0; jobId < resultJobId; jobId += 1) {
    const symbolId = package_.jobSymbolIds[jobId];
    if (symbolId === absent) {
      throw new RangeError(
        `Ducklang compiler binding job ${jobId} has no stable symbol`,
      );
    }
    if (symbols.has(symbolId)) {
      throw new RangeError(
        `Ducklang compiler binding jobs contain duplicate symbol ${symbolId}`,
      );
    }
    symbols.add(symbolId);
  }

  contiguousRanges(
    "relocation",
    package_.relocationStarts,
    package_.relocationCounts,
    package_.relocationTargetJobIds.length,
  );
  validateJobIds(
    package_.relocationTargetJobIds,
    jobCount,
    "relocation target",
  );
  contiguousRanges(
    "semantic dependency",
    package_.semanticDependencyStarts,
    package_.semanticDependencyCounts,
    package_.semanticDependencyJobIds.length,
  );
  if (package_.semanticDependencyJobIds.length !== 0) {
    throw new RangeError(
      `post-specialization Ducklang compiler jobs have frozen interfaces but received ${package_.semanticDependencyJobIds.length} semantic dependencies`,
    );
  }

  const relocationGraph = analyzeRelocationGraph(
    jobCount,
    package_.relocationStarts,
    package_.relocationCounts,
    package_.relocationTargetJobIds,
    package_.jobEstimatedWork,
  );
  equalColumns(
    "relocation component IDs",
    package_.relocationComponentIds,
    relocationGraph.jobComponentIds,
  );
  equalColumns(
    "relocation component levels",
    package_.relocationComponentLevels,
    relocationGraph.componentLevels,
  );

  const estimatedWork = sum(package_.jobEstimatedWork);
  const semanticWeightedSpan = maximum(package_.jobEstimatedWork);
  return {
    package: package_,
    metrics: {
      jobCount,
      estimatedWork,
      relocationCount: package_.relocationTargetJobIds.length,
      distinctRelocationEdgeCount: relocationGraph.distinctEdgeCount,
      semanticDependencyCount: 0,
      semanticMaximumFrontierJobCount: jobCount,
      semanticWeightedSpan,
      semanticWorkToSpanRatio: estimatedWork / semanticWeightedSpan,
      relocationComponentCount: relocationGraph.componentLevels.length,
      relocationCyclicComponentCount: relocationGraph.cyclicComponentCount,
      relocationCyclicJobCount: relocationGraph.cyclicJobCount,
      relocationLevelCount: relocationGraph.levelCount,
      relocationMaximumFrontierJobCount:
        relocationGraph.maximumFrontierJobCount,
      relocationWeightedSpan: relocationGraph.weightedSpan,
      relocationWorkToSpanRatio: estimatedWork / relocationGraph.weightedSpan,
    },
  };
}

type ExpressionInspection = {
  readonly nodeCount: number;
  readonly relocationTargetJobIds: readonly number[];
};

function inspectExpression(
  root: TypedDucklangExpression,
  symbolJobIds: ReadonlyMap<number, number>,
): ExpressionInspection {
  let nodeCount = 0;
  const relocationTargetJobIds: number[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const expression = pending.pop()!;
    nodeCount += 1;
    if (expression.kind === "reference") {
      const targetJobId = symbolJobIds.get(expression.symbol.id);
      if (targetJobId !== undefined) {
        relocationTargetJobIds.push(targetJobId);
      }
    }
    const children: TypedDucklangExpression[] = [];
    visitDucklangExpressionChildren(expression, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  return { nodeCount, relocationTargetJobIds };
}

type RelocationGraphAnalysis = {
  readonly jobComponentIds: readonly number[];
  readonly componentLevels: readonly number[];
  readonly distinctEdgeCount: number;
  readonly cyclicComponentCount: number;
  readonly cyclicJobCount: number;
  readonly levelCount: number;
  readonly maximumFrontierJobCount: number;
  readonly weightedSpan: number;
};

function analyzeRelocationGraph(
  jobCount: number,
  relocationStarts: ArrayLike<number>,
  relocationCounts: ArrayLike<number>,
  relocationTargetJobIds: ArrayLike<number>,
  jobEstimatedWork: ArrayLike<number>,
): RelocationGraphAnalysis {
  const dependencies = Array.from(
    { length: jobCount },
    () => new Set<number>(),
  );
  for (let jobId = 0; jobId < jobCount; jobId += 1) {
    const end = relocationStarts[jobId] + relocationCounts[jobId];
    for (let index = relocationStarts[jobId]; index < end; index += 1) {
      dependencies[jobId].add(relocationTargetJobIds[index]);
    }
  }

  const rawComponents = stronglyConnectedComponents(dependencies);
  rawComponents.sort((left, right) => left[0] - right[0]);
  const jobComponentIds = new Array<number>(jobCount);
  for (const [componentId, jobs] of rawComponents.entries()) {
    for (const jobId of jobs) jobComponentIds[jobId] = componentId;
  }

  const componentDependencies = rawComponents.map(() => new Set<number>());
  const componentWork = rawComponents.map(() => 0);
  let cyclicComponentCount = 0;
  let cyclicJobCount = 0;
  for (const [componentId, jobs] of rawComponents.entries()) {
    componentWork[componentId] = jobs.reduce(
      (total, jobId) => total + jobEstimatedWork[jobId],
      0,
    );
    const cyclic = jobs.length > 1 || dependencies[jobs[0]].has(jobs[0]);
    if (cyclic) {
      cyclicComponentCount += 1;
      cyclicJobCount += jobs.length;
    }
    for (const jobId of jobs) {
      for (const dependencyJobId of dependencies[jobId]) {
        const dependencyComponentId = jobComponentIds[dependencyJobId];
        if (dependencyComponentId !== componentId) {
          componentDependencies[componentId].add(dependencyComponentId);
        }
      }
    }
  }

  const componentLevels = new Array<number>(rawComponents.length).fill(-1);
  const componentSpans = new Array<number>(rawComponents.length).fill(0);
  const visitComponent = (componentId: number): void => {
    if (componentLevels[componentId] >= 0) return;
    let level = 0;
    let predecessorSpan = 0;
    for (const dependencyId of componentDependencies[componentId]) {
      visitComponent(dependencyId);
      level = Math.max(level, componentLevels[dependencyId] + 1);
      predecessorSpan = Math.max(
        predecessorSpan,
        componentSpans[dependencyId],
      );
    }
    componentLevels[componentId] = level;
    componentSpans[componentId] = predecessorSpan + componentWork[componentId];
  };
  for (
    let componentId = 0;
    componentId < rawComponents.length;
    componentId += 1
  ) {
    visitComponent(componentId);
  }

  const levelCount = maximum(componentLevels) + 1;
  const frontierJobCounts = new Array<number>(levelCount).fill(0);
  for (const [componentId, level] of componentLevels.entries()) {
    frontierJobCounts[level] += rawComponents[componentId].length;
  }
  return {
    jobComponentIds,
    componentLevels,
    distinctEdgeCount: dependencies.reduce(
      (total, targets) => total + targets.size,
      0,
    ),
    cyclicComponentCount,
    cyclicJobCount,
    levelCount,
    maximumFrontierJobCount: maximum(frontierJobCounts),
    weightedSpan: maximum(componentSpans),
  };
}

function stronglyConnectedComponents(
  dependencies: readonly ReadonlySet<number>[],
): number[][] {
  const discovery = new Int32Array(dependencies.length).fill(-1);
  const lowLink = new Int32Array(dependencies.length);
  const active = new Uint8Array(dependencies.length);
  const stack: number[] = [];
  const components: number[][] = [];
  let nextDiscovery = 0;

  const visit = (jobId: number): void => {
    discovery[jobId] = nextDiscovery;
    lowLink[jobId] = nextDiscovery;
    nextDiscovery += 1;
    stack.push(jobId);
    active[jobId] = 1;

    for (const dependencyId of dependencies[jobId]) {
      if (discovery[dependencyId] < 0) {
        visit(dependencyId);
        lowLink[jobId] = Math.min(lowLink[jobId], lowLink[dependencyId]);
      } else if (active[dependencyId] === 1) {
        lowLink[jobId] = Math.min(lowLink[jobId], discovery[dependencyId]);
      }
    }
    if (lowLink[jobId] !== discovery[jobId]) return;

    const component: number[] = [];
    while (stack.length > 0) {
      const memberId = stack.pop()!;
      active[memberId] = 0;
      component.push(memberId);
      if (memberId === jobId) break;
    }
    component.sort((left, right) => left - right);
    components.push(component);
  };

  for (let jobId = 0; jobId < dependencies.length; jobId += 1) {
    if (discovery[jobId] < 0) visit(jobId);
  }
  return components;
}

function equalLengths(
  subject: string,
  ...columns: readonly ArrayLike<unknown>[]
): void {
  const lengths = columns.map((column) => column.length);
  if (lengths.every((length) => length === lengths[0])) return;
  throw new TypeError(
    `Ducklang compiler job ${subject} columns must have equal lengths; received ${
      lengths.join(", ")
    }`,
  );
}

function contiguousRanges(
  subject: string,
  starts: Uint32Array,
  counts: Uint32Array,
  total: number,
): void {
  let expected = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const count = counts[index];
    if (start !== expected) {
      throw new RangeError(
        `Ducklang compiler job ${subject} ${index} starts at ${start}; expected contiguous start ${expected}`,
      );
    }
    if (count > total - start) {
      throw new RangeError(
        `Ducklang compiler job ${subject} ${index} range ${start}..${
          start + count
        } exceeds length ${total}`,
      );
    }
    expected += count;
  }
  if (expected !== total) {
    throw new RangeError(
      `Ducklang compiler job ${subject} ranges cover ${expected}; column has ${total}`,
    );
  }
}

function validateJobIds(
  ids: Uint32Array,
  jobCount: number,
  subject: string,
): void {
  for (const [index, jobId] of ids.entries()) {
    if (jobId < jobCount) continue;
    throw new RangeError(
      `Ducklang compiler job ${subject} ${index} is ${jobId}; expected less than ${jobCount}`,
    );
  }
}

function equalColumns(
  subject: string,
  actual: Uint32Array,
  expected: readonly number[],
): void {
  if (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  ) return;
  throw new RangeError(
    `Ducklang compiler job ${subject} disagree with relocation graph`,
  );
}

function sum(values: ArrayLike<number>): number {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index];
  }
  return total;
}

function maximum(values: ArrayLike<number>): number {
  let result = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    result = Math.max(result, values[index]);
  }
  return result;
}
