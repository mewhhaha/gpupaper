import type { GpuResidentFrontendResult } from "@mewhhaha/baba/runtime/webgpu";
import {
  encodeGpuExclusiveScan,
  requestGpuExclusiveScanPipelines,
} from "./gpu_segmented_work.ts";
import {
  awaitCompilerGpuCommand,
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requireCompilerGpuCapacity,
  submitCompilerGpuCommand,
} from "./gpu_device.ts";

const blotPayloadRowWords = 12;
const blotWorkgroupSize = 64;

export const blotGpuCompactSchema = {
  rules: {
    program: 0,
    declaration: 4,
    bindingPattern: 15,
    expression: 23,
  },
  terminals: {
    identifier: 1,
    integer: 3,
    semicolon: 9,
    equals: 19,
    let: 20,
    return: 34,
  },
  fields: {
    unnamed: 0xffff_ffff,
    declarations: 10,
    kind: 23,
    pattern: 30,
    value: 47,
  },
} as const;

export type BlotGpuPayloadStrategy =
  | "direct-ordinal-fused"
  | "segmented-scan";

export type BlotResidentExpression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly start: number;
    readonly end: number;
  }
  | {
    readonly kind: "binding";
    readonly binding: number;
    readonly start: number;
    readonly end: number;
  };

export type BlotResidentBinding = {
  readonly id: number;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly start: number;
  readonly end: number;
  readonly value: BlotResidentExpression;
};

export type BlotResidentPayload = {
  readonly bindings: readonly BlotResidentBinding[];
  readonly result: BlotResidentExpression;
  readonly start: number;
  readonly end: number;
  readonly strategy: BlotGpuPayloadStrategy;
  readonly completionMilliseconds: number;
  readonly scanDispatchCount: number;
  readonly scanAdditionWork: number;
  readonly scanAdditionWorkUpperBound: number;
  readonly scanScheduledInvocationCount: number;
  readonly scanTemporaryBytes: number;
  readonly declarationCapacity: number;
  readonly scheduledDeclarationInvocationCount: number;
  readonly residentReadbackBytes: number;
};

type BlotLoweringPipelines = {
  readonly classify: GPUComputePipeline;
  readonly emit: GPUComputePipeline;
};

const directOrdinalPipelineRequests = new WeakMap<
  GPUDevice,
  Promise<BlotLoweringPipelines>
>();
const segmentedPipelineRequests = new WeakMap<
  GPUDevice,
  Promise<BlotLoweringPipelines>
>();

