export type DucklangExpectedValue =
  | { readonly type: "i32"; readonly value: number }
  | { readonly type: "i64"; readonly value: string };

export type DucklangCorpusRun = {
  readonly name?: string;
  readonly expected: DucklangExpectedValue;
  readonly inputs?: unknown;
};

export type DucklangSuccessContract = {
  readonly path: string;
  readonly route: "ic" | "core" | "managed";
  readonly runs: readonly DucklangCorpusRun[];
};

export type DucklangCompileFailureContract = {
  readonly path: string;
  readonly route: "ic" | "core" | "managed";
  readonly message: string;
};

export type DucklangTrapContract = {
  readonly path: string;
  readonly route: "core" | "managed";
  readonly inputs?: unknown;
};

export type DucklangCorpusContract = {
  readonly version: 1;
  readonly success: readonly DucklangSuccessContract[];
  readonly compileFailures: readonly DucklangCompileFailureContract[];
  readonly traps: readonly DucklangTrapContract[];
  readonly sourceTests: readonly string[];
  readonly dependencies: readonly string[];
};

export function parseDucklangCorpusContract(
  source: string,
): DucklangCorpusContract {
  const parsed: unknown = JSON.parse(source);
  const contract = expectRecord(parsed, "Ducklang corpus contract");
  if (contract.version !== 1) {
    throw new TypeError(
      `Ducklang corpus contract version must be 1; received ${
        JSON.stringify(contract.version)
      }`,
    );
  }

  return {
    version: 1,
    success: expectArray(contract.success, "success").map(parseSuccess),
    compileFailures: expectArray(
      contract.compileFailures,
      "compileFailures",
    ).map(parseCompileFailure),
    traps: expectArray(contract.traps, "traps").map(parseTrap),
    sourceTests: expectArray(contract.sourceTests, "sourceTests").map(
      (path, index) => expectString(path, `sourceTests[${index}]`),
    ),
    dependencies: expectArray(contract.dependencies, "dependencies").map(
      (path, index) => expectString(path, `dependencies[${index}]`),
    ),
  };
}

function parseSuccess(value: unknown, index: number): DucklangSuccessContract {
  const subject = `success[${index}]`;
  const success = expectRecord(value, subject);
  return {
    path: expectString(success.path, `${subject}.path`),
    route: expectRoute(success.route, `${subject}.route`),
    runs: expectArray(success.runs, `${subject}.runs`).map((run, runIndex) =>
      parseRun(run, `${subject}.runs[${runIndex}]`)
    ),
  };
}

function parseRun(value: unknown, subject: string): DucklangCorpusRun {
  const run = expectRecord(value, subject);
  return {
    ...(run.name === undefined
      ? {}
      : { name: expectString(run.name, `${subject}.name`) }),
    expected: parseExpected(run.expected, `${subject}.expected`),
    ...(run.inputs === undefined ? {} : { inputs: run.inputs }),
  };
}

function parseExpected(
  value: unknown,
  subject: string,
): DucklangExpectedValue {
  const expected = expectRecord(value, subject);
  if (expected.type === "i32") {
    if (!Number.isSafeInteger(expected.value)) {
      throw new TypeError(
        `${subject}.value must be a safe integer; received ${
          JSON.stringify(expected.value)
        }`,
      );
    }
    return { type: "i32", value: expected.value as number };
  }
  if (expected.type === "i64") {
    const integer = expectString(expected.value, `${subject}.value`);
    if (!/^-?[0-9]+$/.test(integer)) {
      throw new TypeError(
        `${subject}.value must be a decimal integer; received ${
          JSON.stringify(integer)
        }`,
      );
    }
    return { type: "i64", value: integer };
  }
  throw new TypeError(
    `${subject}.type must be "i32" or "i64"; received ${
      JSON.stringify(expected.type)
    }`,
  );
}

function parseCompileFailure(
  value: unknown,
  index: number,
): DucklangCompileFailureContract {
  const subject = `compileFailures[${index}]`;
  const failure = expectRecord(value, subject);
  return {
    path: expectString(failure.path, `${subject}.path`),
    route: expectRoute(failure.route, `${subject}.route`),
    message: expectString(failure.message, `${subject}.message`),
  };
}

function parseTrap(value: unknown, index: number): DucklangTrapContract {
  const subject = `traps[${index}]`;
  const trap = expectRecord(value, subject);
  const route = expectString(trap.route, `${subject}.route`);
  if (route !== "core" && route !== "managed") {
    throw new TypeError(
      `${subject}.route must be "core" or "managed"; received ${
        JSON.stringify(route)
      }`,
    );
  }
  return {
    path: expectString(trap.path, `${subject}.path`),
    route,
    ...(trap.inputs === undefined ? {} : { inputs: trap.inputs }),
  };
}

function expectRoute(
  value: unknown,
  subject: string,
): "ic" | "core" | "managed" {
  if (value === "ic" || value === "core" || value === "managed") {
    return value;
  }
  throw new TypeError(
    `${subject} must be "ic", "core", or "managed"; received ${
      JSON.stringify(value)
    }`,
  );
}

function expectRecord(
  value: unknown,
  subject: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${subject} must be an array`);
  }
  return value;
}

function expectString(value: unknown, subject: string): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `${subject} must be a string; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}
