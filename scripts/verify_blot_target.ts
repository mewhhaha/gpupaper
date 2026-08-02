import {
  prepareGpupaperHir,
  runLoweringExport,
  validateLowering,
} from "../../blot/src/backend/compile.ts";
import { compileBlotRuntimeModule } from "../src/blot_runtime_target.ts";
import { validateBlotRuntimeModule } from "../src/blot_runtime_hir.ts";
import {
  type BlotCanonicalValue,
  decodeBlotAbiResult,
  equalBlotCanonicalValues,
  normalizeGpufuckValue,
} from "../src/blot_abi_decode.ts";
import type { BlotAbiManifest, BlotAbiType } from "../src/blot_runtime_abi.ts";

type EffectObservation = {
  readonly capability: string;
  readonly operation: string;
  readonly argument: BlotCanonicalValue;
};

const root = new URL("../../blot/examples/", import.meta.url);
const files: string[] = [];
for await (const entry of Deno.readDir(root)) {
  if (entry.isFile && entry.name.endsWith(".blot")) files.push(entry.name);
}
files.sort();

let admitted = 0;
let observations = 0;
const rejected: { file: string; reason: string }[] = [];
for (const file of files) {
  const path = new URL(file, root).pathname;
  try {
    const hir = await prepareGpupaperHir(path);
    const artifact = compileBlotRuntimeModule(validateBlotRuntimeModule(hir));
    if (artifact.wasm === undefined) throw new Error("target omitted CPU Wasm");
    const oracleManifest = await validateLowering(path);
    if (JSON.stringify(artifact.manifest) !== JSON.stringify(oracleManifest)) {
      throw new Error("gpupaper and gpufuck ABI manifests differ");
    }
    const targetEffects: EffectObservation[] = [];
    const targetState: { memory?: WebAssembly.Memory } = {};
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(
        new Uint8Array(artifact.wasm).buffer as ArrayBuffer,
      ),
      targetImports(artifact.manifest, targetEffects, () => targetState.memory),
    );
    if (!(instance.exports.memory instanceof WebAssembly.Memory)) {
      throw new Error("gpupaper omitted canonical memory");
    }
    targetState.memory = instance.exports.memory;
    for (const exported of hir.exports) {
      if (exported.phase !== "runtime") continue;
      const target = instance.exports[exported.wasmName];
      if (!(target instanceof Function)) {
        throw new Error(`gpupaper omitted ${exported.wasmName}`);
      }
      targetEffects.length = 0;
      const actual = target();
      const manifestExport = artifact.manifest.exports.find((candidate) =>
        candidate.name === exported.wasmName
      );
      if (manifestExport?.function === null || manifestExport === undefined) {
        throw new Error(`manifest omitted ${exported.wasmName}`);
      }
      const oracleEffects: EffectObservation[] = [];
      const expected = await runLoweringExport(
        path,
        exported.sourceName,
        [],
        oracleImports(artifact.manifest, oracleEffects),
      );
      const actualValue = decodeBlotAbiResult(
        manifestExport.function.result,
        actual,
        instance.exports.memory,
      );
      const expectedValue = normalizeGpufuckValue(
        manifestExport.function.result,
        expected,
        hir,
        hir.signatures[exported.signature].result,
      );
      if (!equalBlotCanonicalValues(actualValue, expectedValue)) {
        throw new Error(
          `${exported.sourceName} differs after canonical decoding`,
        );
      }
      requireEqualEffects(exported.sourceName, targetEffects, oracleEffects);
      if (manifestExport.postReturn !== null) {
        const post = instance.exports[manifestExport.postReturn];
        if (!(post instanceof Function)) {
          throw new Error(`gpupaper omitted ${manifestExport.postReturn}`);
        }
        post(actual);
      }
      observations += 1;
    }
    admitted += 1;
  } catch (error) {
    rejected.push({
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function targetImports(
  manifest: BlotAbiManifest,
  effects: EffectObservation[],
  memory: () => WebAssembly.Memory | undefined,
): WebAssembly.Imports {
  const modules: Record<string, Record<string, CallableFunction>> = {};
  for (const imported of manifest.imports) {
    if (
      imported.function.parameters.length !== 1 ||
      imported.function.result.kind !== "unit"
    ) {
      throw new TypeError(
        `differential verifier requires one-argument unit import ${imported.capability}.${imported.operation}`,
      );
    }
    const operations = modules[imported.module] ?? {};
    operations[imported.name] = (...arguments_: unknown[]) => {
      effects.push({
        capability: imported.capability,
        operation: imported.operation,
        argument: decodeFlatArgument(
          imported.function.parameters[0],
          arguments_,
          memory(),
        ),
      });
    };
    modules[imported.module] = operations;
  }
  return modules;
}

function oracleImports(
  manifest: BlotAbiManifest,
  effects: EffectObservation[],
) {
  const capabilities: Record<
    string,
    Record<string, (argument: unknown) => { readonly kind: "unit" }>
  > = {};
  for (const imported of manifest.imports) {
    if (
      imported.function.parameters.length !== 1 ||
      imported.function.result.kind !== "unit"
    ) {
      throw new TypeError(
        `differential verifier requires one-argument unit import ${imported.capability}.${imported.operation}`,
      );
    }
    const operations = capabilities[imported.capability] ?? {};
    operations[imported.operation] = (argument) => {
      effects.push({
        capability: imported.capability,
        operation: imported.operation,
        argument: normalizeGpufuckValue(
          imported.function.parameters[0],
          argument,
        ),
      });
      return { kind: "unit" };
    };
    capabilities[imported.capability] = operations;
  }
  return capabilities;
}

function decodeFlatArgument(
  type: BlotAbiType,
  arguments_: readonly unknown[],
  memory: WebAssembly.Memory | undefined,
): BlotCanonicalValue {
  if (type.kind === "unit") return null;
  if (type.kind === "signed-integer-64") return arguments_[0] as bigint;
  if (type.kind === "float-32" || type.kind === "float-64") {
    return arguments_[0] as number;
  }
  if (type.kind === "boolean") return arguments_[0] !== 0;
  if (type.kind === "text") {
    if (
      !(memory instanceof WebAssembly.Memory) ||
      typeof arguments_[0] !== "number" || typeof arguments_[1] !== "number"
    ) {
      throw new TypeError("canonical text import omitted pointer or memory");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(memory.buffer, arguments_[0], arguments_[1]),
    );
  }
  throw new TypeError(
    `differential verifier does not admit flat ${type.kind} host arguments`,
  );
}

function requireEqualEffects(
  sourceName: string,
  target: readonly EffectObservation[],
  oracle: readonly EffectObservation[],
): void {
  if (target.length !== oracle.length) {
    throw new Error(
      `${sourceName} performs ${target.length} gpupaper effects and ${oracle.length} oracle effects`,
    );
  }
  for (const [index, actual] of target.entries()) {
    const expected = oracle[index];
    if (
      actual.capability === expected.capability &&
      actual.operation === expected.operation &&
      equalBlotCanonicalValues(actual.argument, expected.argument)
    ) continue;
    throw new Error(`${sourceName} effect ${index} differs from the oracle`);
  }
}

console.log(JSON.stringify(
  {
    corpus: "../blot/examples/*.blot",
    files: files.length,
    admitted,
    observations,
    rejected: rejected.length,
    rejections: rejected,
  },
  null,
  2,
));
