import { type CompactFrontendProgram } from "@mewhhaha/baba/runtime/webgpu";
import { BabaGpuSyntaxSession } from "./baba_gpu_syntax.ts";
import {
  type BlotGpuPayloadStrategy,
  type BlotResidentExpression,
  lowerBlotResidentSyntax,
} from "./blot_gpu_lowering.ts";
import {
  type WasmBinaryPlan,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./wasm.ts";

const tokenWordCount = 4;
const nodeWordCount = 8;
const edgeWordCount = 4;
const maximumBlotGpuInteger = (1n << 31n) - 1n;
const blotPlanUrl = new URL(
  "../grammar/blot/generated/parser.plan",
  import.meta.url,
);

export type BlotSourceSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

export type BlotI64Expression =
  | {
    readonly kind: "integer";
    readonly value: bigint;
    readonly span: BlotSourceSpan;
  }
  | {
    readonly kind: "binding";
    readonly binding: number;
    readonly name: string;
    readonly span: BlotSourceSpan;
  };

export type BlotI64Binding = {
  readonly id: number;
  readonly name: string;
  readonly value: BlotI64Expression;
  readonly span: BlotSourceSpan;
};

export type BlotI64Module = {
  readonly file: string;
  readonly bindings: readonly BlotI64Binding[];
  readonly result: BlotI64Expression;
  readonly span: BlotSourceSpan;
};

export type BlotGpuFrontendTimings = {
  readonly runtimeInitializationMilliseconds: number;
  readonly planCompilationMilliseconds: number;
  readonly syntaxMilliseconds: number;
  readonly syntaxUploadMilliseconds: number;
  readonly syntaxSubmitMilliseconds: number;
  readonly payloadLoweringMilliseconds: number;
  readonly payloadStrategy: BlotGpuPayloadStrategy;
  readonly payloadScanDispatchCount: number;
  readonly payloadScanAdditionWork: number;
  readonly payloadScanAdditionWorkUpperBound: number;
  readonly payloadScanScheduledInvocationCount: number;
  readonly payloadScanTemporaryBytes: number;
  readonly payloadDeclarationCapacity: number;
  readonly payloadScheduledDeclarationInvocationCount: number;
  readonly payloadReadbackBytes: number;
  readonly totalMilliseconds: number;
};

export type BlotPayloadCompilation = {
  readonly core: BlotI64Module;
  readonly wasmPlan: WasmBinaryPlan;
  readonly timings: BlotGpuFrontendTimings;
};

type CompactNode = {
  readonly id: number;
  readonly ruleName: string;
  readonly start: number;
  readonly end: number;
  readonly edgeStart: number;
  readonly edgeCount: number;
};

type CompactEdge =
  | {
    readonly index: number;
    readonly kind: "token";
    readonly text: string;
    readonly start: number;
    readonly end: number;
  }
  | {
    readonly index: number;
    readonly kind: "node";
    readonly node: CompactNode;
  };

export async function compileBlotPayload(
  file: string,
  source: string,
  options: {
    readonly payloadStrategy?: BlotGpuPayloadStrategy;
  } = {},
): Promise<BlotPayloadCompilation> {
  const totalStart = performance.now();
  const plan = await Deno.readFile(blotPlanUrl);
  const session = await BabaGpuSyntaxSession.create(plan);
  let resident;
  const syntaxStart = performance.now();
  try {
    resident = await session.submitResidentSyntax(source);
    const syntaxMilliseconds = performance.now() - syntaxStart;
    const payload = await lowerBlotResidentSyntax(
      file,
      source,
      session.device,
      resident,
      options.payloadStrategy ?? "direct-ordinal-fused",
    );
    const expression = (
      residentExpression: BlotResidentExpression,
    ): BlotI64Expression => {
      const span = sourceSpan(
        file,
        residentExpression.start,
        residentExpression.end,
      );
      if (residentExpression.kind === "integer") {
        return {
          kind: "integer",
          value: BigInt(residentExpression.value),
          span,
        };
      }
      return {
        kind: "binding",
        binding: residentExpression.binding,
        name: source.slice(residentExpression.start, residentExpression.end),
        span,
      };
    };
    const core: BlotI64Module = {
      file,
      bindings: payload.bindings.map((binding) => ({
        id: binding.id,
        name: source.slice(binding.nameStart, binding.nameEnd),
        value: expression(binding.value),
        span: sourceSpan(file, binding.start, binding.end),
      })),
      result: expression(payload.result),
      span: sourceSpan(file, payload.start, payload.end),
    };
    const wasmPlan = lowerBlotI64ModuleToWasm(core);
    return {
      core,
      wasmPlan,
      timings: {
        runtimeInitializationMilliseconds:
          session.setupTimings.runtimeInitializationMilliseconds,
        planCompilationMilliseconds:
          session.setupTimings.planCompilationMilliseconds,
        syntaxMilliseconds,
        syntaxUploadMilliseconds: resident.timings.uploadMs,
        syntaxSubmitMilliseconds: resident.timings.submitMs,
        payloadLoweringMilliseconds: payload.completionMilliseconds,
        payloadStrategy: payload.strategy,
        payloadScanDispatchCount: payload.scanDispatchCount,
        payloadScanAdditionWork: payload.scanAdditionWork,
        payloadScanAdditionWorkUpperBound: payload.scanAdditionWorkUpperBound,
        payloadScanScheduledInvocationCount:
          payload.scanScheduledInvocationCount,
        payloadScanTemporaryBytes: payload.scanTemporaryBytes,
        payloadDeclarationCapacity: payload.declarationCapacity,
        payloadScheduledDeclarationInvocationCount:
          payload.scheduledDeclarationInvocationCount,
        payloadReadbackBytes: payload.residentReadbackBytes,
        totalMilliseconds: performance.now() - totalStart,
      },
    };
  } finally {
    resident?.dispose();
    session.dispose();
  }
}

export function lowerBlotCompactProgram(
  file: string,
  source: string,
  program: CompactFrontendProgram,
  ruleNames: ReadonlyMap<number, string>,
): BlotI64Module {
  requireRecordWidth(file, "token", program.tokens.length, tokenWordCount);
  requireRecordWidth(file, "node", program.nodes.length, nodeWordCount);
  requireRecordWidth(file, "edge", program.edges.length, edgeWordCount);
  const nodeCount = program.nodes.length / nodeWordCount;
  if (nodeCount === 0) {
    throw payloadError(file, 0, "compact program has no root node");
  }

  const consumedNodes = new Set<number>();
  const consumedEdges = new Set<number>();
  const readNode = (nodeId: number): CompactNode => {
    if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= nodeCount) {
      throw payloadError(file, 0, `node reference ${nodeId} is out of bounds`);
    }
    const offset = nodeId * nodeWordCount;
    const ruleId = program.nodes[offset];
    const ruleName = ruleNames.get(ruleId);
    const start = program.nodes[offset + 2];
    const end = program.nodes[offset + 3];
    const edgeStart = program.nodes[offset + 4];
    const edgeCount = program.nodes[offset + 5];
    if (ruleName === undefined) {
      throw payloadError(
        file,
        start,
        `node ${nodeId} uses unknown rule ${ruleId}`,
      );
    }
    if (start < 0 || end < start || end > source.length) {
      throw payloadError(
        file,
        Math.max(0, start),
        `node ${nodeId} has invalid source span [${start}, ${end})`,
      );
    }
    if (
      edgeStart < 0 || edgeCount < 0 ||
      edgeStart + edgeCount > program.edges.length / edgeWordCount
    ) {
      throw payloadError(
        file,
        start,
        `node ${nodeId} has invalid edge range [${edgeStart}, ${
          edgeStart + edgeCount
        })`,
      );
    }
    return { id: nodeId, ruleName, start, end, edgeStart, edgeCount };
  };
  const readEdges = (node: CompactNode): readonly CompactEdge[] => {
    consumedNodes.add(node.id);
    const edges: CompactEdge[] = [];
    for (let ordinal = 0; ordinal < node.edgeCount; ordinal += 1) {
      const edgeIndex = node.edgeStart + ordinal;
      const offset = edgeIndex * edgeWordCount;
      const actualOrdinal = program.edges[offset + 1];
      const kind = program.edges[offset + 2];
      const target = program.edges[offset + 3];
      if (actualOrdinal !== ordinal) {
        throw payloadError(
          file,
          node.start,
          `node ${node.id} edge ${edgeIndex} has ordinal ${actualOrdinal}; expected ${ordinal}`,
        );
      }
      if (consumedEdges.has(edgeIndex)) {
        throw payloadError(
          file,
          node.start,
          `edge ${edgeIndex} is owned by more than one node`,
        );
      }
      consumedEdges.add(edgeIndex);
      if (kind === 1) {
        edges.push({ index: edgeIndex, kind: "node", node: readNode(target) });
        continue;
      }
      if (kind !== 0) {
        throw payloadError(
          file,
          node.start,
          `edge ${edgeIndex} has unknown kind ${kind}`,
        );
      }
      const tokenCount = program.tokens.length / tokenWordCount;
      if (!Number.isInteger(target) || target < 0 || target >= tokenCount) {
        throw payloadError(
          file,
          node.start,
          `token reference ${target} is out of bounds`,
        );
      }
      const tokenOffset = target * tokenWordCount;
      const start = program.tokens[tokenOffset + 1];
      const end = program.tokens[tokenOffset + 2];
      if (start < 0 || end < start || end > source.length) {
        throw payloadError(
          file,
          node.start,
          `token ${target} has invalid source span [${start}, ${end})`,
        );
      }
      edges.push({
        index: edgeIndex,
        kind: "token",
        text: source.slice(start, end),
        start,
        end,
      });
    }
    return edges;
  };

  const root = readNode(0);
  if (root.ruleName !== "program") {
    throw payloadError(
      file,
      root.start,
      `root rule is ${root.ruleName}; expected program`,
    );
  }
  const rootEdges = readEdges(root);
  const bindings: BlotI64Binding[] = [];
  const latestBindings = new Map<string, number>();
  let result: BlotI64Expression | undefined;

  for (const [declarationIndex, rootEdge] of rootEdges.entries()) {
    if (rootEdge.kind !== "node" || rootEdge.node.ruleName !== "declaration") {
      throw payloadError(
        file,
        root.start,
        `program child ${declarationIndex} is not a declaration node`,
      );
    }
    const declaration = rootEdge.node;
    const declarationEdges = readEdges(declaration);
    const signature = declarationEdges.map((edge) =>
      edge.kind === "token"
        ? `token:${edge.text}`
        : `node:${edge.node.ruleName}`
    );
    if (
      signaturesEqual(signature, [
        "token:let",
        "node:binding_pattern",
        "token:=",
        "node:expression",
        "token:;",
      ])
    ) {
      if (result !== undefined) {
        throw payloadError(
          file,
          declaration.start,
          "let declaration follows return",
        );
      }
      const pattern = declarationEdges[1];
      const expression = declarationEdges[3];
      if (pattern.kind !== "node" || expression.kind !== "node") {
        throw payloadError(
          file,
          declaration.start,
          "let declaration shape changed during decoding",
        );
      }
      const name = readBindingName(file, readEdges(pattern.node));
      const value = readExpression(
        file,
        readEdges(expression.node),
        latestBindings,
      );
      const id = bindings.length;
      bindings.push({
        id,
        name,
        value,
        span: sourceSpan(file, declaration.start, declaration.end),
      });
      latestBindings.set(name, id);
      continue;
    }
    if (
      signaturesEqual(signature, [
        "token:return",
        "node:expression",
        "token:;",
      ])
    ) {
      if (result !== undefined) {
        throw payloadError(
          file,
          declaration.start,
          "module has more than one return",
        );
      }
      const expression = declarationEdges[1];
      if (expression.kind !== "node") {
        throw payloadError(
          file,
          declaration.start,
          "return expression is not a node",
        );
      }
      result = readExpression(
        file,
        readEdges(expression.node),
        latestBindings,
      );
      continue;
    }
    throw payloadError(
      file,
      declaration.start,
      `declaration is outside the I64 fragment: ${signature.join(", ")}`,
    );
  }
  if (result === undefined) {
    throw payloadError(file, root.end, "module has no final return");
  }
  if (
    consumedNodes.size !== nodeCount ||
    consumedEdges.size !== program.edges.length / edgeWordCount
  ) {
    throw payloadError(
      file,
      root.start,
      `compact graph has unconsumed records: consumed ${consumedNodes.size}/${nodeCount} nodes and ${consumedEdges.size}/${
        program.edges.length / edgeWordCount
      } edges`,
    );
  }
  return {
    file,
    bindings,
    result,
    span: sourceSpan(file, root.start, root.end),
  };
}

