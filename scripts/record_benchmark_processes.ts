import { requireBenchmarkRecord } from "./benchmark_schema.ts";

const task = requireRequestedValue(Deno.args, "--task");
const processCount = requestedPositiveInteger(Deno.args, "--processes", 3);
const maximumAttempts = requestedPositiveInteger(
  Deno.args,
  "--max-attempts",
  3,
);
const output = requestedValue(Deno.args, "--output");
const benchmarkArguments = Deno.args.filter((argument) =>
  argument === "--allow-contended" || argument.startsWith("--samples=")
);
const supportedTasks = new Set([
  "benchmark:frontend",
  "benchmark:rebuild",
  "benchmark:break-even",
  "benchmark:wasm",
  "benchmark:branch-hints",
  "benchmark:simd",
  "benchmark:zero",
  "benchmark:peers",
  "benchmark:blot-targets",
  "benchmark:blot-batch",
  "benchmark:blot-crossover",
]);
if (!supportedTasks.has(task)) {
  throw new TypeError(
    `--task must name a supported benchmark task; received ${
      JSON.stringify(task)
    }`,
  );
}

const processes = [];
for (let process = 0; process < processCount; process += 1) {
  const refusedAttempts = [];
  let completed: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const child = await runBenchmark(task, benchmarkArguments);
    if (child.success) {
      completed = parseBenchmarkOutput(task, child.stdout);
      break;
    }
    if (child.code !== 2) {
      throw new Error(
        `${task} process ${process} exited ${child.code}: ${
          child.stderr || child.stdout
        }`,
      );
    }
    refusedAttempts.push({ attempt, result: JSON.parse(child.stdout) });
    if (attempt < maximumAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  if (completed === undefined) {
    throw new Error(
      `${task} process ${process} was refused ${maximumAttempts} times`,
    );
  }
  requireBenchmarkRecord(completed);
  processes.push({ process, refusedAttempts, result: completed });
}

function parseBenchmarkOutput(task: string, stdout: string): unknown {
  if (task !== "benchmark:rebuild") return JSON.parse(stdout);
  const records = stdout.split("\n").map((line) => JSON.parse(line));
  const start = records[0];
  const end = records.at(-1);
  if (
    start?.recordType !== "benchmarkStart" ||
    end?.recordType !== "benchmarkEnd"
  ) {
    throw new Error("rebuild benchmark omitted its start/end protocol records");
  }
  return {
    ...start,
    ...end,
    recordType: "benchmarkRun",
    measurements: records.slice(1, -1),
  };
}

const record = {
  schemaVersion: 1,
  task,
  processCount,
  maximumAttempts,
  processOrder: "sequentialFreshDenoProcesses",
  benchmarkArguments,
  processes,
};
const encoded = `${JSON.stringify(record, null, 2)}\n`;
if (output === undefined) {
  await Deno.stdout.write(new TextEncoder().encode(encoded));
} else {
  if (!output.startsWith("measurements/") || !output.endsWith(".json")) {
    throw new TypeError(
      `--output must be a measurements/*.json path; received ${
        JSON.stringify(output)
      }`,
    );
  }
  await Deno.mkdir("measurements", { recursive: true });
  await Deno.writeTextFile(output, encoded);
}

function requestedValue(
  arguments_: readonly string[],
  name: string,
): string | undefined {
  return arguments_.find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function requireRequestedValue(
  arguments_: readonly string[],
  name: string,
): string {
  const value = requestedValue(arguments_, name);
  if (value !== undefined && value.length > 0) return value;
  throw new TypeError(`${name} is required`);
}

function requestedPositiveInteger(
  arguments_: readonly string[],
  name: string,
  defaultValue: number,
): number {
  const text = requestedValue(arguments_, name);
  if (text === undefined) return defaultValue;
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer; received ${text}`);
  }
  return value;
}

async function runBenchmark(
  task: string,
  benchmarkArguments: readonly string[],
): Promise<{
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", task, ...benchmarkArguments],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}
