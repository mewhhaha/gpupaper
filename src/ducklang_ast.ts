import type { SourceSpan } from "./syntax.ts";

export type DucklangName = {
  readonly text: string;
  readonly declaredType?: "I32" | "I64" | "Bool" | "Text";
  readonly span: SourceSpan;
};

export type DucklangParameter = DucklangName;

export type DucklangImportSelection = {
  readonly exportName: string;
  readonly localName: DucklangName | undefined;
  readonly span: SourceSpan;
};

export type DucklangExpression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "integer64";
    readonly value: bigint;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "boolean";
    readonly value: boolean;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "string";
    readonly value: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "moduleImport";
    readonly path: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "reference";
    readonly name: DucklangName;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "function";
    readonly recursive: boolean;
    readonly parameters: readonly DucklangParameter[];
    readonly body: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "recursiveCall";
    readonly arguments: readonly DucklangExpression[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "call";
    readonly callee: DucklangExpression;
    readonly arguments: readonly DucklangExpression[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: string;
    readonly left: DucklangExpression;
    readonly right: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unary";
    readonly operator: string;
    readonly operand: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: DucklangExpression;
    readonly consequence: DucklangExpression;
    readonly alternative: DucklangExpression | undefined;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "block";
    readonly statements: readonly DucklangStatement[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "comptime";
    readonly expression: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "scratch";
    readonly body: DucklangExpression;
    readonly span: SourceSpan;
  };

export type DucklangStatement =
  | {
    readonly kind: "import";
    readonly path: string;
    readonly selections: readonly DucklangImportSelection[];
    readonly namespace: DucklangName | undefined;
    readonly open: boolean;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binding";
    readonly declarationKind: "let" | "const";
    readonly recursive: boolean;
    readonly name: DucklangName;
    readonly value: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "assignment";
    readonly operator: "=" | ":=";
    readonly name: DucklangName;
    readonly value: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "return";
    readonly expression: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "expression";
    readonly expression: DucklangExpression;
    readonly span: SourceSpan;
  };

export type DucklangModule = {
  readonly file: string;
  readonly statements: readonly DucklangStatement[];
  readonly span: SourceSpan;
};
