import {
  compileModuleSource,
  createDucklangCompilationSession,
} from "../src/compiler.ts";

Deno.test("Ducklang compilation profile accounts for every top-level stage", async () => {
  const source = `let add = (left: I32, right: I32) => left + right
add(20, 22)
`;
  const artifact = await compileModuleSource("profile.duck", source, {
    gpuMode: "off",
  });
  const profile = artifact.profile;
  const stageTotal = Object.values(profile.stages).reduce(
    (total, milliseconds) => total + milliseconds,
    0,
  );

  assertClose(profile.accountedMilliseconds, stageTotal);
  assertClose(
    profile.unattributedMilliseconds,
    profile.totalMilliseconds - profile.accountedMilliseconds,
  );
  if (profile.unattributedMilliseconds < 0) {
    throw new Error(
      `profile attributed ${profile.accountedMilliseconds}ms inside ${profile.totalMilliseconds}ms total`,
    );
  }
  for (const [stage, milliseconds] of Object.entries(profile.stages)) {
    if (milliseconds < 0) {
      throw new Error(`stage ${stage} reported ${milliseconds}ms`);
    }
  }
});

Deno.test("Ducklang compilation profile relates detailed costs to work volume", async () => {
  const source = `let add = (left: I32, right: I32) => left + right
add(20, 22)
`;
  const artifact = await compileModuleSource("profile.duck", source, {
    gpuMode: "off",
  });
  const { details, stages, work } = artifact.profile;

  assertContains(
    stages.parsingMilliseconds,
    details.parserInitializationMilliseconds +
      details.contextualClassificationMilliseconds +
      details.parserExecutionMilliseconds +
      details.astLoweringMilliseconds,
    "parsing",
  );
  assertContains(
    stages.typeAnalysisMilliseconds,
    details.typeInferenceMilliseconds + details.typeReflectionMilliseconds,
    "type analysis",
  );
  assertContains(
    details.controlFlowLoweringMilliseconds,
    details.controlFlowFirstPassMilliseconds +
      details.controlFlowSubsequentPassMilliseconds,
    "control-flow lowering",
  );
  assertContains(
    stages.cpuCoreRewriteMilliseconds,
    details.cpuCoreValidationMilliseconds +
      details.cpuCoreMatchingMilliseconds +
      details.cpuCoreConflictResolutionMilliseconds +
      details.cpuCoreRebuildMilliseconds,
    "CPU Core rewrite",
  );
  if (stages.gpuCorePassMilliseconds !== 0) {
    throw new Error(
      `CPU compilation reported ${stages.gpuCorePassMilliseconds}ms of GPU Core work`,
    );
  }
  if (work.sourceBytes !== new TextEncoder().encode(source).byteLength) {
    throw new Error(
      `profile counted ${work.sourceBytes} source bytes; expected ${
        new TextEncoder().encode(source).byteLength
      }`,
    );
  }
  if (
    work.typeEqualityCount === 0 ||
    work.coreFunctionCount === 0 ||
    work.coreOperationCount === 0 ||
    work.wasmAtomCount === 0
  ) {
    throw new Error(`profile omitted compiler work: ${JSON.stringify(work)}`);
  }
  if (work.wasmBytes !== artifact.wasm.byteLength) {
    throw new Error(
      `profile counted ${work.wasmBytes} Wasm bytes; artifact has ${artifact.wasm.byteLength}`,
    );
  }
});

Deno.test("independent compilation skips session identity work", async () => {
  const artifact = await compileModuleSource(
    "independent.duck",
    "40 + 2\n",
    { gpuMode: "off" },
  );
  const { stages, work } = artifact.profile;

  if (
    stages.semanticContextMilliseconds !== 0 ||
    stages.semanticFingerprintMilliseconds !== 0 ||
    work.semanticFingerprintReuseCount !== 0
  ) {
    throw new Error(
      `independent compilation performed session identity work: ${
        JSON.stringify({ stages, work })
      }`,
    );
  }
  if (work.controlFlowLoweringPassCount !== 1) {
    throw new Error(
      `straight-line compilation used ${work.controlFlowLoweringPassCount} control-flow passes`,
    );
  }
  if (work.controlFlowFirstPassResidualCount !== 0) {
    throw new Error(
      `straight-line compilation retained ${work.controlFlowFirstPassResidualCount} source-control nodes`,
    );
  }
  if (
    work.controlFlowFirstPassResidualLoopCount !== 0 ||
    work.controlFlowFirstPassResidualRangeCount !== 0 ||
    work.controlFlowFirstPassResidualCollectionCount !== 0
  ) {
    throw new Error(
      `straight-line compilation retained source-control components: ${
        JSON.stringify(work)
      }`,
    );
  }
});

