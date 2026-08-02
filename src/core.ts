export type {
  CoreBlockId,
  CoreFunctionId,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
  DucklangCoreBlock as CoreBlock,
  DucklangCoreFunction as CoreFunction,
  DucklangCoreModule as CoreModule,
  DucklangCoreOperation as CoreOperation,
  DucklangCoreScalar as CoreScalar,
  DucklangCoreSignature as CoreSignature,
  DucklangCoreTerminator as CoreTerminator,
  DucklangCoreType as CoreType,
  DucklangCoreVectorElement as CoreVectorElement,
} from "./ducklang_core.ts";

export { validateDucklangCore as validateCore } from "./ducklang_core.ts";
