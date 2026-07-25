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
  effect_binding_statement:
    "(head:EFFECT_BINDING) (value:_expression) | (name:unit_pattern) EFFECT_BIND (value:_expression)",
  index_assignment:
    '(name:identifier) "[" (index:_expression) "]" "=" (value:_expression)',
  type_declaration_statement:
    '"type" (name:identifier) (parameter:identifier)* "=" (definition:(type_sum | struct_type | newtype_type | packed_type | type_reference))',
  fixity_declaration_statement:
    '(fixity:("infixl" | "infixr" | "infix" | "prefix")) (precedence:number) (operator:(CARET_OPERATOR | operator_symbol | NOT_EQUAL | FIXITY_BANG)) "=" (target:fixity_target)',
  _effect_row_expression: "effect_union_expression",
  effect_union_expression:
    'effect_intersection_expression (":|" effect_intersection_expression)*',
  effect_intersection_expression:
    'effect_difference_expression (":&" effect_difference_expression)*',
  effect_difference_expression:
    '_effect_row_primary (":-" _effect_row_primary)*',
  _expression:
    "try_with_expression | arrow_function | recursive_expression | if_expression | loop_expression | effect_handler_expression | binary_expression",
  arrow_function:
    '(parameters:(DISCARDED_ARROW | SINGLE_ARROW_PARAMETER)) (body:_expression) | (parameters:effect_identifier) "=>" (body:_expression) | (parameters:(ARROW_PARAMETER | ARROW_PARAMETER_LIST | const_parameter_list | bracket_parameter_list | unit_pattern | wildcard | number | string | character | boolean | grouped_value_alternative_pattern)) "=>" (body:_expression)',
  recursive_function:
    '"rec" (parameters:(identifier | wildcard | ARROW_PARAMETER_LIST | parameter_list | const_parameter_list | bracket_parameter_list)) "=>" (body:_expression)',
  parameter_list: '"(" ((parameter ("," parameter)*)?) ")"',
  bracket_parameter_list: "BRACKET_PARAMETER_LIST",
  binary_expression:
    'is_expression ((operator:(CARET_OPERATOR | operator_symbol | NOT_EQUAL | "=" | ":=")) (right:is_expression))*',
  is_expression: 'as_expression ((operator:"is") (type:type_reference))?',
  as_expression: "unary_expression (as_keyword (type:type_reference))*",
  unary_expression:
    '"!" (operand:unary_expression) | ((operator:("&" | "freeze" | "comptime" | CARET_OPERATOR | operator_symbol)) (operand:unary_expression)) | application_expression',
  application_expression:
    "postfix_expression ((_application_space (argument:(postfix_expression | field_block))) | (argument:(parenthesized_or_product | line_array_expression)))*",
  postfix_expression: "_primary_expression _postfix_suffix*",
  index_expression: '(object:postfix_expression) "[" (index:_expression) "]"',
  effect_handler_expression:
    "HANDLER (effect:effect_identifier) (clauses:handler_clause_block)",
  handler_operation_clause:
    '(name:identifier) ":" (parameters:(ARROW_PARAMETER_LIST | parameter_list)) "=>" (body:_expression)',
  handler_return_clause: '"return" ":" (value:_expression)',
  handler_clause_block:
    '"{" (handler_operation_clause ((",")?))* handler_return_clause (TRAILING_SHAPE_CLOSE | "}")',
  _primary_expression:
    'FLOAT_LITERAL | HEX_LITERAL | number | string | character | boolean | "loop" | identifier | _aggregate_constructor_identifier | effect_identifier | intrinsic_identifier | atom_expression | import_meta_expression | import_expression | include_expression | named_product | positional_product | union_case | linear_reference | unit_pattern | line_array_expression | array_expression | array_repeat_expression | nonempty_field_block | match_expression | scratch_expression | block | parenthesized_expression',
  condition_expression: "condition_binary_expression",
  condition_binary_expression:
    "condition_is_expression ((operator:(CARET_OPERATOR | operator_symbol | NOT_EQUAL)) (right:condition_is_expression))*",
  condition_is_expression:
    'condition_unary_expression ((operator:"is") (type:type_reference))?',
  condition_unary_expression:
    '"!" (operand:condition_unary_expression) | ((operator:("&" | "freeze" | "comptime" | "do" | CARET_OPERATOR | operator_symbol)) (operand:condition_unary_expression)) | condition_call_expression',
  condition_call_expression:
    "condition_parenthesized_expression ((_condition_application_space (argument:(FLOAT_LITERAL | HEX_LITERAL | identifier | _aggregate_constructor_identifier | effect_identifier | intrinsic_identifier | number | string | character | boolean | atom_expression | import_meta_expression | linear_reference | parenthesized_or_product | array_expression))) | _condition_postfix_suffix)*",
  condition_parenthesized_expression:
    '"(" condition_expression ")" | _condition_primary',
  condition_index_expression:
    '(object:condition_expression) "[" (index:_expression) "]"',
  match_case:
    '"|" (pattern:_single_match_pattern) (_pattern_pipe (pattern:_single_match_pattern))* (("if" (guard:condition_expression))?) "=>" (body:_expression)',
  match_case_block:
    'MATCH_CASE_OPEN match_case_tail ((",")? match_case)* (TRAILING_SHAPE_CLOSE | "}")',
  match_expression:
    "MATCH (target:condition_expression) (cases:match_case_block)",
  _single_binding_pattern:
    "const_value_pattern | union_pattern | number | string | character | boolean | identifier | _aggregate_constructor_identifier | wildcard | array_pattern | positional_product_pattern | named_shape_pattern",
  _single_match_pattern:
    "wildcard_union_pattern | const_value_pattern | type_pattern | union_pattern | number | string | character | boolean | identifier | _aggregate_constructor_identifier | wildcard | array_pattern | positional_product_pattern | named_shape_pattern",
  const_value_pattern: 'CONST_VALUE_OPEN (value:_expression) ")"',
  union_case:
    '(head:UNION_ARRAY_OPEN) (value:union_array_payload) | "`" (case:constructor_identifier) _application_space (value:postfix_expression)',
  parameter:
    '(_const_parameter ((variadic:"...")?) | (linear:"!")?) (name:(identifier | wildcard)) ((":" (type:type_reference))?)',
  named_shape_pattern:
    '"{" (((shorthand_shape_pattern_field | named_shape_pattern_field) ("," (shorthand_shape_pattern_field | named_shape_pattern_field))*)?) (TRAILING_SHAPE_CLOSE | "}")',
  function_shape_pattern:
    '"{" ((function_shape_pattern_field ("," function_shape_pattern_field)*)?) (TRAILING_SHAPE_CLOSE | "}")',
  positional_product_pattern:
    '"(" (_match_pattern "," (product_rest_pattern | _match_pattern ("," _match_pattern)*)) ")"',
  positional_product:
    '"(" (_expression "," (_expression ("," _expression)*)) (TRAILING_PRODUCT_CLOSE | ")")',
  named_product:
    '"[" product_field ("," product_field)* (TRAILING_ARRAY_CLOSE | "]")',
  positional_type_product:
    '"(" (type_reference "," (type_reference ("," type_reference)*) ((",")?)) ")" | "(" (element:type_reference) _array_semicolon (length:(_expression | wildcard)) ")" | "[" ((type_reference ("," type_reference)* (TRAILING_ARRAY_CLOSE | "]")) | "]")',
  array_expression:
    '"[" ((array_spread ("," _expression)* | _expression ("," _expression)* (("," array_spread))?) (TRAILING_ARRAY_CLOSE | "]") | "]")',
  array_pattern:
    '"[" ((_array_pattern_element ("," _array_pattern_element)*) (TRAILING_ARRAY_CLOSE | "]") | "]")',
  attribute_group:
    '"@" "[" (_expression ("," _expression)*) (TRAILING_ARRAY_CLOSE | "]")',
  field_block:
    '"{" (((shape_field | field_definition | shorthand_field) ("," (shape_field | field_definition | shorthand_field))*)?) (TRAILING_SHAPE_CLOSE | "}") | RECORD_SHAPE_HEAD first_shape_field ("," (shape_field | field_definition | shorthand_field))* (TRAILING_SHAPE_CLOSE | "}") | SHORTHAND_RECORD',
  shorthand_field: "name:identifier",
  effect_operation_block:
    '"{" (effect_operation ((",")?))* (TRAILING_SHAPE_CLOSE | "}")',
  duck_member_block:
    '"{" ((duck_type_member | duck_member) ((",")?))+ (TRAILING_SHAPE_CLOSE | "}")',
  extension_member_block:
    '"{" ((extension_type_member | shape_field) ("," | _extension_member_terminator))* ((extension_type_member | shape_field)?) (TRAILING_SHAPE_CLOSE | "}")',
  type_field_block:
    '"{" ((type_field | named_type_field) ((",")?))* (TRAILING_SHAPE_CLOSE | "}")',
  type_pattern:
    '(kind:("struct" | "union")) "{" (type_pattern_field ",")* ((type_pattern_field | open:"..")?) (TRAILING_SHAPE_CLOSE | "}")',
  _type_expression: "forall_type | function_type",
  function_type:
    'type_union (("->" (effects:latent_effect_row)? (result:_type_expression)))?',
  type_union: 'type_intersection (":|" type_intersection)*',
  type_intersection: 'type_difference (":&" type_difference)*',
  type_difference: 'type_application (":-" type_application)*',
  _type_application: "type_application",
  type_application:
    "_type_prefix ((_type_application_space (argument:_type_prefix)) | (argument:type_parenthesized))*",
  _index_open: '"["',
};