Deno.test("residual source control bounds fixed-point passes", async () => {
  const file = new URL(
    "../examples/binned/live/case-studies/codex/codex.duck",
    import.meta.url,
  );
  const hostInterface = new URL(
    "../examples/binned/live/case-studies/codex/host.duck",
    import.meta.url,
  ).pathname;
  const artifact = await compileModuleSource(
    file.pathname,
    await Deno.readTextFile(file),
    { gpuMode: "off", hostInterface },
  );
  if (artifact.language !== "ducklang") {
    throw new Error(
      `expected Ducklang artifact; received ${artifact.language}`,
    );
  }
  const {
    controlFlowFirstPassResidualCollectionCount,
    controlFlowFirstPassResidualCount,
    controlFlowFirstPassResidualLoopCount,
    controlFlowFirstPassResidualRangeCount,
    controlFlowLoweringPassCount,
  } = artifact.profile.work;

  if (controlFlowFirstPassResidualCount === 0) {
    throw new Error("Codex did not exercise a residual source-control pass");
  }
  const componentCount = controlFlowFirstPassResidualLoopCount +
    controlFlowFirstPassResidualRangeCount +
    controlFlowFirstPassResidualCollectionCount;
  if (componentCount !== controlFlowFirstPassResidualCount) {
    throw new Error(
      `Codex residual components sum to ${componentCount}, expected ${controlFlowFirstPassResidualCount}`,
    );
  }
  if (
    controlFlowFirstPassResidualLoopCount !== 2 ||
    controlFlowFirstPassResidualRangeCount !== 0 ||
    controlFlowFirstPassResidualCollectionCount !== 0
  ) {
    throw new Error(
      `Codex residual source control changed: ${
        JSON.stringify({
          loop: controlFlowFirstPassResidualLoopCount,
          range: controlFlowFirstPassResidualRangeCount,
          collection: controlFlowFirstPassResidualCollectionCount,
        })
      }`,
    );
  }
  if (
    controlFlowLoweringPassCount > controlFlowFirstPassResidualCount + 1
  ) {
    throw new Error(
      `Codex used ${controlFlowLoweringPassCount} passes after retaining ${controlFlowFirstPassResidualCount} controls`,
    );
  }
});

Deno.test("Core identity reuses its structured round-trip witness", async () => {
  const artifact = await compileModuleSource(
    "core_identity_profile.duck",
    "let left = 20\nlet right = 22\nleft + right\n",
    { gpuMode: "off" },
  );
  const { details, stages, work } = artifact.profile;

  if (
    work.coreRewriteProposalCount !== 0 ||
    work.coreRewriteAcceptedCount !== 0 ||
    details.cpuCoreValidationMilliseconds !== 0 ||
    stages.coreInflationMilliseconds !== 0
  ) {
    throw new Error(
      `Core identity repeated flat inflation: ${
        JSON.stringify({ stages, work })
      }`,
    );
  }
});

Deno.test("GPU Core identity reports no physical parallel work", async () => {
  const artifact = await compileModuleSource(
    "gpu_core_identity_profile.duck",
    "let left = 20\nlet right = 22\nleft + right\n",
    { gpuMode: "required" },
  );
  const { work } = artifact.profile;

  if (
    artifact.backends.coreRewrite !== "identity" ||
    work.downstreamParallelFunctionCount !== 0 ||
    work.gpuCoreLogicalBatchSize !== 1 ||
    work.gpuCorePayloadBatchSize !== 0 ||
    work.gpuCoreSubmissionBatchSize !== 0
  ) {
    throw new Error(
      `Core identity reported physical GPU work: ${JSON.stringify(work)}`,
    );
  }
});

Deno.test("Ducklang profile reports specialization environment work", async () => {
  const artifact = await compileModuleSource(
    "specialization_environment_profile.duck",
    `let make = amount => {
  let add = value => value + amount
  add
}
let add = make 2
add 40
`,
    { gpuMode: "off" },
  );
  const { work } = artifact.profile;
  if (
    work.specializationRewrittenBlockCount === 0 ||
    work.specializationAvoidedEnvironmentEntryCopyCount === 0 ||
    work.specializationNodeCountCacheHitCount === 0 ||
    work.specializationNodeCountCacheHitNodeCount === 0
  ) {
    throw new Error(
      `profile omitted specialization environment work: ${
        JSON.stringify(work)
      }`,
    );
  }
});

