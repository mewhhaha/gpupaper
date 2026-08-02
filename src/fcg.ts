export type FcgOperation = {
  readonly opcode: string;
  readonly operands: readonly (number | string)[];
  readonly sourceStart: number;
  readonly regionId: number;
};

export type FcgFunction = {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly localCount: number;
  readonly operations: readonly FcgOperation[];
};

export type FcgModule = {
  readonly functions: readonly FcgFunction[];
  readonly constructorTags: ReadonlyMap<string, number>;
};
