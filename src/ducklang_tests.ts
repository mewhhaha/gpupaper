import type { DucklangModule, DucklangStatement } from "./ducklang_ast.ts";

export function elaborateDucklangSourceTests(
  module: DucklangModule,
): DucklangModule {
  const sourceTests = module.statements.flatMap((statement) =>
    statement.kind === "binding" && statement.name.sourceTest ? [statement] : []
  );
  if (sourceTests.length === 0) return module;

  for (const test of sourceTests) {
    if (test.value.kind !== "function" || test.value.parameters.length > 0) {
      throw new TypeError(
        `${module.file}:${test.span.start}: Ducklang source test ${test.name.text} must be a function with no parameters`,
      );
    }
  }

  const moduleResult = module.statements.at(-1);
  if (
    moduleResult?.kind !== "expression" ||
    moduleResult.expression.kind !== "record" ||
    moduleResult.expression.fields.length !== 0
  ) {
    throw new TypeError(
      `${module.file}:${module.span.start}: a Ducklang source-test module must return an empty record`,
    );
  }

  const testCalls = sourceTests.map((test): DucklangStatement => ({
    kind: "expression",
    expression: {
      kind: "call",
      callee: {
        kind: "reference",
        name: test.name,
        span: test.name.span,
      },
      arguments: [],
      span: test.name.span,
    },
    span: test.name.span,
  }));
  return {
    ...module,
    statements: [
      ...module.statements.slice(0, -1),
      {
        kind: "expression",
        expression: {
          kind: "block",
          statements: [
            ...testCalls,
            {
              kind: "expression",
              expression: {
                kind: "integer",
                value: 0,
                span: moduleResult.span,
              },
              span: moduleResult.span,
            },
          ],
          span: moduleResult.span,
        },
        span: moduleResult.span,
      },
    ],
  };
}
