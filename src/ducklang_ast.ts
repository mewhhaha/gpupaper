import type { SourceSpan } from "./syntax.ts";

export type DucklangName = {
  readonly text: string;
  readonly declaredType?: string;
  readonly identityPolymorphic?: boolean;
  readonly span: SourceSpan;
};

export type DucklangParameter = DucklangName;

export type DucklangImportSelection = {
  readonly exportName: string;
  readonly localName: DucklangName | undefined;
  readonly span: SourceSpan;
};

export type DucklangTypeReference = {
  readonly name: string;
  readonly arguments: readonly DucklangTypeReference[];
  readonly span: SourceSpan;
};

export type DucklangUnionCase = {
  readonly name: string;
  readonly payloadType: DucklangTypeReference;
  readonly span: SourceSpan;
};

export type DucklangStructField = {
  readonly name: string;
  readonly type: DucklangTypeReference;
  readonly span: SourceSpan;
};

export type DucklangRecordField = {
  readonly name: string;
  readonly value: DucklangExpression;
  readonly span: SourceSpan;
};

export type DucklangEffectOperation = {
  readonly name: string;
  readonly parameterTypes: readonly DucklangTypeReference[];
  readonly resultType: DucklangTypeReference;
  readonly span: SourceSpan;
};

export type DucklangRecursiveBinding = {
  readonly name: DucklangName;
  readonly value: DucklangExpression;
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
    readonly kind: "unit";
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
    readonly kind: "hostCall";
    readonly effectName: string;
    readonly operationName: string;
    readonly arguments: readonly DucklangExpression[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "optionDo";
    readonly option: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionCase";
    readonly caseName: string;
    readonly value: DucklangExpression;
    readonly nominalType?: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "product";
    readonly productKind: "tuple" | "array";
    readonly values: readonly DucklangExpression[];
    readonly nominalType?: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "field";
    readonly product: DucklangExpression;
    readonly fieldName: string;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "recordUpdate";
    readonly product: DucklangExpression;
    readonly fields: readonly DucklangRecordField[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "record";
    readonly fields: readonly DucklangRecordField[];
    readonly nominalType?: string;
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
    readonly kind: "index";
    readonly collection: DucklangExpression;
    readonly index: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "indexUpdate";
    readonly product: DucklangExpression;
    readonly index: DucklangExpression;
    readonly value: DucklangExpression;
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
    readonly kind: "ifUnion";
    readonly caseName: string;
    readonly payloadName: DucklangName | undefined;
    readonly value: DucklangExpression;
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
  }
  | {
    readonly kind: "loop";
    readonly body: DucklangExpression;
    readonly span: SourceSpan;
  };

export type DucklangStatement =
  | {
    readonly kind: "effectDeclaration";
    readonly name: string;
    readonly operations: readonly DucklangEffectOperation[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "recursiveGroup";
    readonly declarationKind: "let" | "const";
    readonly bindings: readonly DucklangRecursiveBinding[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "unionType";
    readonly name: string;
    readonly parameters: readonly string[];
    readonly cases: readonly DucklangUnionCase[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "structType";
    readonly name: string;
    readonly fields: readonly DucklangStructField[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "typeAlias";
    readonly name: string;
    readonly parameters: readonly string[];
    readonly target: DucklangTypeReference;
    readonly span: SourceSpan;
  }
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
    readonly kind: "unionBinding";
    readonly declarationKind: "let" | "const";
    readonly caseName: string;
    readonly name: DucklangName;
    readonly value: DucklangExpression;
    readonly alternative: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "productBinding";
    readonly declarationKind: "let" | "const";
    readonly productKind: "tuple" | "array";
    readonly names: readonly (DucklangName | undefined)[];
    readonly value: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "forRange";
    readonly iterator: DucklangName | undefined;
    readonly start: DucklangExpression;
    readonly end: DucklangExpression;
    readonly step: DucklangExpression | undefined;
    readonly inclusive: boolean;
    readonly body: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "forCollection";
    readonly index: DucklangName | undefined;
    readonly value: DucklangName;
    readonly caseName: string | undefined;
    readonly collection: DucklangExpression;
    readonly body: DucklangExpression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "break";
    readonly value: DucklangExpression | undefined;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "continue";
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
