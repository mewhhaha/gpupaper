import type {
  Expression,
  Module,
  SourceSpan,
  ValueDeclaration,
} from "./syntax.ts";
import {
  acquireCompilerGpuErrorScope,
  compilerGpuCapacityViolation,
  createCompilerGpuBuffer,
  dispatchCompilerGpuWorkgroups,
  requestCompilerGpuDevice,
} from "./gpu_device.ts";

export type ComptimeValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean };

export type BytecodeProgram = {
  readonly opcodes: readonly number[];
  readonly operands: readonly number[];
  readonly resultKind: ComptimeValue["kind"];
  readonly sourceStart: number;
};

export type ComptimeBatchResult =
  | {
    readonly status: "completed";
    readonly values: readonly ComptimeValue[];
    readonly backend: "cpu" | "gpu";
  }
  | {
    readonly status: "unavailable";
    readonly reason: string;
    readonly backend: "gpu";
  };

export type ScalarComptimeExpression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "boolean";
    readonly value: boolean;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator:
      | "+"
      | "-"
      | "*"
      | "/"
      | "%"
      | "=="
      | "!="
      | "<"
      | "<="
      | ">"
      | ">="
      | "&&"
      | "||";
    readonly left: ScalarComptimeExpression;
    readonly right: ScalarComptimeExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: ScalarComptimeExpression;
    readonly thenBranch: ScalarComptimeExpression;
    readonly elseBranch: ScalarComptimeExpression;
    readonly span: SourceSpan;
  };

const opcode = {
  halt: 0,
  constant: 1,
  add: 2,
  subtract: 3,
  multiply: 4,
  equal: 5,
  select: 6,
  divide: 7,
  remainder: 8,
  lessThan: 9,
  greaterThan: 10,
  and: 11,
  notEqual: 12,
  lessThanOrEqual: 13,
  greaterThanOrEqual: 14,
  or: 15,
} as const;

const comptimeStackCapacity = 64;
const maximumComptimeFuel = 1_000_000;
type ComptimeGpuContextRequest =
  | {
    readonly status: "available";
    readonly device: GPUDevice;
    readonly pipeline: GPUComputePipeline;
  }
  | { readonly status: "unavailable"; readonly reason: string };
let comptimeContextPromise: Promise<ComptimeGpuContextRequest> | undefined;

const evaluatorShader = `
struct Parameters { job_count: u32, max_program_length: u32, stack_capacity: u32, fuel: u32 }
@group(0) @binding(0) var<storage, read> opcodes: array<u32>;
@group(0) @binding(1) var<storage, read> operands: array<i32>;
@group(0) @binding(2) var<storage, read> starts: array<u32>;
@group(0) @binding(3) var<storage, read_write> results: array<i32>;
@group(0) @binding(4) var<storage, read_write> statuses: array<u32>;
@group(0) @binding(5) var<storage, read_write> stacks: array<i32>;
@group(0) @binding(6) var<uniform> parameters: Parameters;

@compute @workgroup_size(64)
fn evaluate(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let job = invocation.x;
  if (job >= parameters.job_count) { return; }
  var pc = starts[job];
  var stack_size = 0u;
  let stack_start = job * parameters.stack_capacity;
  for (var step = 0u; step < parameters.fuel; step += 1u) {
    let operation = opcodes[pc];
    if (operation == 0u) {
      if (stack_size != 1u) { statuses[job] = 2u; return; }
      results[job] = stacks[stack_start];
      statuses[job] = 1u;
      return;
    }
    if (operation == 1u) {
      if (stack_size >= parameters.stack_capacity) { statuses[job] = 3u; return; }
      stacks[stack_start + stack_size] = operands[pc];
      stack_size += 1u;
      pc += 1u;
      continue;
    }
    if (operation == 6u) {
      if (stack_size < 3u) { statuses[job] = 2u; return; }
      let otherwise_value = stacks[stack_start + stack_size - 1u];
      let then_value = stacks[stack_start + stack_size - 2u];
      let condition = stacks[stack_start + stack_size - 3u];
      stack_size -= 2u;
      stacks[stack_start + stack_size - 1u] = select(otherwise_value, then_value, condition != 0);
      pc += 1u;
      continue;
    }
    if (stack_size < 2u) { statuses[job] = 2u; return; }
    let right = stacks[stack_start + stack_size - 1u];
    let left = stacks[stack_start + stack_size - 2u];
    stack_size -= 1u;
    if (operation == 2u) { stacks[stack_start + stack_size - 1u] = left + right; }
    else if (operation == 3u) { stacks[stack_start + stack_size - 1u] = left - right; }
    else if (operation == 4u) { stacks[stack_start + stack_size - 1u] = left * right; }
    else if (operation == 5u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left == right); }
    else if (operation == 7u) { stacks[stack_start + stack_size - 1u] = left / right; }
    else if (operation == 8u) { stacks[stack_start + stack_size - 1u] = left % right; }
    else if (operation == 9u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left < right); }
    else if (operation == 10u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left > right); }
    else if (operation == 11u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left != 0 && right != 0); }
    else if (operation == 12u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left != right); }
    else if (operation == 13u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left <= right); }
    else if (operation == 14u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left >= right); }
    else if (operation == 15u) { stacks[stack_start + stack_size - 1u] = select(0, 1, left != 0 || right != 0); }
    else { statuses[job] = 2u; return; }
    pc += 1u;
  }
  statuses[job] = 4u;
}
`;

