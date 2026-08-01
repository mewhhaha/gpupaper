import {
  decodeLexerPlanTables,
  type GpuFrontendResult,
  type GpuResidentFrontendOptions,
  type GpuResidentFrontendResult,
  inspectGpuFrontendPlan,
  type WebGpuFrontend,
  type WebGpuFrontendOptions,
  WebGpuRuntime,
  type WebGpuRuntimeCapabilities,
} from "@mewhhaha/baba/runtime/webgpu";

export type BabaGpuSyntaxSetupTimings = {
  readonly runtimeInitializationMilliseconds: number;
  readonly planCompilationMilliseconds: number;
  readonly totalMilliseconds: number;
};

export class BabaGpuSyntaxSession {
  readonly capabilities: WebGpuRuntimeCapabilities;
  readonly setupTimings: BabaGpuSyntaxSetupTimings;

  readonly #runtime: WebGpuRuntime;
  readonly #frontend: WebGpuFrontend;

  private constructor(
    runtime: WebGpuRuntime,
    frontend: WebGpuFrontend,
    setupTimings: BabaGpuSyntaxSetupTimings,
  ) {
    this.#runtime = runtime;
    this.#frontend = frontend;
    this.capabilities = runtime.capabilities;
    this.setupTimings = setupTimings;
  }

  static async create(plan: Uint8Array): Promise<BabaGpuSyntaxSession> {
    const inspection = inspectGpuFrontendPlan(plan);
    if (inspection === null) {
      throw new Error(
        "Baba parser plan is not admitted: production syntax requires a version-3 GPU frontend profile",
      );
    }
    const lexer = decodeLexerPlanTables(plan);
    if (!lexer.guardFree) {
      throw new Error(
        `Baba parser plan is not admitted: GPU token identity has guards (${
          lexer.guardDiagnostics.join(", ")
        })`,
      );
    }

    const setupStart = performance.now();
    const runtimeStart = performance.now();
    const runtime = await WebGpuRuntime.create({
      powerPreference: "high-performance",
    });
    const runtimeInitializationMilliseconds = performance.now() - runtimeStart;
    try {
      const planCompilationStart = performance.now();
      const frontend = await runtime.compileFrontend(plan);
      const planCompilationMilliseconds = performance.now() -
        planCompilationStart;
      return new BabaGpuSyntaxSession(runtime, frontend, {
        runtimeInitializationMilliseconds,
        planCompilationMilliseconds,
        totalMilliseconds: performance.now() - setupStart,
      });
    } catch (error) {
      runtime.dispose();
      throw error;
    }
  }

  parseAndValidate(
    source: string,
    options: WebGpuFrontendOptions = {},
  ): Promise<GpuFrontendResult> {
    return this.#frontend.ingest(source, options);
  }

  submitResidentSyntax(
    source: string | Uint16Array,
    options: GpuResidentFrontendOptions = {},
  ): Promise<GpuResidentFrontendResult> {
    return this.#frontend.ingestResident(source, options);
  }

  get device(): GPUDevice {
    return this.#runtime.device;
  }

  waitForSubmittedWork(): Promise<void> {
    return this.#runtime.device.queue.onSubmittedWorkDone();
  }

  dispose(): void {
    this.#runtime.dispose();
  }
}
