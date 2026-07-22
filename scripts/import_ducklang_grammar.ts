type GrammarExpression =
  | { readonly type: "ALIAS"; readonly content: GrammarExpression }
  | { readonly type: "BLANK" }
  | { readonly type: "CHOICE"; readonly members: readonly GrammarExpression[] }
  | {
    readonly type: "FIELD";
    readonly name: string;
    readonly content: GrammarExpression;
  }
  | { readonly type: "PATTERN"; readonly value: string }
  | { readonly type: "PREC"; readonly content: GrammarExpression }
  | { readonly type: "PREC_DYNAMIC"; readonly content: GrammarExpression }
  | { readonly type: "PREC_LEFT"; readonly content: GrammarExpression }
  | { readonly type: "PREC_RIGHT"; readonly content: GrammarExpression }
  | { readonly type: "REPEAT"; readonly content: GrammarExpression }
  | { readonly type: "REPEAT1"; readonly content: GrammarExpression }
  | { readonly type: "SEQ"; readonly members: readonly GrammarExpression[] }
  | { readonly type: "STRING"; readonly value: string }
  | { readonly type: "SYMBOL"; readonly name: string }
  | { readonly type: "TOKEN"; readonly content: GrammarExpression };

type TreeSitterGrammar = {
  readonly name: string;
  readonly rules: Readonly<Record<string, GrammarExpression>>;
};

const lexicalRules = new Set([
  "grouped_value_alternative_pattern",
  "identifier",
  "constructor_identifier",
  "intrinsic_identifier",
  "operator_symbol",
  "effect_identifier",
  "row_variable",
  "number",
  "string",
  "character",
  "comment",
]);

const attributedStatementRules = new Set([
  "binding_statement",
  "declare_effect_statement",
  "effect_statement",
  "declare_record_statement",
  "type_declaration_statement",
  "duck_declaration_statement",
  "extension_declaration_statement",
  "fixity_declaration_statement",
  "module_binding_statement",
]);