Deno.test("GPU profile exposes compacted Core and Wasm work", async () => {
  const artifact = await compileModuleSource(
    "gpu_wasm_profile.duck",
    "let add = (value: I32) => value + 0\nadd(42)\n",
    {
      gpuMode: "required",
      gpuWasmVerification: "differential",
    },
  );
  const work = artifact.profile.work;
  if (artifact.gpuCoreResult?.status !== "completed") {
    throw new Error("GPU profile omitted its completed Core result");
  }
  if (artifact.gpuCoreResult.inputProvenance !== "construction") {
    throw new Error(
      `compiler GPU Core used ${artifact.gpuCoreResult.inputProvenance} provenance`,
    );
  }
  const paddedInvocationCount = (count: number) => Math.ceil(count / 64) * 64;
  const signed64HighWordBytes =
    work.gpuWasmSigned64AtomCount * 2 < work.wasmAtomCount
      ? work.gpuWasmSigned64AtomCount * 8
      : work.wasmAtomCount * 4;
  const expectedCoreRewriteInvocations = work.gpuRewriteCandidateCount === 0
    ? 0
    : paddedInvocationCount(work.gpuRewriteCandidateCount);
  const resolvedOffsetBitWidth = work.wasmBytes <= 0xffff ? 16 : 32;
  const resolvedOffsetBytes = resolvedOffsetBitWidth === 16
    ? Math.ceil((work.wasmAtomCount + 1) / 2) * 4
    : (work.wasmAtomCount + 1) * 4;
  const byteRankBitWidth = work.gpuWasmMaximumByteRank <= 0xffff ? 16 : 32;
  const byteRankCount = Math.ceil(work.wasmAtomCount / 8);
  const byteRankBytes = byteRankBitWidth === 16
    ? Math.ceil(byteRankCount / 2) * 4
    : byteRankCount * 4;
  const rankedLowWordBytes = Math.ceil(work.gpuWasmByteAtomCount / 4) * 4 +
    (work.wasmAtomCount - work.gpuWasmByteAtomCount) * 4 +
    byteRankBytes;
  const lowWordLayout = rankedLowWordBytes < work.wasmAtomCount * 4
    ? "ranked"
    : "dense";
  const lowWordBytes = lowWordLayout === "ranked"
    ? rankedLowWordBytes
    : work.wasmAtomCount * 4;
  const sparseLengthSizingWork = work.wasmAtomCount +
    work.gpuWasmLengthAtomCount *
      (1 + 5 * Math.ceil(Math.log2(work.gpuWasmLengthAtomCount + 1)));
  const sparseLengthSizing = sparseLengthSizingWork <
      work.gpuWasmLengthSizingDependencyAtomCount
    ? 1
    : 0;
  const lengthSizingWork = sparseLengthSizing === 1
    ? sparseLengthSizingWork
    : work.gpuWasmLengthSizingDependencyAtomCount;
  if (
    work.gpuRewriteCandidateCount === 0 ||
    work.gpuRewriteCandidateCount > work.coreOperationCount ||
    work.gpuRewriteCandidateDescriptorBytes !==
      work.gpuRewriteCandidateCount * 80 ||
    work.gpuCoreLogicalDeviceBufferBytes !==
      work.gpuRewriteCandidateCount * 96 + 4 ||
    work.gpuRewriteDispatchedInvocationCount !==
      expectedCoreRewriteInvocations ||
    work.gpuWasmLengthAtomCount === 0 ||
    work.gpuWasmLengthSizingDependencyAtomCount === 0 ||
    work.gpuWasmSparseLengthSizing !== sparseLengthSizing ||
    work.gpuWasmLengthSizingWorkEstimate !== lengthSizingWork ||
    work.gpuWasmResolvedOffsetBitWidth !== resolvedOffsetBitWidth ||
    work.gpuWasmResolvedOffsetBytes !== resolvedOffsetBytes ||
    work.gpuWasmRankedLowWords !== (lowWordLayout === "ranked" ? 1 : 0) ||
    work.gpuWasmLowWordBytes !== lowWordBytes ||
    work.gpuWasmByteRankBitWidth !==
      (lowWordLayout === "ranked" ? byteRankBitWidth : 0) ||
    work.gpuWasmByteRankBytes !==
      (lowWordLayout === "ranked" ? byteRankBytes : 0) ||
    work.gpuWasmSigned64HighWordBytes !== signed64HighWordBytes ||
    work.gpuWasmAtomInputBytes !==
      Math.ceil(work.wasmAtomCount / 8) * 4 +
        lowWordBytes +
        signed64HighWordBytes +
        resolvedOffsetBytes ||
    work.gpuWasmDispatchedInvocationCount !==
      paddedInvocationCount(work.wasmAtomCount) ||
    work.wasmOutputBufferBytes < work.wasmBytes ||
    work.wasmOutputBufferBytes >= work.wasmBytes + 4
  ) {
    throw new Error(
      `GPU profile omitted compacted work: ${JSON.stringify(work)}`,
    );
  }
});