export async function lowerBlotResidentSyntax(
  file: string,
  source: string,
  device: GPUDevice,
  resident: GpuResidentFrontendResult,
  strategy: BlotGpuPayloadStrategy,
): Promise<BlotResidentPayload> {
  const startTime = performance.now();
  const nodeCapacity = resident.layout.nodeCapacity;
  if (nodeCapacity < 1) {
    throw new Error(`${file}: Baba resident node capacity is ${nodeCapacity}`);
  }
  const declarationCapacity = Math.min(
    nodeCapacity,
    Math.max(1, Math.floor(source.length / 8)),
  );
  const pipelines = await requestBlotLoweringPipelines(device, strategy);
  const scanPipelines = strategy === "segmented-scan"
    ? await requestGpuExclusiveScanPipelines(device)
    : undefined;
  const sourceWords = new Uint32Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    sourceWords[index] = source.charCodeAt(index);
  }
  const sourceBuffer = createBuffer(
    device,
    "Blot UTF-16 source",
    sourceWords,
    GPUBufferUsage.STORAGE,
  );
  const candidateBuffer = createCompilerGpuBuffer(
    device,
    "Blot payload candidates",
    {
      size: declarationCapacity * blotPayloadRowWords * 4,
      usage: GPUBufferUsage.STORAGE,
    },
    "storage",
  );
  const payloadBuffer = createCompilerGpuBuffer(
    device,
    "Blot resident payload",
    {
      size: declarationCapacity * blotPayloadRowWords * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const metadataBuffer = createCompilerGpuBuffer(
    device,
    "Blot resident metadata",
    {
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const parameters = new Uint32Array([
    resident.layout.statusWord,
    resident.layout.tokenCountWord,
    resident.layout.nodeCountWord,
    resident.layout.edgeCountWord,
    resident.layout.tokenOffsetWords,
    resident.layout.nodeOffsetWords,
    resident.layout.edgeOffsetWords,
    resident.layout.tokenCapacity,
    resident.layout.nodeCapacity,
    resident.layout.edgeCapacity,
    source.length,
    0,
  ]);
  const parameterBuffer = createBuffer(
    device,
    "Blot resident layout",
    parameters,
    GPUBufferUsage.UNIFORM,
  );
  const readbackBytes = 32 + declarationCapacity * blotPayloadRowWords * 4;
  const readbackBuffer = createCompilerGpuBuffer(
    device,
    "Blot resident payload readback",
    {
      size: readbackBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const ownedBuffers: GPUBuffer[] = [
    sourceBuffer,
    candidateBuffer,
    payloadBuffer,
    metadataBuffer,
    parameterBuffer,
    readbackBuffer,
  ];
  let mapped = false;
  try {
    const encoder = device.createCommandEncoder({
      label: `Blot ${strategy} resident lowering`,
    });
    const workgroupCount = Math.ceil(declarationCapacity / blotWorkgroupSize);
    const classifyPipeline = pipelines.classify;
    let countBuffer: GPUBuffer | undefined;
    {
      const pass = encoder.beginComputePass({ label: "Blot classify" });
      pass.setPipeline(classifyPipeline);
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: resident.buffer } },
        { binding: 1, resource: { buffer: sourceBuffer } },
        { binding: 2, resource: { buffer: candidateBuffer } },
      ];
      if (strategy === "segmented-scan") {
        countBuffer = createCompilerGpuBuffer(
          device,
          "Blot declaration output counts",
          {
            size: declarationCapacity * 4,
            usage: GPUBufferUsage.STORAGE,
          },
          "storage",
        );
        ownedBuffers.push(countBuffer);
        entries.push({ binding: 3, resource: { buffer: countBuffer } });
        entries.push({ binding: 4, resource: { buffer: metadataBuffer } });
        entries.push({ binding: 5, resource: { buffer: parameterBuffer } });
      } else {
        entries.push({ binding: 3, resource: { buffer: metadataBuffer } });
        entries.push({ binding: 4, resource: { buffer: parameterBuffer } });
      }
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: classifyPipeline.getBindGroupLayout(0),
          entries,
        }),
      );
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        "Blot declaration classification",
        workgroupCount,
      );
      pass.end();
    }

    let scanDispatchCount = 0;
    let scanAdditionWork = 0;
    let scanAdditionWorkUpperBound = 0;
    let scanScheduledInvocationCount = 0;
    let scanTemporaryBytes = 0;
    let offsets: GPUBuffer | undefined;
    if (
      strategy === "segmented-scan" && countBuffer !== undefined &&
      scanPipelines !== undefined
    ) {
      const scan = encodeGpuExclusiveScan(
        device,
        encoder,
        scanPipelines,
        countBuffer,
        declarationCapacity,
      );
      offsets = scan.offsets;
      ownedBuffers.push(...scan.ownedBuffers);
      scanDispatchCount = scan.dispatchCount;
      scanAdditionWork = scan.additionWork;
      scanAdditionWorkUpperBound = scan.additionWorkUpperBound;
      scanScheduledInvocationCount = scan.scheduledInvocationCount;
      scanTemporaryBytes = scan.temporaryBytes;
    }

    const emitPipeline = pipelines.emit;
    {
      const pass = encoder.beginComputePass({ label: "Blot emit and resolve" });
      pass.setPipeline(emitPipeline);
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: candidateBuffer } },
      ];
      if (strategy === "segmented-scan") {
        if (offsets === undefined) {
          throw new Error(
            `${file}: segmented Blot lowering has no scan output`,
          );
        }
        entries.push({ binding: 2, resource: { buffer: offsets } });
        entries.push({ binding: 3, resource: { buffer: payloadBuffer } });
        entries.push({ binding: 4, resource: { buffer: metadataBuffer } });
      } else {
        entries.push({ binding: 2, resource: { buffer: payloadBuffer } });
        entries.push({ binding: 3, resource: { buffer: metadataBuffer } });
      }
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: emitPipeline.getBindGroupLayout(0),
          entries,
        }),
      );
      dispatchCompilerGpuWorkgroups(
        device,
        pass,
        "Blot payload emission",
        workgroupCount,
      );
      pass.end();
    }
    encoder.copyBufferToBuffer(metadataBuffer, 0, readbackBuffer, 0, 32);
    encoder.copyBufferToBuffer(
      payloadBuffer,
      0,
      readbackBuffer,
      32,
      declarationCapacity * blotPayloadRowWords * 4,
    );
    await submitCompilerGpuCommand(
      device,
      "Blot resident lowering",
      encoder.finish(),
      "latency",
    );
    await awaitCompilerGpuCommand(
      device,
      "Blot resident lowering",
      readbackBuffer.mapAsync(GPUMapMode.READ),
    );
    mapped = true;
    const words = new Uint32Array(readbackBuffer.getMappedRange()).slice();
    const payload = materializeResidentPayload(
      file,
      source,
      words,
      declarationCapacity,
      strategy,
    );
    return {
      ...payload,
      completionMilliseconds: performance.now() - startTime,
      scanDispatchCount,
      scanAdditionWork,
      scanAdditionWorkUpperBound,
      scanScheduledInvocationCount,
      scanTemporaryBytes,
      declarationCapacity,
      scheduledDeclarationInvocationCount: 2 * workgroupCount *
        blotWorkgroupSize,
      residentReadbackBytes: readbackBytes,
    };
  } finally {
    if (mapped) readbackBuffer.unmap();
    ownedBuffers.forEach((buffer) => buffer.destroy());
  }
}

