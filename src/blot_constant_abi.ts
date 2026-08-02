import type { BlotAbiManifest, BlotAbiType } from "./blot_runtime_abi.ts";
import { flattenedAbiType } from "./blot_runtime_abi.ts";
import type {
  BlotRuntimeFunction,
  BlotRuntimeModule,
} from "./blot_runtime_hir.ts";
import { addBlotAbiModuleShell } from "./ducklang_core_wasm.ts";
import {
  emitWasmPlanOnCpu,
  type WasmBinaryPlan,
  type WasmInstruction,
  wasmInstruction,
  WasmModuleBuilder,
  wasmType,
} from "./wasm.ts";

type ConstantValue =
  | bigint
  | number
  | boolean
  | string
  | null
  | {
    readonly kind: "product";
    readonly fields: ReadonlyMap<string, ConstantValue>;
  }
  | {
    readonly kind: "sum";
    readonly case: number;
    readonly payload: ConstantValue;
  }
  | { readonly kind: "store"; readonly elements: readonly ConstantValue[] };

type PlannedTemplate = {
  readonly contents: Uint8Array;
  readonly relocations: readonly {
    readonly fieldOffset: number;
    readonly targetOffset: number;
  }[];
};

type ConstantHostCall = {
  readonly capability: string;
  readonly operation: string;
  readonly argument: ConstantValue;
};

export type BlotConstantAbiArtifact = {
  readonly wasmPlan: WasmBinaryPlan;
  readonly wasm: Uint8Array;
};

