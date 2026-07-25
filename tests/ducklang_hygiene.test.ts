import {
  hygienicDucklangName,
  renameDucklangValues,
} from "../src/ducklang_hygiene.ts";
import { parseDucklangModule } from "../src/ducklang_parser.ts";

/**
 * The renamer must rewrite exactly the references that resolve to a renamed
 * module-level binding. Every case below is a place where an inner binder
 * introduces its own `secret`, so the reference inside it must survive untouched;
 * getting one of these wrong silently redirects a reference to the wrong value.
 */

Deno.test("Ducklang renaming rewrites an unshadowed module reference", async () => {
  const renamed = await rename(
    "const secret = 1\nlet read = () => secret\n0\n",
  );

  assertEquals(renamed.includes("secret$"), true);
  assertEquals(bareSecretReferences(renamed), 0);
});

Deno.test("Ducklang renaming respects a function parameter binder", async () => {
  const renamed = await rename(
    "const secret = 1\nlet read = secret => secret + 1\n0\n",
  );

  // The parameter shadows the module binding, so the body must keep bare
  // `secret` while the module binding itself is renamed.
  assertEquals(bareSecretReferences(renamed), 1);
});

Deno.test("Ducklang renaming respects a block-local binder", async () => {
  const renamed = await rename(
    "const secret = 1\nlet read = () => {\n  let secret = 2\n  secret + 1\n}\n0\n",
  );

  assertEquals(bareSecretReferences(renamed), 1);
});

Deno.test("Ducklang renaming rewrites a reference before a later inner binder", async () => {
  const renamed = await rename(
    "const secret = 1\nlet read = () => {\n  let first = secret\n  let secret = 2\n  first + secret\n}\n0\n",
  );

  // `let first = secret` precedes the inner binding, so it still refers to the
  // module binding and must be renamed; the trailing `secret` must not be.
  assertEquals(bareSecretReferences(renamed), 1);
  assertEquals(renamed.includes("secret$"), true);
});

Deno.test("Ducklang renaming respects a collection loop binder", async () => {
  const renamed = await rename(
    "const secret = 1\nlet read = items => {\n  let total = 0\n  for secret in items {\n    total = total + secret\n  }\n  total\n}\n0\n",
  );

  assertEquals(bareSecretReferences(renamed), 1);
});

Deno.test("Ducklang renaming rewrites a recursive self reference", async () => {
  const renamed = await rename(
    "let secret = value => if value == 0 { 0 } else { secret(value - 1) }\n0\n",
  );

  assertEquals(renamed.includes("secret$"), true);
  assertEquals(bareSecretReferences(renamed), 0);
});

Deno.test("Ducklang renaming leaves an unrelated program identical", async () => {
  const module = await parseDucklangModule(
    "unrelated.duck",
    "const other = 1\nother\n",
  );
  const statements = renameDucklangValues(
    module.statements,
    new Map([["secret", "secret$deadbeef"]]),
  );

  assertEquals(JSON.stringify(statements), JSON.stringify(module.statements));
});

Deno.test("Ducklang hygienic names are stable and source-derived", () => {
  assertEquals(
    hygienicDucklangName("secret", "/a/dependency.duck"),
    hygienicDucklangName("secret", "/a/dependency.duck"),
  );
  assertEquals(
    hygienicDucklangName("secret", "/a/dependency.duck") ===
      hygienicDucklangName("secret", "/b/dependency.duck"),
    false,
  );
  assertEquals(
    /^secret\$[0-9a-f]{8}$/.test(
      hygienicDucklangName("secret", "/a/dependency.duck"),
    ),
    true,
  );
});

async function rename(source: string): Promise<string> {
  const module = await parseDucklangModule("hygiene.duck", source);
  const statements = renameDucklangValues(
    module.statements,
    new Map([["secret", "secret$deadbeef"]]),
  );
  return JSON.stringify(statements);
}

/** Counts `reference` nodes still naming a bare `secret`. */
function bareSecretReferences(serialized: string): number {
  const parsed = JSON.parse(serialized);
  let count = 0;
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    const node = current as Record<string, unknown>;
    const name = node.name as Record<string, unknown> | undefined;
    if (node.kind === "reference" && name?.text === "secret") count += 1;
    pending.push(...Object.values(node));
  }
  return count;
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