export function compileComptimeExpression(
  expression: Expression,
): BytecodeProgram {
  return compileScalarComptimeExpression(
    toScalarComptimeExpression(expression),
  );
}

export function compileScalarComptimeExpression(
  expression: ScalarComptimeExpression,
): BytecodeProgram {
  const opcodes: number[] = [];
  const operands: number[] = [];
  const emit = (node: ScalarComptimeExpression): ComptimeValue["kind"] => {
    switch (node.kind) {
      case "integer":
        opcodes.push(opcode.constant);
        operands.push(node.value);
        return "integer";
      case "boolean":
        opcodes.push(opcode.constant);
        operands.push(node.value ? 1 : 0);
        return "boolean";
      case "binary":
        emit(node.left);
        emit(node.right);
        opcodes.push(
          {
            "+": opcode.add,
            "-": opcode.subtract,
            "*": opcode.multiply,
            "/": opcode.divide,
            "%": opcode.remainder,
            "==": opcode.equal,
            "!=": opcode.notEqual,
            "<": opcode.lessThan,
            "<=": opcode.lessThanOrEqual,
            ">": opcode.greaterThan,
            ">=": opcode.greaterThanOrEqual,
            "&&": opcode.and,
            "||": opcode.or,
          }[node.operator],
        );
        operands.push(0);
        return [
            "==",
            "!=",
            "<",
            "<=",
            ">",
            ">=",
            "&&",
            "||",
          ].includes(node.operator)
          ? "boolean"
          : "integer";
      case "if": {
        emit(node.condition);
        const thenKind = emit(node.thenBranch);
        const elseKind = emit(node.elseBranch);
        if (thenKind !== elseKind) {
          throw new TypeError(
            `${node.span.file}:${node.span.start}: comptime branches return unlike scalar kinds`,
          );
        }
        opcodes.push(opcode.select);
        operands.push(0);
        return thenKind;
      }
    }
  };
  const resultKind = emit(expression);
  opcodes.push(opcode.halt);
  operands.push(0);
  return { opcodes, operands, resultKind, sourceStart: expression.span.start };
}

function toScalarComptimeExpression(
  expression: Expression,
): ScalarComptimeExpression {
  switch (expression.kind) {
    case "integer":
    case "boolean":
      return expression;
    case "binary":
      return {
        ...expression,
        left: toScalarComptimeExpression(expression.left),
        right: toScalarComptimeExpression(expression.right),
      };
    case "if":
      return {
        kind: "if",
        condition: toScalarComptimeExpression(expression.condition),
        thenBranch: toScalarComptimeExpression(expression.thenBranch),
        elseBranch: toScalarComptimeExpression(expression.elseBranch),
        span: expression.span,
      };
    case "comptime":
      return toScalarComptimeExpression(expression.expression);
    default:
      throw new TypeError(
        `${expression.span.file}:${expression.span.start}: compile-time bytecode requires a closed first-order expression; found ${expression.kind}`,
      );
  }
}

