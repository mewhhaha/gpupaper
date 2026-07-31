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
    work.gpuWasmResolvedOffsetBitWidth !== resolvedOffsetBitWidth ||
    work.gpuWasmResolvedOffsetBytes !== resolvedOffsetBytes ||
    work.gpuWasmSigned64HighWordBytes !== signed64HighWordBytes ||
    work.gpuWasmAtomInputBytes !==
      Math.ceil(work.wasmAtomCount / 8) * 4 +
        work.wasmAtomCount * 4 +
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
