import {
  validateDucklangManagedArtifact,
  validateSelectedWasm,
} from "../src/artifact_validation.ts";
import { compileModuleSource } from "../src/compiler.ts";

Deno.test("selected Wasm validation rejects bytes before artifact return", () => {
  assertThrows(
    () => validateSelectedWasm("broken.duck", new Uint8Array([0, 1, 2])),
    /broken\.duck: selected backend emitted invalid WebAssembly/,
  );
});

Deno.test("managed artifact validation detects a missing host import", async () => {
  const artifact = await compileModuleSource("valid.duck", "42\n", {
    gpuMode: "off",
  });
  const module = validateSelectedWasm("valid.duck", artifact.wasm);
  const abi = {
    ...artifact.abi,
    effects: [{
      name: "Clock",
      operations: [{
        name: "tick",
        parameters: [],
        result: "i32" as const,
      }],
    }],
    requirements: {
      ...artifact.abi.requirements,
      module: [{ effectName: "Clock", operationName: "tick" }],
    },
  };

  assertThrows(
    () => validateDucklangManagedArtifact("valid.duck", module, abi),
    /managed host imports disagree; missing clock\.tick/,
  );
});

Deno.test("managed artifact validation detects text metadata disagreement", async () => {
  const artifact = await compileModuleSource("valid.duck", "42\n", {
    gpuMode: "off",
  });
  const module = validateSelectedWasm("valid.duck", artifact.wasm);

  assertThrows(
    () =>
      validateDucklangManagedArtifact("valid.duck", module, {
        ...artifact.abi,
        textLiterals: ["missing from Wasm"],
      }),
    /text literal metadata disagrees/,
  );
});

function assertThrows(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return;
    throw new Error(`expected ${pattern}; received ${message}`);
  }
  throw new Error(`expected ${pattern}; action completed`);
}