function materializeResidentPayload(
  file: string,
  source: string,
  words: Uint32Array,
  declarationCapacity: number,
  strategy: BlotGpuPayloadStrategy,
): Omit<
  BlotResidentPayload,
  | "completionMilliseconds"
  | "scanDispatchCount"
  | "scanAdditionWork"
  | "scanAdditionWorkUpperBound"
  | "scanScheduledInvocationCount"
  | "scanTemporaryBytes"
  | "declarationCapacity"
  | "scheduledDeclarationInvocationCount"
  | "residentReadbackBytes"
> {
  const syntaxStatus = words[0];
  const declarationCount = words[1];
  if (syntaxStatus !== 0) {
    throw new SyntaxError(
      `${file}: Baba resident syntax status ${syntaxStatus}`,
    );
  }
  if (declarationCount < 1 || declarationCount > declarationCapacity) {
    throw new TypeError(
      `${file}:0: Blot GPU payload declaration count ${declarationCount} exceeds resident capacity ${declarationCapacity}`,
    );
  }

  const rootStart = words[4];
  const rootEnd = words[5];
  if (rootStart > rootEnd || rootEnd > source.length) {
    throw new TypeError(
      `${file}:${rootStart}: Blot GPU payload root span [${rootStart}, ${rootEnd}) exceeds source length ${source.length}`,
    );
  }
  const rows = words.subarray(8);
  let firstError: { code: number; position: number } | undefined;
  for (let index = 0; index < declarationCount; index += 1) {
    const offset = index * blotPayloadRowWords;
    const code = rows[offset + 9];
    const position = rows[offset + 10];
    if (
      code !== 0 &&
      (firstError === undefined || position < firstError.position ||
        (position === firstError.position && code < firstError.code))
    ) {
      firstError = { code, position };
    }
  }
  if (firstError !== undefined) {
    throw new TypeError(
      `${file}:${firstError.position}: Blot GPU payload ${
        blotPayloadError(firstError.code)
      }`,
    );
  }

  const bindings: BlotResidentBinding[] = [];
  let result: BlotResidentExpression | undefined;
  for (let index = 0; index < declarationCount; index += 1) {
    const offset = index * blotPayloadRowWords;
    const kind = rows[offset];
    const expression = materializeExpression(file, source, rows, offset);
    if (kind === 1) {
      const id = rows[offset + 11];
      if (id !== bindings.length) {
        throw new TypeError(
          `${file}:${
            rows[offset + 1]
          }: Blot GPU payload binding ID ${id} is not stable ordinal ${bindings.length}`,
        );
      }
      bindings.push({
        id,
        nameStart: rows[offset + 3],
        nameEnd: rows[offset + 4],
        start: rows[offset + 1],
        end: rows[offset + 2],
        value: expression,
      });
      continue;
    }
    if (kind === 2 && index + 1 === declarationCount && result === undefined) {
      result = expression;
      continue;
    }
    throw new TypeError(
      `${file}:${
        rows[offset + 1]
      }: Blot GPU payload row ${index} has declaration kind ${kind}`,
    );
  }
  if (result === undefined) {
    throw new TypeError(`${file}:0: Blot GPU payload has no final return`);
  }
  return {
    bindings,
    result,
    start: rootStart,
    end: rootEnd,
    strategy,
  };
}