export function compileBlotConstantAbi(
  module: BlotRuntimeModule,
  manifest: BlotAbiManifest,
  manifestBytes: Uint8Array,
): BlotConstantAbiArtifact {
  const runtimeExports = module.exports.filter((exported) =>
    exported.phase === "runtime"
  );
  const planned = runtimeExports.map((exported) => {
    const signature = module.signatures[exported.signature];
    if (signature.parameters.length !== 0) {
      throw new TypeError(
        `${module.source}: constant ABI export ${exported.wasmName} has ${signature.parameters.length} parameters`,
      );
    }
    return {
      exported,
      evaluation: evaluateConstantFunction(
        module,
        module.functions[exported.function],
      ),
      manifest: requiredManifestExport(manifest, exported.wasmName),
    };
  });
  const templates = planned.map((exported) => {
    const type = exported.manifest.function!.result;
    return flattenedAbiType(type).length > 1
      ? new CanonicalTemplate(type, exported.evaluation.value).finish()
      : null;
  });
  let staticEnd = 1_024;
  const staticOffsets = templates.map((template) => {
    if (template === null) return 0;
    const offset = staticEnd;
    staticEnd = alignTo(staticEnd + template.contents.byteLength, 8);
    return offset;
  });
  const hostCalls = planned.map((exported) =>
    exported.evaluation.calls.map((call) => {
      const imported = requiredManifestImport(
        manifest,
        call.capability,
        call.operation,
      );
      if (imported.function.parameters.length !== 1) {
        throw new TypeError(
          `${module.source}: constant host call ${call.capability}.${call.operation} requires one parameter`,
        );
      }
      if (flattenedAbiType(imported.function.result).length !== 0) {
        throw new TypeError(
          `${module.source}: constant host call ${call.capability}.${call.operation} does not return unit`,
        );
      }
      const parameter = imported.function.parameters[0];
      if (parameter.kind !== "text") {
        return { call, imported, text: null };
      }
      if (typeof call.argument !== "string") {
        throw constantMismatch(parameter, call.argument);
      }
      const contents = new TextEncoder().encode(call.argument);
      const offset = staticEnd;
      staticEnd += contents.byteLength;
      return { call, imported, text: { contents, offset } };
    })
  );
  const heapStart = alignTo(staticEnd, 8);
  const minimumPages = Math.max(1, Math.ceil(heapStart / 65_536));
  const builder = new WasmModuleBuilder();
  const importedFunctions = new Map<string, number>();
  for (const imported of manifest.imports) {
    const parameters = imported.function.parameters.flatMap(flattenedAbiType);
    const results = flattenedAbiType(imported.function.result);
    if (parameters.length > 16 || results.length !== 0) {
      throw new TypeError(
        `${module.source}: constant host import ${imported.module}.${imported.name} exceeds the direct unit-result subset`,
      );
    }
    const type = builder.addFunctionType(
      parameters.map(flatWasmType),
      [],
    );
    importedFunctions.set(
      `${imported.capability}.${imported.operation}`,
      builder.addFunctionImport(imported.module, imported.name, type),
    );
  }
  const shell = addBlotAbiModuleShell(
    builder,
    manifestBytes,
    heapStart,
    minimumPages,
  );
  const activeExport = builder.addI32Global(wasmType.i32, 0, true);
  const resultPointer = builder.addI32Global(wasmType.i32, 0, true);
  const heapCheckpoint = builder.addI32Global(wasmType.i32, heapStart, true);

  for (const calls of hostCalls) {
    for (const call of calls) {
      if (call.text !== null) {
        builder.addActiveData(0, call.text.offset, call.text.contents);
      }
    }
  }

  for (const [index, exported] of planned.entries()) {
    const abiType = exported.manifest.function!.result;
    const flattened = flattenedAbiType(abiType);
    const callInstructions = hostCalls[index].flatMap((call) => {
      const importIndex = importedFunctions.get(
        `${call.call.capability}.${call.call.operation}`,
      );
      if (importIndex === undefined) {
        throw new Error(
          `manifest omitted host import ${call.call.capability}.${call.call.operation}`,
        );
      }
      const parameter = call.imported.function.parameters[0];
      const argument = call.text === null
        ? directConstant(parameter, call.call.argument)
        : [
          ...wasmInstruction.i32Constant(call.text.offset),
          ...wasmInstruction.i32Constant(call.text.contents.byteLength),
        ];
      return [...argument, ...wasmInstruction.call(importIndex)];
    });
    const callId = index + 1;
    const beginCall = [
      ...wasmInstruction.globalGet(activeExport),
      ...wasmInstruction.i32EqualZero,
      ...wasmInstruction.i32EqualZero,
      ...wasmInstruction.ifVoid,
      ...wasmInstruction.unreachable,
      ...wasmInstruction.end,
      ...wasmInstruction.globalGet(shell.heap),
      ...wasmInstruction.globalSet(heapCheckpoint),
      ...wasmInstruction.i32Constant(callId),
      ...wasmInstruction.globalSet(activeExport),
    ];
    const finishCall = [
      ...wasmInstruction.globalGet(heapCheckpoint),
      ...wasmInstruction.globalSet(shell.heap),
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.globalSet(resultPointer),
      ...wasmInstruction.i32Constant(0),
      ...wasmInstruction.globalSet(activeExport),
    ];
    let functionIndex: number;
    if (flattened.length === 0) {
      const type = builder.addFunctionType([], []);
      functionIndex = builder.addFunction(type, [], [
        ...beginCall,
        ...callInstructions,
        ...finishCall,
      ]);
    } else if (flattened.length === 1) {
      const type = builder.addFunctionType([], [flatWasmType(flattened[0])]);
      const valueLocal = 0;
      functionIndex = builder.addFunction(
        type,
        [flatWasmType(flattened[0])],
        [
          ...beginCall,
          ...callInstructions,
          ...directConstant(abiType, exported.evaluation.value),
          ...wasmInstruction.localSet(valueLocal),
          ...finishCall,
          ...wasmInstruction.localGet(valueLocal),
        ],
      );
    } else {
      const template = templates[index]!;
      const sourceOffset = staticOffsets[index];
      builder.addActiveData(0, sourceOffset, template.contents);
      const type = builder.addFunctionType([], [wasmType.i32]);
      const baseLocal = 0;
      functionIndex = builder.addFunction(type, [wasmType.i32], [
        ...beginCall,
        ...callInstructions,
        ...wasmInstruction.i32Constant(0),
        ...wasmInstruction.i32Constant(0),
        ...wasmInstruction.i32Constant(8),
        ...wasmInstruction.i32Constant(template.contents.byteLength),
        ...wasmInstruction.call(shell.realloc),
        ...wasmInstruction.localTee(baseLocal),
        ...wasmInstruction.i32Constant(sourceOffset),
        ...wasmInstruction.i32Constant(template.contents.byteLength),
        ...wasmInstruction.memoryCopy,
        ...template.relocations.flatMap((relocation) => [
          ...wasmInstruction.localGet(baseLocal),
          ...wasmInstruction.i32Constant(relocation.fieldOffset),
          ...wasmInstruction.i32Add,
          ...wasmInstruction.localGet(baseLocal),
          ...wasmInstruction.i32Constant(relocation.targetOffset),
          ...wasmInstruction.i32Add,
          ...wasmInstruction.i32Store(),
        ]),
        ...wasmInstruction.localGet(baseLocal),
        ...wasmInstruction.globalSet(resultPointer),
        ...wasmInstruction.localGet(baseLocal),
      ]);
      const postType = builder.addFunctionType([wasmType.i32], []);
      const post = builder.addFunction(postType, [], [
        ...wasmInstruction.globalGet(activeExport),
        ...wasmInstruction.i32Constant(callId),
        ...wasmInstruction.i32Equal,
        ...wasmInstruction.i32EqualZero,
        ...wasmInstruction.ifVoid,
        ...wasmInstruction.unreachable,
        ...wasmInstruction.end,
        ...wasmInstruction.globalGet(resultPointer),
        ...wasmInstruction.localGet(0),
        ...wasmInstruction.i32Equal,
        ...wasmInstruction.i32EqualZero,
        ...wasmInstruction.ifVoid,
        ...wasmInstruction.unreachable,
        ...wasmInstruction.end,
        ...finishCall,
      ]);
      builder.exportFunction(`cabi_post_${exported.exported.wasmName}`, post);
    }
    builder.exportFunction(exported.exported.wasmName, functionIndex);
  }
  const wasmPlan = builder.finishPlan();
  const wasm = emitWasmPlanOnCpu(wasmPlan);
  new WebAssembly.Module(new Uint8Array(wasm).buffer as ArrayBuffer);
  return { wasmPlan, wasm };
}