export function evaluateBytecodeOnCpu(
  programs: readonly BytecodeProgram[],
  fuel = 1024,
): ComptimeBatchResult {
  if (!Number.isSafeInteger(fuel) || fuel < 1 || fuel > maximumComptimeFuel) {
    throw new RangeError(
      `comptime fuel must be an integer from 1 through ${maximumComptimeFuel}; received ${fuel}`,
    );
  }
  const values: ComptimeValue[] = programs.map((program): ComptimeValue => {
    const stack: number[] = [];
    for (let pc = 0; pc < program.opcodes.length && pc < fuel; pc += 1) {
      const operation = program.opcodes[pc];
      if (operation === opcode.halt) {
        if (stack.length !== 1) {
          throw new Error(
            `comptime program at ${program.sourceStart} halted with stack depth ${stack.length}`,
          );
        }
        return program.resultKind === "boolean"
          ? { kind: "boolean", value: stack[0] !== 0 }
          : { kind: "integer", value: stack[0] };
      }
      if (operation === opcode.constant) {
        if (stack.length >= comptimeStackCapacity) {
          throw new Error(
            `comptime program at ${program.sourceStart} exceeded stack capacity ${comptimeStackCapacity}`,
          );
        }
        stack.push(program.operands[pc]);
        continue;
      }
      if (operation === opcode.select) {
        if (stack.length < 3) {
          throw new Error(
            `comptime program at ${program.sourceStart} underflowed its stack`,
          );
        }
        const otherwiseValue = stack.pop()!;
        const thenValue = stack.pop()!;
        const condition = stack.pop()!;
        stack.push(condition !== 0 ? thenValue : otherwiseValue);
        continue;
      }
      if (stack.length < 2) {
        throw new Error(
          `comptime program at ${program.sourceStart} underflowed its stack`,
        );
      }
      const right = stack.pop()!;
      const left = stack.pop()!;
      if (operation === opcode.add) stack.push((left + right) | 0);
      else if (operation === opcode.subtract) stack.push((left - right) | 0);
      else if (operation === opcode.multiply) {
        stack.push(Math.imul(left, right));
      } else if (operation === opcode.divide) {
        if (right === 0) {
          throw new Error(
            `comptime program at ${program.sourceStart} divided by zero`,
          );
        }
        stack.push(Math.trunc(left / right));
      } else if (operation === opcode.remainder) {
        if (right === 0) {
          throw new Error(
            `comptime program at ${program.sourceStart} divided by zero`,
          );
        }
        stack.push(left % right);
      } else if (operation === opcode.equal) {
        stack.push(left === right ? 1 : 0);
      } else if (operation === opcode.notEqual) {
        stack.push(left !== right ? 1 : 0);
      } else if (operation === opcode.lessThan) {
        stack.push(left < right ? 1 : 0);
      } else if (operation === opcode.lessThanOrEqual) {
        stack.push(left <= right ? 1 : 0);
      } else if (operation === opcode.greaterThan) {
        stack.push(left > right ? 1 : 0);
      } else if (operation === opcode.greaterThanOrEqual) {
        stack.push(left >= right ? 1 : 0);
      } else if (operation === opcode.and) {
        stack.push(left !== 0 && right !== 0 ? 1 : 0);
      } else if (operation === opcode.or) {
        stack.push(left !== 0 || right !== 0 ? 1 : 0);
      } else {
        throw new Error(
          `comptime program at ${program.sourceStart} has unknown opcode ${operation}`,
        );
      }
    }
    throw new Error(
      `comptime program at ${program.sourceStart} exceeded fuel ${fuel}`,
    );
  });
  return { status: "completed", values, backend: "cpu" };
}