export function lowerBlotI64ModuleToWasm(
  module: BlotI64Module,
): WasmBinaryPlan {
  const builder = new WasmModuleBuilder();
  const typeIndex = builder.addFunctionType([], [wasmType.i64]);
  const instructions: WasmInstruction[] = [];
  for (const binding of module.bindings) {
    instructions.push(...lowerExpression(binding.value));
    instructions.push(...wasmInstruction.localSet(binding.id));
  }
  instructions.push(...lowerExpression(module.result));
  const functionIndex = builder.addFunction(
    typeIndex,
    module.bindings.map(() => wasmType.i64),
    instructions,
  );
  builder.exportFunction("main", functionIndex);
  return builder.finishPlan();
}

function lowerExpression(
  expression: BlotI64Expression,
): readonly WasmInstruction[] {
  return expression.kind === "integer"
    ? wasmInstruction.i64Constant(expression.value)
    : wasmInstruction.localGet(expression.binding);
}

function readBindingName(
  file: string,
  edges: readonly CompactEdge[],
): string {
  if (edges.length !== 1 || edges[0].kind !== "token") {
    const start = edges[0]?.kind === "token" ? edges[0].start : 0;
    throw payloadError(file, start, "binding pattern is not one identifier");
  }
  const token = edges[0];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text) || token.text === "_") {
    throw payloadError(
      file,
      token.start,
      `binding name ${JSON.stringify(token.text)} is outside the I64 fragment`,
    );
  }
  return token.text;
}

