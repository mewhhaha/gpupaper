import type { SourceSpan } from "./syntax.ts";

export type DuckTokenKind =
  | "identifier"
  | "integer"
  | "symbol"
  | "newline"
  | "eof";

export type DuckToken = {
  readonly kind: DuckTokenKind;
  readonly text: string;
  readonly span: SourceSpan;
};

const twoCharacterSymbols = new Set([
  "&&",
  ":=",
  "<=",
  "==",
  "=>",
  ">=",
  "!=",
  "||",
]);

const oneCharacterSymbols = new Set([
  "!",
  "%",
  "(",
  ")",
  "*",
  "+",
  ",",
  "-",
  "/",
  ":",
  "<",
  "=",
  ">",
  "[",
  "]",
  "{",
  "}",
]);

export function tokenizeDuck(
  file: string,
  source: string,
): readonly DuckToken[] {
  const tokens: DuckToken[] = [];
  let offset = 0;

  while (offset < source.length) {
    const character = source[offset];
    if (character === " " || character === "\t" || character === "\r") {
      offset += 1;
      continue;
    }
    if (character === "\n" || character === ";") {
      tokens.push({
        kind: "newline",
        text: "\n",
        span: { file, start: offset, end: offset + 1 },
      });
      offset += 1;
      continue;
    }
    if (source.startsWith("//", offset)) {
      const newline = source.indexOf("\n", offset);
      offset = newline === -1 ? source.length : newline;
      continue;
    }

    const pair = source.slice(offset, offset + 2);
    if (twoCharacterSymbols.has(pair)) {
      tokens.push({
        kind: "symbol",
        text: pair,
        span: { file, start: offset, end: offset + 2 },
      });
      offset += 2;
      continue;
    }
    if (oneCharacterSymbols.has(character)) {
      tokens.push({
        kind: "symbol",
        text: character,
        span: { file, start: offset, end: offset + 1 },
      });
      offset += 1;
      continue;
    }
    if (isDigit(character)) {
      const start = offset;
      while (offset < source.length && isDigit(source[offset])) offset += 1;
      while (
        offset < source.length &&
        isIdentifierContinuation(source[offset])
      ) offset += 1;
      tokens.push({
        kind: "integer",
        text: source.slice(start, offset),
        span: { file, start, end: offset },
      });
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = offset;
      offset += 1;
      while (
        offset < source.length &&
        isIdentifierContinuation(source[offset])
      ) offset += 1;
      tokens.push({
        kind: "identifier",
        text: source.slice(start, offset),
        span: { file, start, end: offset },
      });
      continue;
    }

    throw new SyntaxError(
      `${file}:${offset}: unsupported Duck character ${
        JSON.stringify(character)
      }`,
    );
  }

  tokens.push({
    kind: "eof",
    text: "",
    span: { file, start: source.length, end: source.length },
  });
  return tokens;
}

function isIdentifierStart(character: string): boolean {
  return (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z");
}

function isIdentifierContinuation(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character) ||
    character === "_";
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}