Deno.test("Ducklang post-comptime specialization skips a clean module", async () => {
  const artifact = await compileModuleSource(
    "clean_frontier.duck",
    "let answer = 42\nanswer\n",
    { gpuMode: "off" },
  );
  const work = artifact.profile.work;

  if (
    artifact.profile.stages.postComptimeSpecializationMilliseconds !== 0 ||
    work.postSpecializationFrontierBindingCount !== 0 ||
    work.postSpecializationFrontierNodeCount !== 0
  ) {
    throw new Error(
      `clean module repeated specialization work: ${JSON.stringify(work)}`,
    );
  }
});

Deno.test("Ducklang post-comptime specialization follows the dirty frontier", async () => {
  const artifact = await compileModuleSource(
    "dirty_frontier.duck",
    "let answer = comptime (40 + 2)\nanswer\n",
    { gpuMode: "off" },
  );
  const work = artifact.profile.work;

  if (
    work.postSpecializationFrontierBindingCount !== 1 ||
    work.postSpecializationFrontierNodeCount === 0
  ) {
    throw new Error(
      `comptime replacement produced the wrong frontier: ${
        JSON.stringify(work)
      }`,
    );
  }
  const details = artifact.profile.details;
  assertContains(
    artifact.profile.stages.postComptimeSpecializationMilliseconds,
    details.postSpecializationDemandMilliseconds +
      details.postSpecializationFrontierMilliseconds +
      details.postSpecializationRewriteMilliseconds +
      details.postSpecializationLiftingMilliseconds +
      details.postSpecializationReachabilityMilliseconds +
      details.postSpecializationAccountingMilliseconds,
    "post-comptime specialization",
  );
});

Deno.test("Ducklang compilation session reuses an identical source revision", async () => {
  const source = `let answer = 42
answer
`;
  const session = createDucklangCompilationSession();
  const first = await compileModuleSource("profile.duck", source, {
    gpuMode: "off",
    session,
  });
  const rebuilt = await compileModuleSource("profile.duck", source, {
    gpuMode: "off",
    session,
  });

  assertRevisionReuse(rebuilt, "exact");
  assertBytesEqual(rebuilt.wasm, first.wasm);
});

Deno.test("Ducklang independent compilations reuse unchanged bundled prelude syntax", async () => {
  const source = `const types = import "duck:prelude/types"
0
`;
  const first = await compileModuleSource("shared-prelude.duck", source, {
    gpuMode: "off",
  });
  const second = await compileModuleSource("shared-prelude.duck", source, {
    gpuMode: "off",
  });

  if (
    second.profile.work.moduleSyntaxAnalysisCount !== 0 ||
    second.profile.work.moduleSyntaxReuseCount === 0
  ) {
    throw new Error(
      `second compilation repeated bundled syntax analysis: ${
        JSON.stringify(second.profile.work)
      }`,
    );
  }
  assertBytesEqual(second.wasm, first.wasm);
});

Deno.test("Ducklang compilation session discards a trailing comment without parsing", async () => {
  const source = `let add = (left: I32, right: I32) => left + right
add(20, 22)
`;
  const session = createDucklangCompilationSession();
  const first = await compileModuleSource("profile.duck", source, {
    gpuMode: "off",
    session,
  });
  const rebuilt = await compileModuleSource(
    "profile.duck",
    `${source}// no semantic change\n`,
    {
      gpuMode: "off",
      session,
    },
  );

  if (rebuilt.profile.work.semanticArtifactReuseCount !== 1) {
    throw new Error("comment-only rebuild did not reuse its semantic artifact");
  }
  assertRevisionReuse(rebuilt, "trailingTrivia");
  for (
    const stage of [
      "elaborationMilliseconds",
      "typeAnalysisMilliseconds",
      "preComptimeSpecializationMilliseconds",
      "coreLoweringMilliseconds",
      "wasmPlanningAndCpuEmissionMilliseconds",
    ] as const
  ) {
    if (rebuilt.profile.stages[stage] !== 0) {
      throw new Error(
        `comment-only rebuild repeated ${stage}: ${
          rebuilt.profile.stages[stage]
        }ms`,
      );
    }
  }
  assertBytesEqual(rebuilt.wasm, first.wasm);
});