function readExpression(
  file: string,
  edges: readonly CompactEdge[],
  latestBindings: ReadonlyMap<string, number>,
): BlotI64Expression {
  if (edges.length !== 1 || edges[0].kind !== "token") {
    const start = edges[0]?.kind === "token" ? edges[0].start : 0;
    throw payloadError(file, start, "expression is not one I64 atom");
  }
  const token = edges[0];
  const span = sourceSpan(file, token.start, token.end);
  if (/^[0-9]+$/.test(token.text)) {
    const value = BigInt(token.text);
    if (value > maximumBlotGpuInteger) {
      throw payloadError(
        file,
        token.start,
        `integer ${token.text} exceeds admitted GPU literal maximum ${maximumBlotGpuInteger}`,
      );
    }
    return { kind: "integer", value, span };
  }
  const binding = latestBindings.get(token.text);
  if (binding === undefined) {
    throw payloadError(
      file,
      token.start,
      `name ${JSON.stringify(token.text)} has no preceding I64 binding`,
    );
  }
  return { kind: "binding", binding, name: token.text, span };
}

function requireRecordWidth(
  file: string,
  record: string,
  length: number,
  width: number,
): void {
  if (length % width !== 0) {
    throw payloadError(
      file,
      0,
      `${record} buffer has ${length} words; expected a multiple of ${width}`,
    );
  }
}

function signaturesEqual(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function sourceSpan(file: string, start: number, end: number): BlotSourceSpan {
  return { file, start, end };
}

function payloadError(file: string, start: number, reason: string): TypeError {
  return new TypeError(`${file}:${start}: Blot GPU payload ${reason}`);
}
