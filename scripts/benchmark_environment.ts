export type BenchmarkEnvironment = {
  readonly status: "clear" | "contended" | "unknown";
  readonly competingProcesses: readonly {
    readonly pid: number;
    readonly command: string;
  }[];
  readonly gpuProcesses: readonly {
    readonly pid: number;
    readonly command: string;
    readonly memoryMiB: number;
  }[];
  readonly nvidiaDevices: readonly {
    readonly name: string;
    readonly driverVersion: string;
    readonly pciDeviceId: string;
  }[];
  readonly inspectionErrors: readonly string[];
};

export type BenchmarkEnvironmentInspection = {
  readonly gpuWork: "inspect" | "ignore";
};

export async function inspectBenchmarkEnvironment(
  inspection: BenchmarkEnvironmentInspection = { gpuWork: "inspect" },
): Promise<
  BenchmarkEnvironment
> {
  const inspections = await Promise.allSettled([
    inspectCompilerProcesses(),
    inspection.gpuWork === "inspect"
      ? inspectNvidiaComputeProcesses()
      : Promise.resolve([]),
    inspection.gpuWork === "inspect"
      ? inspectNvidiaDevices()
      : Promise.resolve([]),
  ]);
  const inspectionErrors = inspections.flatMap((inspection) =>
    inspection.status === "rejected"
      ? [
        inspection.reason instanceof Error
          ? inspection.reason.message
          : String(inspection.reason),
      ]
      : []
  );
  const competingProcesses = inspections[0].status === "fulfilled"
    ? inspections[0].value
    : [];
  const gpuProcesses = inspections[1].status === "fulfilled"
    ? inspections[1].value
    : [];
  const nvidiaDevices = inspections[2].status === "fulfilled"
    ? inspections[2].value
    : [];
  return {
    status: inspectionErrors.length > 0
      ? "unknown"
      : competingProcesses.length === 0 && gpuProcesses.length === 0
      ? "clear"
      : "contended",
    competingProcesses,
    gpuProcesses,
    nvidiaDevices,
    inspectionErrors,
  };
}

export async function repositoryIdentity(directory: string): Promise<{
  readonly revision: string;
  readonly status: readonly string[];
  readonly trackedDiffSha256: string;
  readonly untrackedFiles: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}> {
  const revision = new TextDecoder().decode(
    await runGit(directory, ["rev-parse", "HEAD"]),
  ).trim();
  const status = new TextDecoder().decode(
    await runGit(directory, ["status", "--short"]),
  ).trim().split("\n").filter((line) => line.length > 0);
  const trackedDiffSha256 = await sha256(
    await runGit(directory, ["diff", "--binary", "HEAD", "--"]),
  );
  const untrackedPaths = new TextDecoder().decode(
    await runGit(directory, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ).split("\0").filter((path) => path.length > 0).sort();
  const untrackedFiles = await Promise.all(
    untrackedPaths.map(async (path) => ({
      path,
      sha256: await sha256(await Deno.readFile(`${directory}/${path}`)),
    })),
  );
  return { revision, status, trackedDiffSha256, untrackedFiles };
}

export function runtimeIdentity(): {
  readonly deno: string;
  readonly v8: string;
  readonly typescript: string;
  readonly os: string;
  readonly architecture: string;
} {
  return {
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    typescript: Deno.version.typescript,
    os: Deno.build.os,
    architecture: Deno.build.arch,
  };
}

async function inspectCompilerProcesses(): Promise<
  readonly { readonly pid: number; readonly command: string }[]
> {
  if (Deno.build.os !== "linux") {
    throw new Error(
      `compiler process inspection is unsupported on ${Deno.build.os}`,
    );
  }
  const output = await new Deno.Command("ps", {
    args: ["-eo", "pid=,ppid=,args="],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `ps process inspection failed: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  const records = new TextDecoder().decode(output.stdout).split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match === null ? [] : [{
        pid: Number.parseInt(match[1], 10),
        parentPid: Number.parseInt(match[2], 10),
        command: match[3],
      }];
    });
  const parentByPid = new Map(
    records.map((record) => [record.pid, record.parentPid]),
  );
  const ancestors = new Set<number>([Deno.pid]);
  let ancestor = parentByPid.get(Deno.pid);
  while (ancestor !== undefined && ancestor > 0 && !ancestors.has(ancestor)) {
    ancestors.add(ancestor);
    ancestor = parentByPid.get(ancestor);
  }
  return records.flatMap(({ pid, command }) => {
    if (ancestors.has(pid)) return [];
    if (!isCompetingCompilerCommand(command)) {
      return [];
    }
    return [{ pid, command }];
  });
}

export function isCompetingCompilerCommand(command: string): boolean {
  const compiler =
    /(?:^|\s)(?:\S*\/)?(?:cargo|rustc|cabal|ghc|clang|gcc|cc|c\+\+)(?:\s|$)/i
      .test(command);
  const runtimeWork = /(?:^|\s)(?:\S*\/)?(?:deno|node)(?:\s|$)/i.test(command);
  return compiler || runtimeWork;
}

async function inspectNvidiaComputeProcesses(): Promise<
  readonly {
    readonly pid: number;
    readonly command: string;
    readonly memoryMiB: number;
  }[]
> {
  const output = await new Deno.Command("nvidia-smi", {
    args: [
      "--query-compute-apps=pid,process_name,used_gpu_memory",
      "--format=csv,noheader,nounits",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `NVIDIA process inspection failed: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim().split("\n").flatMap(
    (line) => {
      if (line.length === 0) return [];
      const [pidText, command, memoryText] = line.split(",").map((field) =>
        field.trim()
      );
      const pid = Number.parseInt(pidText, 10);
      if (pid === Deno.pid) return [];
      return [{
        pid,
        command,
        memoryMiB: Number.parseInt(memoryText, 10),
      }];
    },
  );
}

async function inspectNvidiaDevices(): Promise<
  readonly {
    readonly name: string;
    readonly driverVersion: string;
    readonly pciDeviceId: string;
  }[]
> {
  const output = await new Deno.Command("nvidia-smi", {
    args: [
      "--query-gpu=name,driver_version,pci.device_id",
      "--format=csv,noheader,nounits",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `NVIDIA device inspection failed: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim().split("\n").flatMap(
    (line) => {
      if (line.length === 0) return [];
      const [name, driverVersion, pciDeviceId] = line.split(",").map((field) =>
        field.trim()
      );
      return [{ name, driverVersion, pciDeviceId }];
    },
  );
}

async function runGit(
  directory: string,
  arguments_: readonly string[],
): Promise<Uint8Array> {
  const output = await new Deno.Command("git", {
    args: ["-C", directory, ...arguments_],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `git ${arguments_.join(" ")} failed for ${directory}: ${
        new TextDecoder().decode(output.stderr).trim() || "no diagnostic"
      }`,
    );
  }
  return output.stdout;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
