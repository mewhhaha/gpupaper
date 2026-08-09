import type {
  CoreBlockId,
  CoreFunctionId,
  CoreModule,
  CoreSignatureId,
  CoreTypeId,
  CoreValueId,
} from "../src/core.ts";
import { validateCore } from "../src/core.ts";
import { planCoreLayouts } from "../src/core_layout.ts";

const i64 = 0 as CoreTypeId;
const unit = 1 as CoreTypeId;
const list = 2 as CoreTypeId;
const cons = 3 as CoreTypeId;
const indirectList = 4 as CoreTypeId;
const signature = 0 as CoreSignatureId;
const main = 0 as CoreFunctionId;
const entry = 0 as CoreBlockId;
const value = 0 as CoreValueId;
const boxed = 1 as CoreValueId;
const loaded = 2 as CoreValueId;
const result = 3 as CoreValueId;
const span = { file: "recursive-indirection.core", start: 0, end: 1 };

Deno.test("recursive managed indirection is a one-field Core product", () => {
  // A frontend-private immutable indirection needs no new Core primitive:
  //   indirect<T>   = product(T)
  //   indirect.make = product.make
  //   indirect.load = product.project 0
  //
  // List -> Cons -> indirect List closes the recursive type graph. Layout
  // planning deliberately represents every recursive node as a managed handle.
  const module: CoreModule = {
    schemaVersion: 1,
    file: span.file,
    types: [
      { kind: "scalar", scalar: "i64" },
      { kind: "scalar", scalar: "unit" },
      { kind: "sum", cases: [unit, cons] },
      { kind: "product", fields: [i64, indirectList] },
      { kind: "product", fields: [list] },
    ],
    signatures: [{ parameters: [list], result: list }],
    functions: [{
      id: main,
      name: "round_trip_indirection",
      sourceIdentity: undefined,
      signature,
      entryBlock: entry,
      blocks: [{
        id: entry,
        parameters: [{ value, type: list, span }],
        operations: [{
          kind: "product.make",
          result: boxed,
          type: indirectList,
          operands: [value],
          span,
        }, {
          kind: "product.project",
          result: loaded,
          type: list,
          operands: [boxed],
          index: 0,
          span,
        }, {
          kind: "sum.tag",
          result,
          type: i64,
          operands: [loaded],
          span,
        }],
        terminator: { kind: "return", values: [loaded], span },
      }],
      span,
    }],
    entryFunction: main,
  };

  validateCore(module);
  const plan = planCoreLayouts(module);
  for (const type of [list, cons, indirectList]) {
    const layout = plan.layouts[plan.typeLayouts[type]];
    if (layout.kind !== "handle") {
      throw new Error(`recursive type ${type} received ${layout.kind}; expected handle`);
    }
    if (layout.size !== 4 || layout.alignment !== 4) {
      throw new Error(
        `recursive type ${type} received ${layout.size}/${layout.alignment}; expected 4/4`,
      );
    }
  }
});