const portableRules: Readonly<Record<string, string>> = {
  _module_statement:
    "attribute_group+ _attributed_module_statement | _attributed_module_statement | _plain_module_statement",
  _statement:
    "attribute_group+ binding_statement | binding_statement | effect_binding_statement | type_pattern_statement | return_statement | for_statement | break_statement | continue_statement | expression_statement",
  type_declaration_statement:
    '"type" (name:identifier) (parameter:identifier)* "=" (definition:(type_sum | struct_type | newtype_type | packed_type | type_reference))',
  _effect_row_expression: "effect_union_expression",
  effect_union_expression:
    'effect_intersection_expression (":|" effect_intersection_expression)*',
  effect_intersection_expression:
    'effect_difference_expression (":&" effect_difference_expression)*',
  effect_difference_expression:
    '_effect_row_primary (":-" _effect_row_primary)*',
  _expression:
    "try_with_expression | arrow_function | recursive_expression | if_expression | loop_expression | binary_expression",
  arrow_function:
    '(parameters:effect_identifier) "=>" (body:_expression) | (parameters:(parameter | parameter_list | const_parameter_list | bracket_parameter_list | number | string | character | boolean | grouped_value_alternative_pattern)) "=>" (body:_expression)',
  recursive_function:
    '"rec" (parameters:(identifier | wildcard | parameter_list | const_parameter_list | bracket_parameter_list)) "=>" (body:_expression)',
  parameter_list: '"(" ((parameter ("," parameter)*)?) ")"',
  binary_expression:
    'is_expression ((operator:(operator_symbol | "=" | ":=")) (right:is_expression))*',
  is_expression: 'as_expression ((operator:"is") (type:type_reference))?',
  as_expression: "unary_expression (as_keyword (type:type_reference))*",
  unary_expression:
    '"!" (operand:boolean) | ((operator:("&" | "freeze" | "comptime" | operator_symbol)) (operand:unary_expression)) | application_expression',
  application_expression:
    "postfix_expression ((_application_space (argument:(postfix_expression | field_block))) | (argument:parenthesized_or_product))*",
  postfix_expression: "_primary_expression _postfix_suffix*",
  _primary_expression:
    'number | string | character | boolean | "loop" | identifier | _aggregate_constructor_identifier | effect_identifier | intrinsic_identifier | atom_expression | import_meta_expression | import_expression | include_expression | named_product | positional_product | union_case | linear_reference | unit_pattern | array_expression | array_repeat_expression | nonempty_field_block | match_expression | scratch_expression | block | parenthesized_expression',
  condition_expression: "condition_binary_expression",
  condition_binary_expression:
    "condition_is_expression ((operator:operator_symbol) (right:condition_is_expression))*",
  condition_is_expression:
    'condition_unary_expression ((operator:"is") (type:type_reference))?',
  condition_unary_expression:
    '"!" (operand:boolean) | ((operator:("&" | "freeze" | "comptime" | "do" | operator_symbol)) (operand:condition_unary_expression)) | condition_call_expression',
  condition_call_expression:
    "condition_parenthesized_expression _condition_postfix_suffix*",
  condition_parenthesized_expression:
    '"(" condition_expression ")" | _condition_primary',
  match_case:
    '"|" (pattern:_single_match_pattern) (_pattern_pipe (pattern:_single_match_pattern))* (("if" (guard:condition_expression))?) "=>" (body:_expression)',
  match_case_block:
    'MATCH_CASE_OPEN match_case_tail ((",")? match_case)* ((",")?) "}"',
  match_expression:
    'MATCH_START match_case_tail ((",")? match_case)* ((",")?) "}" | MATCH (target:condition_call_expression) (cases:match_case_block)',
  _single_binding_pattern:
    "union_pattern | number | string | character | boolean | identifier | linear_binding_pattern | _aggregate_constructor_identifier | wildcard | array_pattern | binding_product_pattern | named_product_pattern | named_shape_pattern",
  parameter:
    '(_const_parameter ((variadic:"...")?) | (linear:"!")?) (name:(identifier | wildcard)) ((":" (type:type_reference))?)',
  positional_product_pattern:
    '"(" (_match_pattern "," (product_rest_pattern | _match_pattern ("," _match_pattern)*)) ")"',
  array_expression:
    '"[" ((array_spread ("," _expression)* | _expression ("," _expression)* (("," array_spread))?))? "]"',
  field_block:
    '"{" ((shape_field | computed_shape_field | field_definition | shorthand_field) ("," (shape_field | computed_shape_field | field_definition | shorthand_field))* ((",")?))? "}"',
  type_pattern:
    '(kind:("struct" | "union")) "{" (type_pattern_field ",")* ((type_pattern_field | open:"..")?) "}"',
  _type_expression: "forall_type | function_type",
  function_type:
    'type_union (("->" (effects:latent_effect_row)? (result:_type_expression)))?',
  type_union: 'type_intersection (":|" type_intersection)*',
  type_intersection: 'type_difference (":&" type_difference)*',
  type_difference: 'type_application (":-" type_application)*',
  _type_application: "type_application",
  type_application:
    "_type_prefix ((_type_application_space (argument:_type_prefix)) | (argument:type_parenthesized))*",
};

const additionalPortableRules: Readonly<Record<string, string>> = {
  recursive_expression:
    '"rec" (operand:(identifier | wildcard | positional_product | const_parameter_list | bracket_parameter_list)) (("=>" (body:_expression))?)',
  _attributed_module_statement:
    "declare_effect_statement | effect_statement | declare_record_statement | type_declaration_statement | duck_declaration_statement | extension_declaration_statement | fixity_declaration_statement | module_binding_statement | binding_statement",
  _plain_module_statement:
    "effect_binding_statement | type_pattern_statement | for_statement | break_statement | continue_statement | expression_statement",
  _effect_row_primary:
    "parenthesized_effect_expression | effect_family_reference | effect_row_variable | effect_operation_reference",
  _postfix_suffix:
    '"." (field:identifier) | "[" (index:_expression) "]" | handler_clause_block',
  _condition_primary:
    'number | string | character | boolean | atom_expression | import_meta_expression | intrinsic_identifier | "loop" | identifier | _aggregate_constructor_identifier | effect_identifier | linear_reference | union_case',
  _condition_postfix_suffix:
    'argument:parenthesized_or_product | "." (field:identifier) | "[" (index:_expression) "]"',
  binding_product_pattern:
    '"(" (_binding_pattern "," (_binding_pattern ("," _binding_pattern)*)) ")"',
  linear_binding_pattern: '"!" (name:identifier)',
  const_parameter_list: "CONST_PARAMETER_LIST",
  match_case_tail:
    '(pattern:_single_match_pattern) (_pattern_pipe (pattern:_single_match_pattern))* (("if" (guard:condition_expression))?) "=>" (body:_expression)',
  nonempty_field_block:
    '"{" (shape_field | computed_shape_field) ("," (shape_field | computed_shape_field | field_definition | shorthand_field))* ((",")?) "}"',
};