export async function evaluateBytecodeOnGpu(
  programs: readonly BytecodeProgram[],
  fuel = 1024,
): Promise<ComptimeBatchResult> {
  if (!Number.isSafeInteger(fuel) || fuel < 1 || fuel > maximumComptimeFuel) {
    throw new RangeError(
      `comptime fuel must be an integer from 1 through ${maximumComptimeFuel}; received ${fuel}`,
    );
  }
  if (programs.length === 0) {
    return { status: "completed", values: [], backend: "gpu" };
  }
  const context = await requestComptimeGpuContext();
  if (context.status === "unavailable") {
    return {
      status: "unavailable",
      reason: context.reason,
      backend: "gpu",
    };
  }
  const { device, pipeline } = context;
  const starts: number[] = [];
  const combinedOpcodes: number[] = [];
  const combinedOperands: number[] = [];
  for (const program of programs) {
    starts.push(combinedOpcodes.length);
    combinedOpcodes.push(...program.opcodes);
    combinedOperands.push(...program.operands);
  }
  const stackCapacity = comptimeStackCapacity;
  const capacityRequests = [
    ["opcodes", Math.max(4, combinedOpcodes.length * 4), "storage"],
    ["operands", Math.max(4, combinedOperands.length * 4), "storage"],
    ["program starts", Math.max(4, starts.length * 4), "storage"],
    ["results", programs.length * 4, "storage"],
    ["statuses", programs.length * 4, "storage"],
    ["stacks", programs.length * stackCapacity * 4, "storage"],
    ["parameters", 16, "uniform"],
    ["readback", programs.length * 8, "copy"],
  ] as const;
  for (const [label, byteLength, binding] of capacityRequests) {
    const reason = compilerGpuCapacityViolation(device.limits, {
      kind: "buffer",
      label: `comptime ${label}`,
      byteLength,
      binding,
    });
    if (reason !== undefined) {
      return { status: "unavailable", reason, backend: "gpu" };
    }
  }
  const workgroupCount = Math.ceil(programs.length / 64);
  const dispatchReason = compilerGpuCapacityViolation(device.limits, {
    kind: "dispatch",
    label: "comptime evaluation",
    workgroupCount,
  });
  if (dispatchReason !== undefined) {
    return { status: "unavailable", reason: dispatchReason, backend: "gpu" };
  }
  const opcodeBuffer = createGpuBuffer(
    device,
    "comptime opcodes",
    new Uint32Array(combinedOpcodes),
    GPUBufferUsage.STORAGE,
  );
  const operandBuffer = createGpuBuffer(
    device,
    "comptime operands",
    new Int32Array(combinedOperands),
    GPUBufferUsage.STORAGE,
  );
  const startBuffer = createGpuBuffer(
    device,
    "comptime program starts",
    new Uint32Array(starts),
    GPUBufferUsage.STORAGE,
  );
  const resultBuffer = createCompilerGpuBuffer(
    device,
    "comptime results",
    {
      size: programs.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const statusBuffer = createCompilerGpuBuffer(
    device,
    "comptime statuses",
    {
      size: programs.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    },
    "storage",
  );
  const stackBuffer = createCompilerGpuBuffer(
    device,
    "comptime stacks",
    {
      size: programs.length * stackCapacity * 4,
      usage: GPUBufferUsage.STORAGE,
    },
    "storage",
  );
  const parameterBuffer = createGpuBuffer(
    device,
    "comptime parameters",
    new Uint32Array([
      programs.length,
      Math.max(...programs.map((program) => program.opcodes.length)),
      stackCapacity,
      fuel,
    ]),
    GPUBufferUsage.UNIFORM,
  );
  const readback = createCompilerGpuBuffer(
    device,
    "comptime readback",
    {
      size: programs.length * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    },
    "copy",
  );
  const buffers = [
    opcodeBuffer,
    operandBuffer,
    startBuffer,
    resultBuffer,
    statusBuffer,
    stackBuffer,
    parameterBuffer,
  ];
  const releaseEvaluation = await acquireCompilerGpuErrorScope();
  let readbackMapped = false;
  let validationScopePending = false;
  try {
    device.pushErrorScope("validation");
    validationScopePending = true;
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    dispatchCompilerGpuWorkgroups(
      device,
      pass,
      "comptime evaluation",
      workgroupCount,
    );
    pass.end();
    encoder.copyBufferToBuffer(
      resultBuffer,
      0,
      readback,
      0,
      programs.length * 4,
    );
    encoder.copyBufferToBuffer(
      statusBuffer,
      0,
      readback,
      programs.length * 4,
      programs.length * 4,
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    readbackMapped = true;
    const validationError = await device.popErrorScope();
    validationScopePending = false;
    if (validationError !== null) {
      throw new Error(
        `WebGPU comptime validation failed: ${validationError.message}`,
      );
    }
    const mapped = readback.getMappedRange();
    const values = new Int32Array(mapped, 0, programs.length);
    const statuses = new Uint32Array(
      mapped,
      programs.length * 4,
      programs.length,
    );
    const completed: ComptimeValue[] = [];
    for (let index = 0; index < programs.length; index += 1) {
      if (statuses[index] !== 1) {
        const failure = statuses[index] === 2
          ? "executed malformed bytecode"
          : statuses[index] === 3
          ? `exceeded stack capacity ${comptimeStackCapacity}`
          : statuses[index] === 4
          ? `exceeded fuel ${fuel}`
          : `returned unknown status ${statuses[index]}`;
        throw new Error(
          `GPU comptime program at ${programs[index].sourceStart} ${failure}`,
        );
      }
      completed.push(
        programs[index].resultKind === "boolean"
          ? { kind: "boolean", value: values[index] !== 0 }
          : { kind: "integer", value: values[index] },
      );
    }
    return { status: "completed", values: completed, backend: "gpu" };
  } finally {
    if (validationScopePending) await device.popErrorScope();
    if (readbackMapped) readback.unmap();
    for (const buffer of [...buffers, readback]) buffer.destroy();
    releaseEvaluation();
  }
}

export async function evaluateModuleComptime(
  module: Module,
  runGpu: boolean,
): Promise<
  {
    readonly module: Module;
    readonly cpuValues: readonly ComptimeValue[];
    readonly gpu: ComptimeBatchResult | undefined;
  }
> {
  const expressions: Expression[] = [];
  for (const declaration of module.declarations) {
    if (declaration.kind === "value") {
      collectBytecodeComptime(declaration.expression, expressions);
    }
  }
  const programs = expressions.map(compileComptimeExpression);
  const cpu = evaluateBytecodeOnCpu(programs);
  const gpu = runGpu ? await evaluateBytecodeOnGpu(programs) : undefined;
  if (cpu.status !== "completed") {
    throw new Error("CPU comptime evaluator did not complete");
  }
  if (gpu?.status === "completed") {
    for (let index = 0; index < cpu.values.length; index += 1) {
      if (
        JSON.stringify(cpu.values[index]) !== JSON.stringify(gpu.values[index])
      ) throw new Error(`CPU/GPU comptime mismatch at job ${index}`);
    }
  }
  let valueIndex = 0;
  const declarations = module.declarations.map((declaration) => {
    if (declaration.kind !== "value") return declaration;
    const expression = replaceBytecodeComptime(
      declaration.expression,
      cpu.values,
      () => valueIndex++,
    );
    return { ...declaration, expression } satisfies ValueDeclaration;
  });
  return { module: { ...module, declarations }, cpuValues: cpu.values, gpu };
}

function collectBytecodeComptime(
  expression: Expression,
  expressions: Expression[],
): void {
  if (expression.kind === "comptime" && expression.backend === "bytecode") {
    expressions.push(expression.expression);
    return;
  }
  for (const child of expressionChildren(expression)) {
    collectBytecodeComptime(child, expressions);
  }
}

function replaceBytecodeComptime(
  expression: Expression,
  values: readonly ComptimeValue[],
  nextIndex: () => number,
): Expression {
  if (expression.kind === "comptime" && expression.backend === "bytecode") {
    const value = values[nextIndex()];
    return value.kind === "integer"
      ? { kind: "integer", value: value.value, span: expression.span }
      : { kind: "boolean", value: value.value, span: expression.span };
  }
  switch (expression.kind) {
    case "lambda":
      return {
        ...expression,
        body: replaceBytecodeComptime(expression.body, values, nextIndex),
      };
    case "apply":
      return {
        ...expression,
        callee: replaceBytecodeComptime(expression.callee, values, nextIndex),
        argument: replaceBytecodeComptime(
          expression.argument,
          values,
          nextIndex,
        ),
      };
    case "let":
      return {
        ...expression,
        value: replaceBytecodeComptime(expression.value, values, nextIndex),
        body: replaceBytecodeComptime(expression.body, values, nextIndex),
      };
    case "if":
      return {
        ...expression,
        condition: replaceBytecodeComptime(
          expression.condition,
          values,
          nextIndex,
        ),
        thenBranch: replaceBytecodeComptime(
          expression.thenBranch,
          values,
          nextIndex,
        ),
        elseBranch: replaceBytecodeComptime(
          expression.elseBranch,
          values,
          nextIndex,
        ),
      };
    case "binary":
      return {
        ...expression,
        left: replaceBytecodeComptime(expression.left, values, nextIndex),
        right: replaceBytecodeComptime(expression.right, values, nextIndex),
      };
    case "case":
      return {
        ...expression,
        scrutinee: replaceBytecodeComptime(
          expression.scrutinee,
          values,
          nextIndex,
        ),
        alternatives: expression.alternatives.map((alternative) => ({
          ...alternative,
          expression: replaceBytecodeComptime(
            alternative.expression,
            values,
            nextIndex,
          ),
        })),
      };
    default:
      return expression;
  }
}

function expressionChildren(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "lambda":
      return [expression.body];
    case "apply":
      return [expression.callee, expression.argument];
    case "let":
      return [expression.value, expression.body];
    case "if":
      return [
        expression.condition,
        expression.thenBranch,
        expression.elseBranch,
      ];
    case "binary":
      return [expression.left, expression.right];
    case "comptime":
      return [expression.expression];
    case "case":
      return [
        expression.scrutinee,
        ...expression.alternatives.map((alternative) => alternative.expression),
      ];
    default:
      return [];
  }
}

function requestComptimeGpuContext(): Promise<ComptimeGpuContextRequest> {
  if (comptimeContextPromise !== undefined) return comptimeContextPromise;
  const pendingContext: Promise<ComptimeGpuContextRequest> = (async () => {
    try {
      const request = await requestCompilerGpuDevice();
      if (request.status === "unavailable") return request;
      const device = request.device;
      const shader = device.createShaderModule({ code: evaluatorShader });
      const errors = (await shader.getCompilationInfo()).messages.filter(
        (message) => message.type === "error",
      );
      if (errors.length > 0) {
        throw new Error(
          `WebGPU comptime shader failed: ${
            errors.map((message) => message.message).join("; ")
          }`,
        );
      }
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: shader, entryPoint: "evaluate" },
      });
      return { status: "available", device, pipeline };
    } catch (error) {
      return {
        status: "unavailable",
        reason: `WebGPU comptime initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  })();
  comptimeContextPromise = pendingContext;
  void pendingContext.then((context) => {
    if (context.status === "unavailable") {
      if (comptimeContextPromise === pendingContext) {
        comptimeContextPromise = undefined;
      }
      return;
    }
    void context.device.lost.then(() => {
      if (comptimeContextPromise === pendingContext) {
        comptimeContextPromise = undefined;
      }
    });
  });
  return pendingContext;
}

function createGpuBuffer(
  device: GPUDevice,
  label: string,
  values: Uint32Array | Int32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const binding = (usage & GPUBufferUsage.UNIFORM) !== 0
    ? "uniform"
    : "storage";
  const buffer = createCompilerGpuBuffer(
    device,
    label,
    {
      size: Math.max(4, values.byteLength),
      usage,
      mappedAtCreation: true,
    },
    binding,
  );
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
  );
  buffer.unmap();
  return buffer;
}