function materializeExpression(
  file: string,
  source: string,
  rows: Uint32Array,
  offset: number,
): BlotResidentExpression {
  const kind = rows[offset + 5];
  const start = rows[offset + 6];
  const end = rows[offset + 7];
  if (start > end || end > source.length) {
    throw new TypeError(
      `${file}:${start}: Blot GPU payload expression span [${start}, ${end}) exceeds source length ${source.length}`,
    );
  }
  if (kind === 1) {
    return { kind: "integer", value: rows[offset + 8], start, end };
  }
  if (kind === 2) {
    return { kind: "binding", binding: rows[offset + 8], start, end };
  }
  throw new TypeError(
    `${file}:${start}: Blot GPU payload expression kind ${kind} is not admitted`,
  );
}

function blotPayloadError(code: number): string {
  switch (code) {
    case 1:
      return "syntax was rejected before lowering";
    case 2:
      return "root compact record violates the program invariant";
    case 3:
      return "declaration is outside the let-star/return fragment";
    case 4:
      return "binding pattern is not one non-wildcard identifier";
    case 5:
      return "expression is not one I64 atom";
    case 6:
      return "integer exceeds admitted GPU literal maximum 2147483647";
    case 7:
      return "name has no preceding I64 binding";
    case 8:
      return "compact graph has records outside the closed fragment";
    default:
      return `reported unknown error code ${code}`;
  }
}

function requestBlotLoweringPipelines(
  device: GPUDevice,
  strategy: BlotGpuPayloadStrategy,
): Promise<BlotLoweringPipelines> {
  const segmented = strategy === "segmented-scan";
  const requests = segmented
    ? segmentedPipelineRequests
    : directOrdinalPipelineRequests;
  const existing = requests.get(device);
  if (existing !== undefined) return existing;
  const request = (async () => {
    requireCompilerGpuCapacity(device, {
      kind: "pipelineBindings",
      label: "Blot resident lowering",
      storageBufferCount: segmented ? 5 : 4,
      uniformBufferCount: 1,
    });
    const [classify, emit] = await Promise.all([
      compilePipeline(
        device,
        classifyShader(segmented),
        "classify_declarations",
      ),
      compilePipeline(device, emitShader(segmented), "emit_payload"),
    ]);
    return { classify, emit };
  })();
  requests.set(device, request);
  void device.lost.then(() => requests.delete(device));
  return request;
}