const [sourcePath, destinationPath] = Deno.args;
if (sourcePath === undefined || destinationPath === undefined) {
  throw new Error(
    "usage: deno run --allow-read --allow-write scripts/import_ducklang_grammar.ts SOURCE DESTINATION",
  );
}

const source = await Deno.readTextFile(sourcePath);
const grammar = JSON.parse(source) as TreeSitterGrammar;
if (grammar.name !== "duck") {
  throw new Error(
    `grammar ${sourcePath} is named ${
      JSON.stringify(grammar.name)
    }; expected "duck"`,
  );
}

const declarations = [
  "grammar Duck",
  "",
  "// Contextual whitespace replaces Duck's external scanner with portable guards.",
  "skip WHITESPACE = /[ \\t\\r\\n]+/ ;",
  "skip SEMICOLON = /;/ ;",
  "skip comment = /\\/\\/[^\\r\\n]*/ ;",
  "contextual _array_semicolon = /;/ ;",
  "contextual _const_parameter = /const(?=$|[^A-Za-z0-9_])/ ;",
  "contextual _application_space = /[ \\t]+(?=[A-Za-z0-9_\"'(\\[{!#])(?!(as|by|else|if|in|is|where|with)\\b)/ ;",
  "contextual _type_application_space = /[ \\t]+(?=[A-Za-z_#&]|\\(|\\[)/ ;",
  "contextual _break_value_space = /[ \\t]+(?=[^\\r\\n;}])/ ;",
  "contextual _break_terminator_space = /[ \\t]+(?=$|[\\r\\n;}])/ ;",
  "contextual _extension_member_terminator = /[\\r\\n][ \\t]*/ ;",
  "",
  "token CONST priority 10 = /const/ ;",
  "token CONST_PARAMETER_LIST priority 30 = /\\([^()\\r\\n]*const[^()\\r\\n]*\\)/ ;",
  "token MATCH priority 10 = /match/ ;",
  "token MATCH_CASE_OPEN priority 20 = /[ \\t]*\\{[ \\t\\r\\n]*\\|/ ;",
  "token MATCH_START priority 30 = /match[ \\t]+[A-Za-z][A-Za-z0-9_]*[ \\t]*\\{[ \\t\\r\\n]*\\|/ ;",
];

for (const [name, expression] of Object.entries(grammar.rules)) {
  if (!lexicalRules.has(name) || name === "comment") continue;
  declarations.push(renderToken(name, expression));
}

declarations.push("");
for (const [name, expression] of Object.entries(grammar.rules)) {
  if (lexicalRules.has(name)) continue;
  const portableRule = portableRules[name];
  if (portableRule !== undefined) {
    declarations.push(`${name} = ${portableRule} ;`);
    continue;
  }
  const portableExpression = attributedStatementRules.has(name)
    ? withoutLeadingAttributeGroups(name, expression)
    : expression;
  declarations.push(`${name} = ${renderExpression(portableExpression)} ;`);
}
for (const [name, expression] of Object.entries(additionalPortableRules)) {
  declarations.push(`${name} = ${expression} ;`);
}

await Deno.writeTextFile(destinationPath, declarations.join("\n") + "\n");