Deno.test("Ducklang compilation session reparses trivia before live syntax", async () => {
  const source = `let answer = 42
answer
`;
  const session = createDucklangCompilationSession();
  const first = await compileModuleSource("profile.duck", source, {
    gpuMode: "off",
    session,
  });
  const rebuilt = await compileModuleSource(
    "profile.duck",
    `// shifts every live source span
${source}`,
    {
      gpuMode: "off",
      session,
    },
  );

  if (rebuilt.profile.work.syntaxAnalysisCount !== 1) {
    throw new Error("leading trivia edit unexpectedly reused stale syntax");
  }
  if (
    rebuilt.profile.work.exactSourceRevisionReuseCount !== 0 ||
    rebuilt.profile.work.trailingTriviaRevisionReuseCount !== 0
  ) {
    throw new Error("leading trivia edit reported a source revision reuse");
  }
  assertBytesEqual(rebuilt.wasm, first.wasm);
});

Deno.test("Ducklang compilation session retains unchanged backend functions", async () => {
  const session = createDucklangCompilationSession();
  const firstSource = `let first = () => 40
let second = () => 2
first() + second()
`;
  const secondSource = firstSource.replace("40", "41");
  const first = await compileModuleSource("functions.duck", firstSource, {
    gpuMode: "off",
    session,
  });
  const second = await compileModuleSource("functions.duck", secondSource, {
    gpuMode: "off",
    session,
  });

  if (first.profile.work.backendFunctionAnalysisCount === 0) {
    throw new Error("initial compilation recorded no backend functions");
  }
  if (second.profile.work.backendFunctionAnalysisCount === 0) {
    throw new Error("edited function was not rebuilt");
  }
  if (second.profile.work.backendFunctionReuseCount === 0) {
    throw new Error("unchanged functions were not retained");
  }
  if (equalBytes(first.wasm, second.wasm)) {
    throw new Error(
      "semantic edit unexpectedly retained the complete artifact",
    );
  }
});

function assertClose(actual: number, expected: number): void {
  if (Math.abs(actual - expected) <= 0.001) return;
  throw new Error(`expected ${expected}; received ${actual}`);
}

function assertRevisionReuse(
  artifact: Awaited<ReturnType<typeof compileModuleSource>>,
  expected: "exact" | "trailingTrivia",
): void {
  if (artifact.language !== "ducklang") {
    throw new Error(
      `expected Ducklang artifact; received ${artifact.language}`,
    );
  }
  const { details, stages, work } = artifact.profile;
  if (
    work.exactSourceRevisionReuseCount !== (expected === "exact" ? 1 : 0) ||
    work.trailingTriviaRevisionReuseCount !==
      (expected === "trailingTrivia" ? 1 : 0) ||
    work.syntaxAnalysisCount !== 0 ||
    work.semanticFingerprintReuseCount !== 1
  ) {
    throw new Error(
      `unexpected ${expected} revision profile: ${JSON.stringify(work)}`,
    );
  }
  if (
    stages.parsingMilliseconds !== 0 ||
    stages.semanticFingerprintMilliseconds !== 0 ||
    details.contextualClassificationMilliseconds !== 0 ||
    details.parserExecutionMilliseconds !== 0 ||
    details.astLoweringMilliseconds !== 0
  ) {
    throw new Error(
      `${expected} revision repeated syntax work: ${
        JSON.stringify({ stages, details })
      }`,
    );
  }
}

function assertContains(
  outerMilliseconds: number,
  innerMilliseconds: number,
  stage: string,
): void {
  if (outerMilliseconds + 0.001 >= innerMilliseconds) return;
  throw new Error(
    `${stage} reported ${outerMilliseconds}ms around ${innerMilliseconds}ms of detailed work`,
  );
}

function assertBytesEqual(left: Uint8Array, right: Uint8Array): void {
  if (equalBytes(left, right)) return;
  throw new Error("expected byte-identical Wasm");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}
