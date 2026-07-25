import {
  type FlatFcgRewriteProposal,
  resolveFlatFcgRewriteConflicts,
  rewriteFlatFcg,
} from "../src/fcg_rewrite.ts";
import { flattenFcgModule, inflateFlatFcgPackage } from "../src/flat_fcg.ts";

Deno.test("flat FCG rewrites remove straight-line arithmetic identities", () => {
  const snapshot = flattenFcgModule({
    functions: [{
      name: "main",
      parameters: [],
      localCount: 4,
      operations: [
        { opcode: "local.get", operands: [0], sourceStart: 0, regionId: 0 },
        { opcode: "const", operands: [0], sourceStart: 1, regionId: 0 },
        { opcode: "i32.+", operands: [], sourceStart: 2, regionId: 0 },
        { opcode: "const", operands: [1], sourceStart: 3, regionId: 0 },
        { opcode: "i32.*", operands: [], sourceStart: 4, regionId: 0 },
        { opcode: "local.get", operands: [3], sourceStart: 5, regionId: 0 },
        { opcode: "local.set", operands: [3], sourceStart: 6, regionId: 0 },
      ],
    }],
    constructorTags: new Map(),
  });

  const rewritten = rewriteFlatFcg(snapshot);

  assertEquals(
    rewritten.accepted.map((proposal) => proposal.rule),
    ["addZero", "multiplyOne", "selfLocalAssignment"],
  );
  assertEquals(
    inflateFlatFcgPackage(rewritten.package).functions[0].operations,
    [{ opcode: "local.get", operands: [0], sourceStart: 0, regionId: 0 }],
  );
});

Deno.test("flat FCG conflict resolution uses profit then stable operation order", () => {
  const snapshot = flattenFcgModule({
    functions: [{
      name: "main",
      parameters: [],
      localCount: 0,
      operations: [
        { opcode: "const", operands: [0], sourceStart: 0, regionId: 0 },
        { opcode: "i32.+", operands: [], sourceStart: 1, regionId: 0 },
        { opcode: "drop", operands: [], sourceStart: 2, regionId: 0 },
      ],
    }],
    constructorTags: new Map(),
  });
  const proposals: FlatFcgRewriteProposal[] = [
    {
      rule: "addZero",
      functionIndex: 0,
      operationStart: 0,
      operationCount: 2,
      profit: 2,
    },
    {
      rule: "selfLocalAssignment",
      functionIndex: 0,
      operationStart: 1,
      operationCount: 2,
      profit: 3,
    },
  ];

  assertEquals(resolveFlatFcgRewriteConflicts(snapshot, proposals), [
    proposals[1],
  ]);
});

Deno.test("flat FCG identity matching does not cross structured control", () => {
  const snapshot = flattenFcgModule({
    functions: [{
      name: "main",
      parameters: [],
      localCount: 0,
      operations: [
        { opcode: "if", operands: [], sourceStart: 0, regionId: 0 },
        { opcode: "const", operands: [0], sourceStart: 1, regionId: 1 },
        { opcode: "i32.+", operands: [], sourceStart: 2, regionId: 2 },
      ],
    }],
    constructorTags: new Map(),
  });

  assertEquals(rewriteFlatFcg(snapshot).accepted, []);
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}; received ${actualJson}`);
  }
}