class CanonicalTemplate {
  readonly #bytes: number[] = [];
  readonly #relocations: { fieldOffset: number; targetOffset: number }[] = [];
  readonly #rootType: BlotAbiType;
  readonly #rootValue: ConstantValue;

  constructor(type: BlotAbiType, value: ConstantValue) {
    this.#rootType = type;
    this.#rootValue = value;
  }

  finish(): PlannedTemplate {
    const layout = memoryLayout(this.#rootType);
    const root = this.allocate(layout.size, layout.alignment);
    if (root !== 0) throw new Error(`canonical template root began at ${root}`);
    this.write(this.#rootType, this.#rootValue, root);
    return {
      contents: new Uint8Array(this.#bytes),
      relocations: this.#relocations,
    };
  }

  private write(type: BlotAbiType, value: ConstantValue, offset: number): void {
    if (type.kind === "unit") return;
    if (type.kind === "signed-integer-64") {
      if (typeof value !== "bigint") throw constantMismatch(type, value);
      this.set(offset, 8, (view) => view.setBigInt64(0, value, true));
      return;
    }
    if (type.kind === "float-32") {
      if (typeof value !== "number") throw constantMismatch(type, value);
      this.set(offset, 4, (view) => view.setFloat32(0, value, true));
      return;
    }
    if (type.kind === "float-64") {
      if (typeof value !== "number") throw constantMismatch(type, value);
      this.set(offset, 8, (view) => view.setFloat64(0, value, true));
      return;
    }
    if (type.kind === "boolean") {
      if (typeof value !== "boolean") throw constantMismatch(type, value);
      this.#bytes[offset] = value ? 1 : 0;
      return;
    }
    if (type.kind === "text") {
      if (typeof value !== "string") throw constantMismatch(type, value);
      const encoded = new TextEncoder().encode(value);
      const target = this.allocate(encoded.byteLength, 1);
      this.#bytes.splice(target, encoded.byteLength, ...encoded);
      this.pointer(offset, target);
      this.set(
        offset + 4,
        4,
        (view) => view.setUint32(0, encoded.byteLength, true),
      );
      return;
    }
    if (type.kind === "array") {
      if (!isStore(value)) throw constantMismatch(type, value);
      const element = memoryLayout(type.element);
      const target = this.allocate(
        element.size * value.elements.length,
        element.alignment,
      );
      value.elements.forEach((entry, index) =>
        this.write(type.element, entry, target + index * element.size)
      );
      this.pointer(offset, target);
      this.set(
        offset + 4,
        4,
        (view) => view.setUint32(0, value.elements.length, true),
      );
      return;
    }
    if (type.kind === "sealed") {
      this.write(type.inner, value, offset);
      return;
    }
    if (type.kind === "record") {
      if (!isProduct(value)) throw constantMismatch(type, value);
      const fields = recordLayout(type);
      for (const field of fields) {
        const fieldValue = value.fields.get(field.name);
        if (fieldValue === undefined) throw constantMismatch(type, value);
        this.write(field.type, fieldValue, offset + field.offset);
      }
      return;
    }
    if (!isSum(value)) throw constantMismatch(type, value);
    const cases = [...type.cases].sort(byName);
    const sourceCase = type.cases[value.case];
    if (sourceCase === undefined) throw constantMismatch(type, value);
    const tag = cases.findIndex((case_) => case_.name === sourceCase.name);
    const layout = variantLayout(type);
    if (layout.discriminantSize === 1) this.#bytes[offset] = tag;
    else if (layout.discriminantSize === 2) {
      this.set(offset, 2, (view) => view.setUint16(0, tag, true));
    } else this.set(offset, 4, (view) => view.setUint32(0, tag, true));
    if (sourceCase.payload !== undefined) {
      this.write(
        sourceCase.payload,
        value.payload,
        offset + layout.payloadOffset,
      );
    }
  }

  private pointer(fieldOffset: number, targetOffset: number): void {
    this.set(fieldOffset, 4, (view) => view.setUint32(0, targetOffset, true));
    this.#relocations.push({ fieldOffset, targetOffset });
  }

  private allocate(size: number, alignment: number): number {
    const offset = alignTo(this.#bytes.length, alignment);
    while (this.#bytes.length < offset + size) this.#bytes.push(0);
    return offset;
  }

  private set(
    offset: number,
    size: number,
    write: (view: DataView) => void,
  ): void {
    const encoded = new Uint8Array(size);
    write(new DataView(encoded.buffer));
    for (let index = 0; index < size; index += 1) {
      this.#bytes[offset + index] = encoded[index];
    }
  }
}

function evaluateConstantFunction(
  module: BlotRuntimeModule,
  function_: BlotRuntimeFunction,
): {
  readonly value: ConstantValue;
  readonly calls: readonly ConstantHostCall[];
} {
  if (
    function_.blocks.length !== 1 || function_.blocks[0].parameters.length !== 0
  ) {
    throw new TypeError(
      `${module.source}: ${function_.name} is not a closed constant function`,
    );
  }
  const block = function_.blocks[0];
  const values = new Map<number, ConstantValue>();
  const calls: ConstantHostCall[] = [];
  for (const operation of block.operations) {
    const operands = operation.operands.map((operand) => {
      if (!values.has(operand)) {
        throw new Error(
          `${module.source}: constant operation reads value ${operand}`,
        );
      }
      return values.get(operand)!;
    });
    let result: ConstantValue;
    if (operation.kind === "constant") result = operation.value;
    else if (operation.kind === "product.make") {
      const type = module.types[operation.type];
      if (type.kind !== "product") {
        throw new TypeError(
          `${module.source}: product.make has type ${operation.type}`,
        );
      }
      result = {
        kind: "product",
        fields: new Map(
          type.fields.map((field, index) =>
            [field.name, operands[index]] as const
          ),
        ),
      };
    } else if (operation.kind === "sum.make") {
      result = { kind: "sum", case: operation.case, payload: operands[0] };
    } else if (operation.kind === "store.empty") {
      result = { kind: "store", elements: [] };
    } else if (operation.kind === "store.new") {
      const length = operands[0];
      if (typeof length !== "bigint" || length < 0n || length > 16_777_216n) {
        throw new RangeError(
          `${module.source}: invalid constant Store length ${String(length)}`,
        );
      }
      result = {
        kind: "store",
        elements: Array(Number(length)).fill(operands[1]),
      };
    } else if (operation.kind === "store.write") {
      const store = operands[0];
      const index = operands[1];
      if (!isStore(store) || typeof index !== "bigint") {
        throw new TypeError(`${module.source}: invalid constant Store write`);
      }
      const elements = [...store.elements];
      if (index < 0n || index >= BigInt(elements.length)) {
        throw new RangeError(
          `${module.source}: constant Store index ${index} is out of bounds`,
        );
      }
      elements[Number(index)] = operands[2];
      result = { kind: "store", elements };
    } else if (operation.kind === "store.grow") {
      const store = operands[0];
      const length = operands[1];
      if (!isStore(store) || typeof length !== "bigint" || length < 0n) {
        throw new TypeError(`${module.source}: invalid constant Store grow`);
      }
      const elements = store.elements.slice(0, Number(length));
      while (elements.length < Number(length)) elements.push(operands[2]);
      result = { kind: "store", elements };
    } else if (
      operation.kind === "seal.wrap" ||
      operation.kind === "seal.unwrap" ||
      operation.kind === "resource.move" ||
      operation.kind === "resource.borrow" ||
      operation.kind === "resource.freeze"
    ) result = operands[0];
    else if (operation.kind === "host.call") {
      calls.push({
        capability: operation.capability,
        operation: operation.operation,
        argument: operands[0],
      });
      result = null;
    } else {
      throw new TypeError(
        `${module.source}: ${function_.name} contains non-constant ${operation.kind}`,
      );
    }
    values.set(operation.result, result);
  }
  if (block.terminator.kind !== "return") {
    throw new TypeError(
      `${module.source}: ${function_.name} does not directly return`,
    );
  }
  const result = values.get(block.terminator.value);
  if (result === undefined) {
    throw new Error(
      `${module.source}: ${function_.name} omitted its constant result`,
    );
  }
  return { value: result, calls };
}

function directConstant(
  type: BlotAbiType,
  value: ConstantValue,
): readonly WasmInstruction[] {
  if (type.kind === "unit") return [];
  if (type.kind === "signed-integer-64" && typeof value === "bigint") {
    return wasmInstruction.i64Constant(value);
  }
  if (type.kind === "float-32" && typeof value === "number") {
    return wasmInstruction.f32Constant(value);
  }
  if (type.kind === "float-64" && typeof value === "number") {
    return wasmInstruction.f64Constant(value);
  }
  if (type.kind === "boolean" && typeof value === "boolean") {
    return wasmInstruction.i32Constant(value ? 1 : 0);
  }
  if (type.kind === "sealed") return directConstant(type.inner, value);
  if (type.kind === "record" && isProduct(value)) {
    const flattened = type.fields.flatMap((field) =>
      flattenedAbiType(field.type).length === 0
        ? []
        : [{ type: field.type, value: value.fields.get(field.name)! }]
    );
    if (flattened.length === 1) {
      return directConstant(flattened[0].type, flattened[0].value);
    }
  }
  if (type.kind === "variant" && isSum(value)) {
    const cases = [...type.cases].sort(byName);
    const sourceCase = type.cases[value.case];
    const tag = cases.findIndex((case_) => case_.name === sourceCase?.name);
    if (flattenedAbiType(type).length === 1 && tag >= 0) {
      return wasmInstruction.i32Constant(tag);
    }
  }
  throw constantMismatch(type, value);
}

function memoryLayout(type: BlotAbiType): { alignment: number; size: number } {
  if (type.kind === "unit") return { alignment: 1, size: 0 };
  if (type.kind === "boolean") return { alignment: 1, size: 1 };
  if (type.kind === "float-32") return { alignment: 4, size: 4 };
  if (type.kind === "signed-integer-64" || type.kind === "float-64") {
    return { alignment: 8, size: 8 };
  }
  if (type.kind === "text" || type.kind === "array") {
    return { alignment: 4, size: 8 };
  }
  if (type.kind === "sealed") return memoryLayout(type.inner);
  if (type.kind === "record") {
    const fields = recordLayout(type);
    const alignment = fields.reduce(
      (maximum, field) => Math.max(maximum, memoryLayout(field.type).alignment),
      1,
    );
    const end = fields.reduce(
      (maximum, field) =>
        Math.max(maximum, field.offset + memoryLayout(field.type).size),
      0,
    );
    return { alignment, size: alignTo(end, alignment) };
  }
  const layout = variantLayout(type);
  return { alignment: layout.alignment, size: layout.size };
}

function recordLayout(type: Extract<BlotAbiType, { kind: "record" }>) {
  let offset = 0;
  return [...type.fields].sort(byName).map((field) => {
    const layout = memoryLayout(field.type);
    offset = alignTo(offset, layout.alignment);
    const result = { ...field, offset };
    offset += layout.size;
    return result;
  });
}

function variantLayout(type: Extract<BlotAbiType, { kind: "variant" }>) {
  const discriminantSize = type.cases.length <= 256
    ? 1
    : type.cases.length <= 65_536
    ? 2
    : 4;
  let payloadAlignment = 1;
  let payloadSize = 0;
  for (const case_ of type.cases) {
    if (case_.payload === undefined) continue;
    const layout = memoryLayout(case_.payload);
    payloadAlignment = Math.max(payloadAlignment, layout.alignment);
    payloadSize = Math.max(payloadSize, layout.size);
  }
  const alignment = Math.max(discriminantSize, payloadAlignment);
  const payloadOffset = alignTo(discriminantSize, payloadAlignment);
  return {
    discriminantSize,
    payloadOffset,
    alignment,
    size: alignTo(payloadOffset + payloadSize, alignment),
  };
}

function requiredManifestExport(manifest: BlotAbiManifest, name: string) {
  const exported = manifest.exports.find((candidate) =>
    candidate.name === name
  );
  if (exported?.function === null || exported === undefined) {
    throw new Error(`manifest omitted runtime export ${name}`);
  }
  return exported;
}

function requiredManifestImport(
  manifest: BlotAbiManifest,
  capability: string,
  operation: string,
) {
  const imported = manifest.imports.find((candidate) =>
    candidate.capability === capability && candidate.operation === operation
  );
  if (imported === undefined) {
    throw new Error(`manifest omitted host import ${capability}.${operation}`);
  }
  return imported;
}

function flatWasmType(type: "i32" | "i64" | "f32" | "f64"): number {
  return type === "i32"
    ? wasmType.i32
    : type === "i64"
    ? wasmType.i64
    : type === "f32"
    ? wasmType.f32
    : wasmType.f64;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function byName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function isProduct(
  value: ConstantValue,
): value is Extract<ConstantValue, { kind: "product" }> {
  return typeof value === "object" && value !== null && "kind" in value &&
    value.kind === "product";
}

function isSum(
  value: ConstantValue,
): value is Extract<ConstantValue, { kind: "sum" }> {
  return typeof value === "object" && value !== null && "kind" in value &&
    value.kind === "sum";
}

function isStore(
  value: ConstantValue,
): value is Extract<ConstantValue, { kind: "store" }> {
  return typeof value === "object" && value !== null && "kind" in value &&
    value.kind === "store";
}

function constantMismatch(type: BlotAbiType, value: ConstantValue): TypeError {
  const valueKind =
    typeof value === "object" && value !== null && "kind" in value
      ? value.kind
      : typeof value;
  return new TypeError(
    `canonical ${type.kind} cannot encode constant ${valueKind}`,
  );
}