async function compilePipeline(
  device: GPUDevice,
  code: string,
  entryPoint: string,
): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ code });
  const errors = (await module.getCompilationInfo()).messages.filter(
    (message) => message.type === "error",
  );
  if (errors.length > 0) {
    throw new Error(
      `Blot resident shader ${entryPoint} failed: ${
        errors.map((message) => message.message).join("; ")
      }`,
    );
  }
  return await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint },
  });
}

function classifyShader(segmented: boolean): string {
  const countBinding = segmented
    ? "@group(0) @binding(3) var<storage, read_write> output_counts: array<u32>;"
    : "";
  const metadataBinding = segmented ? 4 : 3;
  const parameterBinding = segmented ? 5 : 4;
  const writeCount = segmented
    ? "output_counts[declaration_index] = select(0u, 1u, declaration_kind == 1u);"
    : "";
  return (/* wgsl */ `
struct LayoutParameters {
  status_word: u32,
  token_count_word: u32,
  node_count_word: u32,
  edge_count_word: u32,
  token_offset_words: u32,
  node_offset_words: u32,
  edge_offset_words: u32,
  token_capacity: u32,
  node_capacity: u32,
  edge_capacity: u32,
  source_length: u32,
  reserved: u32,
};

@group(0) @binding(0) var<storage, read> syntax_words: array<u32>;
@group(0) @binding(1) var<storage, read> source_words: array<u32>;
@group(0) @binding(2) var<storage, read_write> candidates: array<u32>;
${countBinding}
@group(0) @binding(${metadataBinding}) var<storage, read_write> metadata: array<u32>;
@group(0) @binding(${parameterBinding}) var<uniform> layout: LayoutParameters;

const ROW_WORDS = ${blotPayloadRowWords}u;
const INVALID = 0xffffffffu;

fn fail(row: u32, code: u32, position: u32) {
  candidates[row * ROW_WORDS + 9u] = code;
  candidates[row * ROW_WORDS + 10u] = position;
}

fn edge_matches(edge: u32, field: u32, ordinal: u32, kind: u32) -> bool {
  if (edge >= syntax_words[layout.edge_count_word]) {
    return false;
  }
  let offset = layout.edge_offset_words + edge * 4u;
  return syntax_words[offset] == field && syntax_words[offset + 1u] == ordinal && syntax_words[offset + 2u] == kind;
}

fn token_matches(token: u32, terminal: u32) -> bool {
  if (token >= syntax_words[layout.token_count_word]) {
    return false;
  }
  return syntax_words[layout.token_offset_words + token * 4u] == terminal;
}

fn token_span_valid(token: u32) -> bool {
  if (token >= syntax_words[layout.token_count_word]) {
    return false;
  }
  let offset = layout.token_offset_words + token * 4u;
  let start = syntax_words[offset + 1u];
  let end = syntax_words[offset + 2u];
  return start <= end && end <= layout.source_length;
}

fn node_matches(node: u32, rule: u32, edge_count: u32) -> bool {
  if (node >= syntax_words[layout.node_count_word]) {
    return false;
  }
  let offset = layout.node_offset_words + node * 8u;
  return syntax_words[offset] == rule && syntax_words[offset + 5u] == edge_count;
}

fn parse_integer(token: u32, row: u32) -> u32 {
  let token_offset = layout.token_offset_words + token * 4u;
  let start = syntax_words[token_offset + 1u];
  let end = syntax_words[token_offset + 2u];
  var value = 0u;
  var position = start;
  loop {
    if (position >= end) {
      break;
    }
    let character = source_words[position];
    if (character < 48u || character > 57u) {
      fail(row, 5u, position);
      return 0u;
    }
    let digit = character - 48u;
    if (value > (2147483647u - digit) / 10u) {
      fail(row, 6u, start);
      return 0u;
    }
    value = value * 10u + digit;
    position += 1u;
  }
  return value;
}

@compute @workgroup_size(${blotWorkgroupSize})
fn classify_declarations(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let declaration_index = invocation.x;
  let syntax_status = syntax_words[layout.status_word];
  let node_count = syntax_words[layout.node_count_word];
  let edge_count = syntax_words[layout.edge_count_word];
  if (declaration_index == 0u) {
    metadata[0] = syntax_status;
    metadata[2] = node_count;
    metadata[3] = edge_count;
  }
  if (syntax_status != 0u) {
    if (declaration_index == 0u) {
      metadata[1] = 1u;
      fail(0u, 1u, 0u);
    }
    return;
  }
  if (node_count == 0u) {
    if (declaration_index == 0u) {
      metadata[1] = 1u;
      fail(0u, 2u, 0u);
    }
    return;
  }
  let root_offset = layout.node_offset_words;
  let declaration_count = syntax_words[root_offset + 5u];
  if (declaration_index == 0u) {
    metadata[1] = max(1u, declaration_count);
    metadata[4] = syntax_words[root_offset + 2u];
    metadata[5] = syntax_words[root_offset + 3u];
    if (syntax_words[root_offset] != ${blotGpuCompactSchema.rules.program}u || declaration_count == 0u) {
      fail(0u, 2u, syntax_words[root_offset + 2u]);
    } else if (node_count != 3u * declaration_count || edge_count != 8u * declaration_count - 3u) {
      fail(0u, 8u, syntax_words[root_offset + 2u]);
    }
  }
  if (declaration_index >= declaration_count || declaration_index >= layout.node_capacity) {
    return;
  }

  let root_edge = syntax_words[root_offset + 4u] + declaration_index;
  if (!edge_matches(root_edge, ${blotGpuCompactSchema.fields.declarations}u, declaration_index, 1u)) {
    fail(declaration_index, 2u, syntax_words[root_offset + 2u]);
    return;
  }
  let root_edge_offset = layout.edge_offset_words + root_edge * 4u;
  let declaration = syntax_words[root_edge_offset + 3u];
  if (declaration >= node_count) {
    fail(declaration_index, 3u, syntax_words[root_offset + 2u]);
    return;
  }
  let declaration_offset = layout.node_offset_words + declaration * 8u;
  let declaration_start = syntax_words[declaration_offset + 2u];
  let declaration_end = syntax_words[declaration_offset + 3u];
  let declaration_edge_start = syntax_words[declaration_offset + 4u];
  let is_return = declaration_index + 1u == declaration_count;
  let expected_edges = select(5u, 3u, is_return);
  candidates[declaration_index * ROW_WORDS + 1u] = declaration_start;
  candidates[declaration_index * ROW_WORDS + 2u] = declaration_end;
  if (!node_matches(declaration, ${blotGpuCompactSchema.rules.declaration}u, expected_edges)) {
    fail(declaration_index, 3u, declaration_start);
    return;
  }

  let first_edge = declaration_edge_start;
  let expected_first_field = select(${blotGpuCompactSchema.fields.kind}u, ${blotGpuCompactSchema.fields.unnamed}u, is_return);
  if (!edge_matches(first_edge, expected_first_field, 0u, 0u)) {
    fail(declaration_index, 3u, declaration_start);
    return;
  }
  let first_token = syntax_words[layout.edge_offset_words + first_edge * 4u + 3u];
  let expected_terminal = select(${blotGpuCompactSchema.terminals.let}u, ${blotGpuCompactSchema.terminals.return}u, is_return);
  if (!token_matches(first_token, expected_terminal)) {
    fail(declaration_index, 3u, declaration_start);
    return;
  }

  var expression_node = 0u;
  var declaration_kind = 2u;
  if (!is_return) {
    if (!edge_matches(first_edge + 1u, ${blotGpuCompactSchema.fields.pattern}u, 1u, 1u) ||
        !edge_matches(first_edge + 2u, ${blotGpuCompactSchema.fields.unnamed}u, 2u, 0u) ||
        !edge_matches(first_edge + 3u, ${blotGpuCompactSchema.fields.value}u, 3u, 1u) ||
        !edge_matches(first_edge + 4u, ${blotGpuCompactSchema.fields.unnamed}u, 4u, 0u)) {
      fail(declaration_index, 3u, declaration_start);
      return;
    }
    let equals_token = syntax_words[layout.edge_offset_words + (first_edge + 2u) * 4u + 3u];
    let semicolon_token = syntax_words[layout.edge_offset_words + (first_edge + 4u) * 4u + 3u];
    if (!token_matches(equals_token, ${blotGpuCompactSchema.terminals.equals}u) || !token_matches(semicolon_token, ${blotGpuCompactSchema.terminals.semicolon}u)) {
      fail(declaration_index, 3u, declaration_start);
      return;
    }
    let pattern_node = syntax_words[layout.edge_offset_words + (first_edge + 1u) * 4u + 3u];
    if (!node_matches(pattern_node, ${blotGpuCompactSchema.rules.bindingPattern}u, 1u)) {
      fail(declaration_index, 4u, declaration_start);
      return;
    }
    let pattern_offset = layout.node_offset_words + pattern_node * 8u;
    let pattern_edge = syntax_words[pattern_offset + 4u];
    if (!edge_matches(pattern_edge, ${blotGpuCompactSchema.fields.value}u, 0u, 0u)) {
      fail(declaration_index, 4u, declaration_start);
      return;
    }
    let name_token = syntax_words[layout.edge_offset_words + pattern_edge * 4u + 3u];
    if (!token_matches(name_token, ${blotGpuCompactSchema.terminals.identifier}u) || !token_span_valid(name_token)) {
      fail(declaration_index, 4u, declaration_start);
      return;
    }
    let name_offset = layout.token_offset_words + name_token * 4u;
    let name_start = syntax_words[name_offset + 1u];
    let name_end = syntax_words[name_offset + 2u];
    if (name_end == name_start + 1u && source_words[name_start] == 95u) {
      fail(declaration_index, 4u, name_start);
      return;
    }
    candidates[declaration_index * ROW_WORDS + 3u] = name_start;
    candidates[declaration_index * ROW_WORDS + 4u] = name_end;
    expression_node = syntax_words[layout.edge_offset_words + (first_edge + 3u) * 4u + 3u];
    declaration_kind = 1u;
  } else {
    if (!edge_matches(first_edge + 1u, ${blotGpuCompactSchema.fields.value}u, 1u, 1u) || !edge_matches(first_edge + 2u, ${blotGpuCompactSchema.fields.unnamed}u, 2u, 0u)) {
      fail(declaration_index, 3u, declaration_start);
      return;
    }
    let semicolon_token = syntax_words[layout.edge_offset_words + (first_edge + 2u) * 4u + 3u];
    if (!token_matches(semicolon_token, ${blotGpuCompactSchema.terminals.semicolon}u)) {
      fail(declaration_index, 3u, declaration_start);
      return;
    }
    expression_node = syntax_words[layout.edge_offset_words + (first_edge + 1u) * 4u + 3u];
  }
  candidates[declaration_index * ROW_WORDS] = declaration_kind;
  ${writeCount}

  if (!node_matches(expression_node, ${blotGpuCompactSchema.rules.expression}u, 1u)) {
    fail(declaration_index, 5u, declaration_start);
    return;
  }
  let expression_offset = layout.node_offset_words + expression_node * 8u;
  let expression_edge = syntax_words[expression_offset + 4u];
  if (!edge_matches(expression_edge, ${blotGpuCompactSchema.fields.value}u, 0u, 0u)) {
    fail(declaration_index, 5u, declaration_start);
    return;
  }
  let expression_token = syntax_words[layout.edge_offset_words + expression_edge * 4u + 3u];
  if (!token_span_valid(expression_token)) {
    fail(declaration_index, 5u, declaration_start);
    return;
  }
  let token_offset = layout.token_offset_words + expression_token * 4u;
  let terminal = syntax_words[token_offset];
  candidates[declaration_index * ROW_WORDS + 6u] = syntax_words[token_offset + 1u];
  candidates[declaration_index * ROW_WORDS + 7u] = syntax_words[token_offset + 2u];
  if (terminal == ${blotGpuCompactSchema.terminals.integer}u) {
    candidates[declaration_index * ROW_WORDS + 5u] = 1u;
    candidates[declaration_index * ROW_WORDS + 8u] = parse_integer(expression_token, declaration_index);
    return;
  }
  if (terminal == ${blotGpuCompactSchema.terminals.identifier}u) {
    candidates[declaration_index * ROW_WORDS + 5u] = 2u;
    return;
  }
  fail(declaration_index, 5u, syntax_words[token_offset + 1u]);
}
`).replaceAll("layout", "resident_layout");
}