function renderToken(name: string, expression: GrammarExpression): string {
  const token = unwrapToken(expression);
  if (token.type !== "PATTERN") {
    throw new Error(
      `lexical rule ${name} has unsupported ${token.type} content`,
    );
  }
  if (name === "operator_symbol") {
    return String
      .raw`token operator_symbol = /([-!$%&*+>?@\\^~:][.\-!$%&*+\/<=>?@\\^|~:]*|\|[.\-!$%&*+\/<=>?@\\^|~:]([.\-!$%&*+\/<=>?@\\^|~:]*)?|<([.!$%&*+\/<=>?@\\^|~:][.\-!$%&*+\/<=>?@\\^|~:]*)?|\/([.\-!$%&*+<=>?@\\^|~:][.\-!$%&*+\/<=>?@\\^|~:]*)?|=[.\-!$%&*+\/<=>?@\\^|~:][.\-!$%&*+\/<=>?@\\^|~:]*)/ ;`;
  }
  const portablePattern = token.value.replaceAll("\\s", "[ \\t\\r\\n]");
  return `token ${name} = /${portablePattern}/ ;`;
}

function withoutLeadingAttributeGroups(
  name: string,
  expression: GrammarExpression,
): GrammarExpression {
  if (expression.type !== "SEQ") {
    throw new Error(`attributed rule ${name} is not a sequence`);
  }
  const [attributes, ...members] = expression.members;
  if (attributes?.type !== "REPEAT") {
    throw new Error(`attributed rule ${name} has no leading attribute repeat`);
  }
  return { type: "SEQ", members };
}

function unwrapToken(expression: GrammarExpression): GrammarExpression {
  if (
    expression.type === "TOKEN" || expression.type === "PREC" ||
    expression.type === "PREC_DYNAMIC" || expression.type === "PREC_LEFT" ||
    expression.type === "PREC_RIGHT"
  ) {
    return unwrapToken(expression.content);
  }
  return expression;
}

function renderExpression(expression: GrammarExpression): string {
  switch (expression.type) {
    case "ALIAS":
    case "PREC":
    case "PREC_DYNAMIC":
    case "PREC_LEFT":
    case "PREC_RIGHT":
    case "TOKEN":
      return renderExpression(expression.content);
    case "BLANK":
      throw new Error("a blank grammar expression must be part of a choice");
    case "CHOICE":
      return renderChoice(expression.members);
    case "FIELD":
      return `${expression.name}:${renderAtom(expression.content)}`;
    case "PATTERN":
      throw new Error(
        `inline pattern /${expression.value}/ must be promoted to a token`,
      );
    case "REPEAT":
      return `${renderAtom(expression.content)}*`;
    case "REPEAT1":
      return `${renderAtom(expression.content)}+`;
    case "SEQ":
      return expression.members.map(renderAtom).join(" ");
    case "STRING":
      if (expression.value === ";") return "_array_semicolon";
      if (expression.value === "const") return "CONST";
      if (expression.value === "match") return "MATCH";
      return JSON.stringify(expression.value);
    case "SYMBOL":
      return expression.name;
  }
}

function renderChoice(members: readonly GrammarExpression[]): string {
  const alternatives = members.filter((member) => member.type !== "BLANK");
  const hasBlank = alternatives.length !== members.length;
  if (alternatives.length === 0) {
    throw new Error("a choice cannot contain only blank expressions");
  }

  const rendered = alternatives.map(renderExpression).join(" | ");
  if (hasBlank) return `(${rendered})?`;
  return rendered;
}

function renderAtom(expression: GrammarExpression): string {
  if (
    expression.type === "ALIAS" || expression.type === "PREC" ||
    expression.type === "PREC_DYNAMIC" || expression.type === "PREC_LEFT" ||
    expression.type === "PREC_RIGHT" || expression.type === "TOKEN"
  ) {
    return renderAtom(expression.content);
  }
  if (
    expression.type === "CHOICE" || expression.type === "SEQ" ||
    expression.type === "FIELD"
  ) {
    return `(${renderExpression(expression)})`;
  }
  return renderExpression(expression);
}
