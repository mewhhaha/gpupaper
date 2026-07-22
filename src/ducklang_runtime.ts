import type {
  DucklangAbiEffectOperation,
  DucklangAbiValueType,
  DucklangManagedAbi,
} from "./ducklang_abi.ts";

export type DucklangRuntimeValue =
  | number
  | bigint
  | boolean
  | string
  | undefined;

export type DucklangHostOperation = (
  ...arguments_: readonly DucklangRuntimeValue[]
) => DucklangRuntimeValue;

export type DucklangHostEffects = Readonly<
  Record<string, Readonly<Record<string, DucklangHostOperation>>>
>;

export type DucklangManagedProgram = {
  readonly wasm: Uint8Array;
  readonly abi: DucklangManagedAbi;
};

export async function runDucklangManaged(
  program: DucklangManagedProgram,
  init: DucklangHostEffects,
): Promise<Readonly<Record<string, DucklangRuntimeValue>>> {
  const texts = new Map<number, string>(
    program.abi.textLiterals.map((value, index) => [index + 1, value]),
  );
  let nextTextHandle = program.abi.textLiterals.length + 1;
  const imports: WebAssembly.Imports = {};
  const requirements = new Map(
    [
      ...program.abi.requirements.module,
      ...Object.values(program.abi.requirements.functions).flat(),
    ].map((requirement) => [
      `${requirement.effectName}.${requirement.operationName}`,
      requirement,
    ]),
  );
  for (const requirement of requirements.values()) {
    const initField = program.abi.init.find((field) =>
      field.effectName === requirement.effectName
    );
    if (initField === undefined) {
      throw new TypeError(
        `Ducklang ABI effect ${requirement.effectName}.${requirement.operationName} has no Init capability`,
      );
    }
    const effectObject = init[initField.fieldName];
    if (effectObject === undefined) {
      throw new TypeError(
        `Ducklang runtime requires Init field ${initField.fieldName} for effect ${requirement.effectName}`,
      );
    }
    const hostOperation = effectObject[requirement.operationName];
    if (hostOperation === undefined) {
      throw new TypeError(
        `Ducklang runtime Init field ${initField.fieldName} does not provide ${requirement.effectName}.${requirement.operationName}`,
      );
    }
    const operation = findOperation(program.abi, requirement);
    const moduleName = requirement.effectName[0].toLowerCase() +
      requirement.effectName.slice(1);
    const namespace = imports[moduleName] ?? {};
    namespace[requirement.operationName] = (...rawArguments: unknown[]) => {
      const arguments_ = operation.parameters.map((type, index) =>
        decodeWasmValue(
          rawArguments[index],
          type,
          texts,
          `${requirement.effectName}.${requirement.operationName} argument ${
            index + 1
          }`,
        )
      );
      const result = hostOperation.apply(effectObject, arguments_);
      if (isPromiseLike(result)) {
        throw new TypeError(
          `Ducklang host operation ${requirement.effectName}.${requirement.operationName} must return synchronously`,
        );
      }
      if (operation.result === "text") {
        if (typeof result !== "string") {
          throw new TypeError(
            `Ducklang host operation ${requirement.effectName}.${requirement.operationName} must return Text; received ${typeof result}`,
          );
        }
        const handle = nextTextHandle;
        nextTextHandle += 1;
        texts.set(handle, result);
        return handle;
      }
      return encodeScalarResult(
        result,
        operation.result,
        `${requirement.effectName}.${requirement.operationName}`,
      );
    };
    imports[moduleName] = namespace;
  }

  const module = await WebAssembly.compile(
    new Uint8Array(program.wasm).buffer as ArrayBuffer,
  );
  const instance = await WebAssembly.instantiate(module, imports);
  const main = instance.exports.main;
  if (!(main instanceof Function)) {
    throw new Error("managed Ducklang module has no main export");
  }
  const rawResult = main();
  if (program.abi.exports.length === 0) return {};
  const exported = program.abi.exports[0];
  if (exported === undefined) {
    throw new Error("managed Ducklang ABI lost its declared export");
  }
  return {
    [exported.name]: decodeWasmValue(
      rawResult,
      exported.type,
      texts,
      `Ducklang export ${exported.name}`,
    ),
  };
}

function findOperation(
  abi: DucklangManagedAbi,
  reference: { readonly effectName: string; readonly operationName: string },
): DucklangAbiEffectOperation {
  const operation = abi.effects.find((effect) =>
    effect.name === reference.effectName
  )?.operations.find((candidate) => candidate.name === reference.operationName);
  if (operation !== undefined) return operation;
  throw new TypeError(
    `Ducklang ABI requirement references undeclared operation ${reference.effectName}.${reference.operationName}`,
  );
}

function decodeWasmValue(
  value: unknown,
  type: DucklangAbiValueType,
  texts: ReadonlyMap<number, string>,
  subject: string,
): DucklangRuntimeValue {
  if (type === "unit") return undefined;
  if (type === "i64") {
    if (typeof value === "bigint") return value;
    throw new TypeError(
      `${subject} must be an i64 BigInt; received ${typeof value}`,
    );
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${subject} must be an i32; received ${typeof value}`);
  }
  if (type === "i32") return value;
  if (type === "bool") return value !== 0;
  const text = texts.get(value);
  if (text !== undefined) return text;
  throw new RangeError(`${subject} uses unknown Text handle ${value}`);
}

function encodeScalarResult(
  value: DucklangRuntimeValue,
  type: Exclude<DucklangAbiValueType, "text">,
  subject: string,
): number | bigint {
  if (type === "unit") {
    if (value === undefined) return 0;
    throw new TypeError(
      `${subject} must return Unit; received ${typeof value}`,
    );
  }
  if (type === "bool") {
    if (typeof value === "boolean") return value ? 1 : 0;
    throw new TypeError(
      `${subject} must return Bool; received ${typeof value}`,
    );
  }
  if (type === "i64") {
    if (typeof value === "bigint") return value;
    throw new TypeError(`${subject} must return I64; received ${typeof value}`);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${subject} must return I32; received ${typeof value}`);
  }
  if (value < -2_147_483_648 || value > 2_147_483_647) {
    throw new RangeError(
      `${subject} returned I32 value outside its signed range: ${value}`,
    );
  }
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value &&
    typeof value.then === "function";
}