function emitShader(segmented: boolean): string {
  const offsetBinding = segmented
    ? "@group(0) @binding(2) var<storage, read> binding_offsets: array<u32>;"
    : "";
  const payloadBinding = segmented ? 3 : 2;
  const metadataBinding = segmented ? 4 : 3;
  const bindingId = segmented ? "binding_offsets[index]" : "index";
  const predecessorId = segmented
    ? "binding_offsets[predecessor]"
    : "predecessor";
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> source_words: array<u32>;
@group(0) @binding(1) var<storage, read> candidates: array<u32>;
${offsetBinding}
@group(0) @binding(${payloadBinding}) var<storage, read_write> payload: array<u32>;
@group(0) @binding(${metadataBinding}) var<storage, read> metadata: array<u32>;

const ROW_WORDS = ${blotPayloadRowWords}u;

fn names_equal(left_start: u32, left_end: u32, right_start: u32, right_end: u32) -> bool {
  let length = left_end - left_start;
  if (length != right_end - right_start) {
    return false;
  }
  var offset = 0u;
  loop {
    if (offset >= length) {
      return true;
    }
    if (source_words[left_start + offset] != source_words[right_start + offset]) {
      return false;
    }
    offset += 1u;
  }
  return false;
}

@compute @workgroup_size(${blotWorkgroupSize})
fn emit_payload(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let declaration_count = metadata[1];
  if (index >= declaration_count) {
    return;
  }
  let row = index * ROW_WORDS;
  for (var column = 0u; column < ROW_WORDS; column += 1u) {
    payload[row + column] = candidates[row + column];
  }
  if (candidates[row + 9u] != 0u) {
    return;
  }
  if (candidates[row] == 1u) {
    payload[row + 11u] = ${bindingId};
  }
  if (candidates[row + 5u] != 2u) {
    return;
  }
  let use_start = candidates[row + 6u];
  let use_end = candidates[row + 7u];
  var predecessor = index;
  loop {
    if (predecessor == 0u) {
      payload[row + 9u] = 7u;
      payload[row + 10u] = use_start;
      return;
    }
    predecessor -= 1u;
    let predecessor_row = predecessor * ROW_WORDS;
    if (candidates[predecessor_row] != 1u || candidates[predecessor_row + 9u] != 0u) {
      continue;
    }
    if (names_equal(
      use_start,
      use_end,
      candidates[predecessor_row + 3u],
      candidates[predecessor_row + 4u]
    )) {
      payload[row + 8u] = ${predecessorId};
      return;
    }
  }
}
`;
}

function createBuffer(
  device: GPUDevice,
  label: string,
  words: Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = createCompilerGpuBuffer(
    device,
    label,
    {
      size: Math.max(4, words.byteLength),
      usage,
      mappedAtCreation: true,
    },
    (usage & GPUBufferUsage.UNIFORM) !== 0 ? "uniform" : "storage",
  );
  new Uint32Array(buffer.getMappedRange()).set(words);
  buffer.unmap();
  return buffer;
}
