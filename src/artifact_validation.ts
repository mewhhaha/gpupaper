import type { DucklangManagedAbi } from "./ducklang_abi.ts";
import { ducklangTextLiteralsSectionName } from "./ducklang_core_wasm.ts";
import { ducklangRuntimeImportModule } from "./ducklang_primitives.ts";

export function validateSelectedWasm(
  file: string,
  wasm: Uint8Array,
): WebAssembly.Module {
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(
      new Uint8Array(wasm).buffer as ArrayBuffer,
    );
  } catch (cause) {
    throw new Error(
      `${file}: selected backend emitted invalid WebAssembly: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  const exports = WebAssembly.Module.exports(module);
  if (
    exports.length !== 1 ||
    exports[0].name !== "main" ||
    exports[0].kind !== "function"
  ) {
    throw new TypeError(
      `${file}: selected WebAssembly must export exactly function main; received ${
        exports.map((descriptor) => `${descriptor.kind} ${descriptor.name}`)
          .join(", ") || "no exports"
      }`,
    );
  }
  for (const descriptor of WebAssembly.Module.imports(module)) {
    if (descriptor.kind === "function") continue;
    throw new TypeError(
      `${file}: selected WebAssembly imports ${descriptor.kind} ${descriptor.module}.${descriptor.name}; only function imports are admitted`,
    );
  }
  return module;
}

export function validateDucklangManagedArtifact(
  file: string,
  module: WebAssembly.Module,
  abi: DucklangManagedAbi,
): void {
  requireUniqueNames(
    file,
    "ABI layout",
    abi.layouts.map((layout) => layout.name),
  );
  requireUniqueNames(
    file,
    "ABI effect",
    abi.effects.map((effect) => effect.name),
  );
  requireUniqueNames(
    file,
    "ABI export",
    abi.exports.map((export_) => export_.name),
  );

  const operations = new Set<string>();
  for (const effect of abi.effects) {
    requireUniqueNames(
      file,
      `ABI effect ${effect.name} operation`,
      effect.operations.map((operation) => operation.name),
    );
    for (const operation of effect.operations) {
      operations.add(`${effect.name}.${operation.name}`);
    }
  }
  for (const field of abi.init) {
    if (abi.effects.some((effect) => effect.name === field.effectName)) {
      continue;
    }
    throw new TypeError(
      `${file}: ABI init field ${field.fieldName} references undeclared effect ${field.effectName}`,
    );
  }

  const requiredOperations = [
    ...abi.requirements.module,
    ...Object.values(abi.requirements.functions).flat(),
  ];
  for (const requirement of requiredOperations) {
    const key = `${requirement.effectName}.${requirement.operationName}`;
    if (operations.has(key)) continue;
    throw new TypeError(
      `${file}: ABI requires undeclared effect operation ${key}`,
    );
  }

  const expectedHostImports = new Set(
    requiredOperations.map((requirement) =>
      `${lowerInitial(requirement.effectName)}.${requirement.operationName}`
    ),
  );
  const actualHostImports = new Set(
    WebAssembly.Module.imports(module)
      .filter((descriptor) => descriptor.module !== ducklangRuntimeImportModule)
      .map((descriptor) => `${descriptor.module}.${descriptor.name}`),
  );
  requireEqualSets(
    file,
    "managed host imports",
    expectedHostImports,
    actualHostImports,
  );

  const sections = WebAssembly.Module.customSections(
    module,
    ducklangTextLiteralsSectionName,
  );
  if (sections.length > 1) {
    throw new TypeError(
      `${file}: selected WebAssembly contains ${sections.length} Ducklang text literal sections`,
    );
  }
  const textLiterals = sections.length === 0
    ? []
    : parseDucklangTextLiterals(file, sections[0]);
  if (JSON.stringify(textLiterals) !== JSON.stringify(abi.textLiterals)) {
    throw new TypeError(
      `${file}: Ducklang text literal metadata disagrees with the managed ABI`,
    );
  }
}

export function parseDucklangTextLiterals(
  subject: string,
  section: ArrayBuffer,
): readonly string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(section));
  } catch (cause) {
    throw new TypeError(`${subject}: malformed Ducklang text literals`, {
      cause,
    });
  }
  if (
    !Array.isArray(decoded) ||
    !decoded.every((value) => typeof value === "string")
  ) {
    throw new TypeError(
      `${subject}: Ducklang text literal section must contain a string array`,
    );
  }
  return decoded;
}

function requireUniqueNames(
  file: string,
  subject: string,
  names: readonly string[],
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      continue;
    }
    throw new TypeError(`${file}: ${subject} ${name} is repeated`);
  }
}

function requireEqualSets(
  file: string,
  subject: string,
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
): void {
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new TypeError(
    `${file}: ${subject} disagree; missing ${
      missing.join(", ") || "none"
    }; unexpected ${unexpected.join(", ") || "none"}`,
  );
}

function lowerInitial(value: string): string {
  return value.length === 0 ? value : value[0].toLowerCase() + value.slice(1);
}
