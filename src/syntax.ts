export type SourceSpan = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
};

export type Name = {
  readonly text: string;
  readonly scopes: readonly number[];
  readonly span: SourceSpan;
};

export type Expression =
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "boolean";
    readonly value: boolean;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "variable";
    readonly name: Name;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "lambda";
    readonly parameter: Name;
    readonly body: Expression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "apply";
    readonly callee: Expression;
    readonly argument: Expression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "let";
    readonly name: Name;
    readonly value: Expression;
    readonly body: Expression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: Expression;
    readonly thenBranch: Expression;
    readonly elseBranch: Expression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: "+" | "-" | "*" | "==";
    readonly left: Expression;
    readonly right: Expression;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "comptime";
    readonly expression: Expression;
    readonly backend: "bytecode" | "interaction";
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "case";
    readonly scrutinee: Expression;
    readonly alternatives: readonly CaseAlternative[];
    readonly span: SourceSpan;
  };

export type Pattern =
  | {
    readonly kind: "constructor";
    readonly name: Name;
    readonly fields: readonly Name[];
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "integer";
    readonly value: number;
    readonly span: SourceSpan;
  }
  | { readonly kind: "wildcard"; readonly span: SourceSpan };

export type CaseAlternative = {
  readonly pattern: Pattern;
  readonly expression: Expression;
  readonly span: SourceSpan;
};

export type TypeSyntax =
  | { readonly kind: "name"; readonly name: string; readonly span: SourceSpan }
  | {
    readonly kind: "apply";
    readonly constructor: TypeSyntax;
    readonly argument: TypeSyntax;
    readonly span: SourceSpan;
  }
  | {
    readonly kind: "function";
    readonly parameter: TypeSyntax;
    readonly result: TypeSyntax;
    readonly span: SourceSpan;
  };

export type PredicateSyntax = {
  readonly className: string;
  readonly argument: TypeSyntax;
  readonly span: SourceSpan;
};

export type TypeSignature = {
  readonly predicates: readonly PredicateSyntax[];
  readonly type: TypeSyntax;
  readonly span: SourceSpan;
};

export type ValueDeclaration = {
  readonly kind: "value";
  readonly name: Name;
  readonly parameters: readonly Name[];
  readonly expression: Expression;
  readonly signature?: TypeSignature;
  readonly generatedBy?: SourceSpan;
  readonly span: SourceSpan;
};

export type ConstructorDeclaration = {
  readonly name: Name;
  readonly fields: readonly TypeSyntax[];
  readonly span: SourceSpan;
};

export type DataDeclaration = {
  readonly kind: "datatype";
  readonly name: Name;
  readonly parameters: readonly string[];
  readonly constructors: readonly ConstructorDeclaration[];
  readonly span: SourceSpan;
};

export type ClassDeclaration = {
  readonly kind: "class";
  readonly name: Name;
  readonly parameter: string;
  readonly methodName: Name;
  readonly methodType: TypeSignature;
  readonly span: SourceSpan;
};

export type InstanceDeclaration = {
  readonly kind: "instance";
  readonly className: Name;
  readonly type: TypeSyntax;
  readonly primitive: "integerEquality";
  readonly span: SourceSpan;
};

export type MacroDeclaration = {
  readonly kind: "macro";
  readonly name: Name;
  readonly operation: "identity" | "constant";
  readonly span: SourceSpan;
};

export type MacroInvocation = {
  readonly kind: "macroInvocation";
  readonly name: Name;
  readonly arguments: readonly (Name | number)[];
  readonly span: SourceSpan;
};

export type Declaration =
  | ValueDeclaration
  | DataDeclaration
  | ClassDeclaration
  | InstanceDeclaration
  | MacroDeclaration
  | MacroInvocation;

export type Module = {
  readonly file: string;
  readonly declarations: readonly Declaration[];
};

export function spanFrom(left: SourceSpan, right: SourceSpan): SourceSpan {
  return { file: left.file, start: left.start, end: right.end };
}

export function unscopedName(text: string, span: SourceSpan): Name {
  return { text, scopes: [0], span };
}
