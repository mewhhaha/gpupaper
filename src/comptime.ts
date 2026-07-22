import type { Expression, Module, ValueDeclaration } from "./syntax.ts";

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

const opcode = {
  halt: 0,
  constant: 1,
  add: 2,
  subtract: 3,
  multiply: 4,
  equal: 5,
  select: 6,
} as const;

const comptimeStackCapacity = 64;

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
    else { statuses[job] = 2u; return; }
    pc += 1u;
  }
  statuses[job] = 4u;
}
`;

export function compileComptimeExpression(
  expression: Expression,
): BytecodeProgram {
  const opcodes: number[] = [];
  const operands: number[] = [];
  const emit = (node: Expression): ComptimeValue["kind"] => {
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
          node.operator === "+"
            ? opcode.add
            : node.operator === "-"
            ? opcode.subtract
            : node.operator === "*"
            ? opcode.multiply
            : opcode.equal,
        );
        operands.push(0);
        return node.operator === "==" ? "boolean" : "integer";
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
      case "comptime":
        return emit(node.expression);
      default:
        throw new TypeError(
          `${node.span.file}:${node.span.start}: compile-time bytecode requires a closed first-order expression; found ${node.kind}`,
        );
    }
  };
  const resultKind = emit(expression);
  opcodes.push(opcode.halt);
  operands.push(0);
  return { opcodes, operands, resultKind, sourceStart: expression.span.start };
}

export function evaluateBytecodeOnCpu(
  programs: readonly BytecodeProgram[],
  fuel = 1024,
): ComptimeBatchResult {
  if (!Number.isSafeInteger(fuel) || fuel < 1 || fuel > 0xffff_ffff) {
    throw new RangeError(
      `comptime fuel must be an integer from 1 through 4294967295; received ${fuel}`,
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
      } else if (operation === opcode.equal) {
        stack.push(left === right ? 1 : 0);
      } else {throw new Error(
          `comptime program at ${program.sourceStart} has unknown opcode ${operation}`,
        );}
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
  if (!Number.isSafeInteger(fuel) || fuel < 1 || fuel > 0xffff_ffff) {
    throw new RangeError(
      `comptime fuel must be an integer from 1 through 4294967295; received ${fuel}`,
    );
  }
  if (programs.length === 0) {
    return { status: "completed", values: [], backend: "gpu" };
  }
  if (navigator.gpu === undefined) {
    return {
      status: "unavailable",
      reason: "WebGPU is unavailable in this runtime",
      backend: "gpu",
    };
  }
  let device: GPUDevice;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      return {
        status: "unavailable",
        reason: "WebGPU adapter is unavailable",
        backend: "gpu",
      };
    }
    device = await adapter.requestDevice();
  } catch (error) {
    return {
      status: "unavailable",
      reason: `WebGPU device request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      backend: "gpu",
    };
  }
  const starts: number[] = [];
  const combinedOpcodes: number[] = [];
  const combinedOperands: number[] = [];
  for (const program of programs) {
    starts.push(combinedOpcodes.length);
    combinedOpcodes.push(...program.opcodes);
    combinedOperands.push(...program.operands);
  }
  const stackCapacity = comptimeStackCapacity;
  const opcodeBuffer = createGpuBuffer(
    device,
    new Uint32Array(combinedOpcodes),
    GPUBufferUsage.STORAGE,
  );
  const operandBuffer = createGpuBuffer(
    device,
    new Int32Array(combinedOperands),
    GPUBufferUsage.STORAGE,
  );
  const startBuffer = createGpuBuffer(
    device,
    new Uint32Array(starts),
    GPUBufferUsage.STORAGE,
  );
  const resultBuffer = device.createBuffer({
    size: programs.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const statusBuffer = device.createBuffer({
    size: programs.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const stackBuffer = device.createBuffer({
    size: programs.length * stackCapacity * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const parameterBuffer = createGpuBuffer(
    device,
    new Uint32Array([
      programs.length,
      Math.max(...programs.map((program) => program.opcodes.length)),
      stackCapacity,
      fuel,
    ]),
    GPUBufferUsage.UNIFORM,
  );
  const readback = device.createBuffer({
    size: programs.length * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const buffers = [
    opcodeBuffer,
    operandBuffer,
    startBuffer,
    resultBuffer,
    statusBuffer,
    stackBuffer,
    parameterBuffer,
  ];
  let readbackMapped = false;
  try {
    const shader = device.createShaderModule({ code: evaluatorShader });
    const compilation = await shader.getCompilationInfo();
    const errors = compilation.messages.filter((message) =>
      message.type === "error"
    );
    if (errors.length > 0) {
      throw new Error(
        `WebGPU comptime shader failed: ${
          errors.map((message) => message.message).join("; ")
        }`,
      );
    }
    device.pushErrorScope("validation");
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: shader, entryPoint: "evaluate" },
    });
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
    pass.dispatchWorkgroups(Math.ceil(programs.length / 64));
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
        throw new Error(
          `GPU comptime program at ${
            programs[index].sourceStart
          } failed with status ${statuses[index]}`,
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
    if (readbackMapped) readback.unmap();
    for (const buffer of [...buffers, readback]) buffer.destroy();
    device.destroy();
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

function createGpuBuffer(
  device: GPUDevice,
  values: Uint32Array | Int32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, values.byteLength),
    usage,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
  );
  buffer.unmap();
  return buffer;
}