const additionalPortableRules: Readonly<Record<string, string>> = {
  const_value_pattern: 'CONST_VALUE_OPEN (value:_expression) ")"',
  first_shape_field: '(name:identifier) "=" (value:_expression)',
  line_array_expression:
    'LINE_ARRAY_OPEN ((product_field ("," product_field)* | (array_spread ("," _expression)* | _expression ("," _expression)* (("," array_spread))?)) (TRAILING_ARRAY_CLOSE | "]") | "]")',
  union_array_payload:
    '((product_field ("," product_field)* | (array_spread ("," _expression)* | _expression ("," _expression)* (("," array_spread))?)) (TRAILING_ARRAY_CLOSE | "]") | "]")',
  wildcard_union_pattern: "UNION_WILDCARD",
  recursive_expression:
    '"rec" (operand:(identifier | wildcard | ARROW_PARAMETER_LIST | positional_product | const_parameter_list | bracket_parameter_list)) (("=>" (body:_expression))?)',
  _attributed_module_statement:
    "declare_effect_statement | effect_statement | declare_record_statement | type_declaration_statement | duck_declaration_statement | extension_declaration_statement | fixity_declaration_statement | module_binding_statement | binding_statement",
  _plain_module_statement:
    "effect_binding_statement | type_pattern_statement | for_statement | break_statement | continue_statement | expression_statement",
  _effect_row_primary:
    "parenthesized_effect_expression | effect_family_reference | effect_row_variable | effect_operation_reference",
  _postfix_suffix:
    '"." (field:identifier) | "[" (index:_expression) "]" | handler_clause_block',
  _condition_primary:
    'FLOAT_LITERAL | HEX_LITERAL | number | string | character | boolean | atom_expression | import_meta_expression | intrinsic_identifier | "loop" | identifier | _aggregate_constructor_identifier | effect_identifier | linear_reference | union_case',
  _condition_postfix_suffix:
    'argument:parenthesized_or_product | "." (field:identifier) | "[" (index:_expression) "]"',
  binding_product_pattern:
    '"(" (_binding_pattern "," (_binding_pattern ("," _binding_pattern)*)) ")"',
  linear_binding_pattern: '"!" (name:identifier)',
  const_parameter_list: "CONST_PARAMETER_LIST",
  match_case_tail:
    '(pattern:_single_match_pattern) (_pattern_pipe (pattern:_single_match_pattern))* (("if" (guard:condition_expression))?) "=>" (body:_expression)',
  nonempty_field_block:
    'RECORD_SHAPE_HEAD (first_shape_field | shorthand_field) ("," (shape_field | field_definition | shorthand_field))* (TRAILING_SHAPE_CLOSE | "}") | SHORTHAND_RECORD',
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
  "contextual _application_space = /[ \\t]+(?=[A-Za-z0-9\"'(\\[{#])(?!(as|by|else|if|in|is|where|with)\\b)/ ;",
  "contextual _block_space = /[ \\t]+(?=\\{)/ ;",
  "contextual _condition_application_space = /[ \\t]+(?=[A-Za-z0-9_\"'(\\[#])(?!(as|by|else|if|in|is|where|with)\\b)/ ;",
  "contextual _type_application_space = /[ \\t]+(?=[A-Za-z_#&]|\\(|\\[)/ ;",
  "contextual _break_value_space = /[ \\t]+(?=[^\\r\\n;}])/ ;",
  "contextual _break_terminator_space = /[ \\t]+(?=$|[\\r\\n;}])/ ;",
  "contextual _extension_member_terminator = /[\\r\\n][ \\t]*/ ;",
  "contextual _statement_terminator = /[\\r\\n][ \\t]*/ ;",
  "contextual FIXITY_BANG = /!(?=[ \\t]*=)/ ;",
  "contextual ARROW_PARAMETER priority 30 = /[A-Za-z_][A-Za-z0-9_]*(?=[ \\t]*=>)/ ;",
  String
    .raw`contextual ARROW_PARAMETER_LIST priority 30 = /\([ \t]*([^()\r\n]*[:!][^()\r\n]*|_[^()\r\n]*)\)(?=[ \t]*=>)/ ;`,
  "contextual BRACKET_PARAMETER_LIST = /\\[[- A-Za-z0-9_,:!<>*&#().]*](?=[ \\t]*=>)/ ;",
  "contextual LINE_ARRAY_OPEN = /[\\r\\n][ \\t]*\\[/ ;",
  "contextual TRAILING_PRODUCT_CLOSE = /,[ \\t\\r\\n]*\\)/ ;",
  "",
  "token CONST priority 10 = /const/ ;",
  "token CONST_VALUE_OPEN priority 60 = /#\\(/ ;",
  "token CONST_PARAMETER_LIST priority 30 = /\\([^()\\r\\n]*const[^()\\r\\n]*\\)/ ;",
  "token EFFECT_BIND priority 60 = /<-/ ;",
  "token EFFECT_BINDING priority 70 = /[A-Za-z_][A-Za-z0-9_]*[ \\t]*<-/ ;",
  "token MATCH priority 10 = /match/ ;",
  String.raw`token HANDLER priority 70 = /\\andleK/ ;`,
  String.raw`token DISCARDED_ARROW priority 70 = /\\D~*/ ;`,
  String
    .raw`token SINGLE_ARROW_PARAMETER priority 70 = /\\[A-Za-z0-9_]*[ \t]*=[A-Za-z]/ ;`,
  String.raw`token FLOAT_LITERAL priority 70 = /\\[0-9]*[k-t][0-9]+f(32|64)/ ;`,
  String.raw`token HEX_LITERAL priority 70 = /\\H[0-9A-Fa-f]+/ ;`,
  String.raw`token CARET_OPERATOR priority 70 = /\\\^*C/ ;`,
  String.raw`token RECORD_SHAPE_HEAD priority 70 = /\\[ \t\r\n]*R/ ;`,
  String.raw`token TRAILING_ARRAY_CLOSE priority 70 = /\\[ \t\r\n]*A/ ;`,
  String.raw`token TRAILING_SHAPE_CLOSE priority 70 = /\\[ \t\r\n]*\}/ ;`,
  String
    .raw`token SHORTHAND_RECORD priority 70 = /\\[ \t\r\n]*[A-Za-z][A-Za-z0-9_]*([ \t\r\n]*,[ \t\r\n]*[A-Za-z][A-Za-z0-9_]*)+[ \t\r\n]*S/ ;`,
  "token MATCH_CASE_OPEN priority 20 = /[ \\t]*\\{[ \\t\\r\\n]*\\|/ ;",
  "token NOT_EQUAL priority 60 = /!=/ ;",
  "token UNION_ARRAY_OPEN priority 50 = /`[A-Z][A-Za-z0-9_]*[ \\t]+\\[/ ;",
  "contextual UNION_WILDCARD = /`[A-Z][A-Za-z0-9_]*[ \\t]+_/ ;",
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
      .raw`token operator_symbol = /([-$%&*+>?@~:][.\-!$%&*+\/<=>?@|~:]*|\|[.\-!$%&*+\/<=>?@|~:]([.\-!$%&*+\/<=>?@|~:]*)?|<([.!$%&*+\/<=>?@|~:][.\-!$%&*+\/<=>?@|~:]*)?|\/([.\-!$%&*+<=>?@|~:][.\-!$%&*+\/<=>?@|~:]*)?|=[.\-!$%&*+\/<=>?@|~:][.\-!$%&*+\/<=>?@|~:]*)/ ;`;
  }
  if (name === "number") {
    return String
      .raw`token number = /[0-9]+([iu][1-9][0-9]*|f(32|64))?/ ;`;
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
