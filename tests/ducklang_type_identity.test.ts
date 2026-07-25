import type { DucklangModule, DucklangStatement } from "../src/ducklang_ast.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";
import {
  isQualifiedDucklangTypeName,
  qualifyDucklangTypeCollisions,
} from "../src/ducklang_type_identity.ts";

Deno.test("Ducklang type qualification leaves an uncontested program untouched", async () => {
  const module = await parseDucklangModule(
    "solo.duck",
    "type Point = struct { .a = Int, .b = Int }\n\nlet p: Point = [1, 2]\np.a\n",
  );
  const qualified = qualifyDucklangTypeCollisions(module);

  assertEquals(qualified.sourceNames.size, 0);
  assertEquals(typeNames(qualified.module), ["Point"]);
  // The very same object is returned, so no downstream pass can observe a
  // rewrite for a program that has no collision.
  assertEquals(qualified.module === module, true);
});

Deno.test("Ducklang type qualification separates same-named declarations per file", () => {
  const module = twoFileModule();
  const qualified = qualifyDucklangTypeCollisions(module);
  const names = typeNames(qualified.module);

  assertEquals(names.length, 2);
  assertEquals(names.every(isQualifiedDucklangTypeName), true);
  assertEquals(new Set(names).size, 2);
  for (const name of names) {
    assertEquals(qualified.sourceNames.get(name), "Point");
  }

  // Each file's annotation must follow the declaration that file made.
  const declarations = new Map(
    qualified.module.statements.flatMap((statement) =>
      statement.kind === "structType"
        ? [[statement.span.file, statement.name] as const]
        : []
    ),
  );
  const annotations = new Map(
    qualified.module.statements.flatMap((statement) =>
      statement.kind === "binding" && statement.name.declaredType !== undefined
        ? [[statement.span.file, statement.name.declaredType] as const]
        : []
    ),
  );
  assertEquals(annotations.size, 2);
  for (const [file, annotation] of annotations) {
    assertEquals(annotation, declarations.get(file));
  }
});

Deno.test("Ducklang type qualification is independent of declaration order", () => {
  const forward = qualifyDucklangTypeCollisions(twoFileModule());
  const reversed = qualifyDucklangTypeCollisions({
    ...twoFileModule(),
    statements: [...twoFileModule().statements].reverse(),
  });

  assertEquals(
    typeNames(forward.module).sort(),
    typeNames(reversed.module).sort(),
  );
});

Deno.test("Ducklang type qualification rejects a name used as both type and value", async () => {
  const dependency = await parseDucklangModule(
    "dependency.duck",
    "type Shape = struct { .a = Int }\n0\n",
  );
  const root = await parseDucklangModule(
    "root.duck",
    "type Shape = struct { .b = Int }\nconst Shape = 1\nShape\n",
  );
  const module: DucklangModule = {
    ...root,
    statements: [...dependency.statements, ...root.statements],
  };

  try {
    qualifyDucklangTypeCollisions(module);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Ducklang type Shape is declared in 2 files/.test(message)) {
      throw new Error(`unexpected diagnostic ${JSON.stringify(message)}`);
    }
    if (!/also used as a value name/.test(message)) {
      throw new Error(`diagnostic omits the cause: ${message}`);
    }
    return;
  }
  throw new Error("expected an ambiguous type-and-value diagnostic");
});

function twoFileModule(): DucklangModule {
  // Two independently authored modules that each declare their own `Point` with
  // the fields in opposite order, as the linker would splice them.
  const point = (file: string, fields: string): DucklangStatement => ({
    kind: "structType",
    name: "Point",
    parameters: [],
    fields: fields.split(",").map((name, index) => ({
      name: name.trim(),
      type: { name: "Int", arguments: [], span: span(file, index) },
      span: span(file, index),
    })),
    span: span(file, 0),
  });
  const annotated = (file: string): DucklangStatement => ({
    kind: "binding",
    declarationKind: "let",
    recursive: false,
    name: { text: "p", declaredType: "Point", span: span(file, 10) },
    value: {
      kind: "product",
      productKind: "tuple",
      values: [
        { kind: "integer", value: 1, span: span(file, 11) },
        { kind: "integer", value: 2, span: span(file, 12) },
      ],
      span: span(file, 11),
    },
    span: span(file, 10),
  });
  return {
    file: "root.duck",
    exportNames: [],
    parameters: [],
    protocols: [],
    extensions: [],
    fixities: [],
    statements: [
      point("dependency.duck", "a,b"),
      annotated("dependency.duck"),
      point("root.duck", "b,a"),
      annotated("root.duck"),
    ],
    span: span("root.duck", 0),
  };
}

function span(file: string, start: number) {
  return { file, start, end: start + 1 };
}

function typeNames(module: DucklangModule): string[] {
  return module.statements.flatMap((statement) =>
    statement.kind === "structType" ? [statement.name] : []
  );
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}
