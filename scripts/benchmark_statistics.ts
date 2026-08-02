export type SampleSummary = {
  readonly count: number;
  readonly median: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly medianAbsoluteDeviation: number;
  readonly p95:
    | { readonly status: "measured"; readonly value: number }
    | { readonly status: "insufficient"; readonly minimumSampleCount: 20 };
};

export type PairedSampleSummary = {
  readonly differences: readonly number[];
  readonly logRatios: readonly number[];
  readonly difference: SampleSummary;
  readonly logRatio: SampleSummary;
  readonly medianRatio: number;
};

export function summarizeSamples(values: readonly number[]): SampleSummary {
  requireSamples(values);
  const medianValue = median(values);
  return {
    count: values.length,
    median: medianValue,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    medianAbsoluteDeviation: median(
      values.map((value) => Math.abs(value - medianValue)),
    ),
    p95: values.length >= 20
      ? { status: "measured", value: percentile(values, 0.95) }
      : { status: "insufficient", minimumSampleCount: 20 },
  };
}

export function summarizePairedSamples(
  left: readonly number[],
  right: readonly number[],
): PairedSampleSummary {
  if (left.length !== right.length) {
    throw new RangeError(
      `paired samples have lengths ${left.length} and ${right.length}`,
    );
  }
  requireSamples(left);
  const differences = left.map((value, index) => value - right[index]!);
  const logRatios = left.map((value, index) => {
    const denominator = right[index]!;
    if (value <= 0 || denominator <= 0) {
      throw new RangeError(
        `paired ratios require positive values; received ${value} and ${denominator} at pair ${index}`,
      );
    }
    return Math.log(value / denominator);
  });
  return {
    differences,
    logRatios,
    difference: summarizeSamples(differences),
    logRatio: summarizeSamples(logRatios),
    medianRatio: Math.exp(median(logRatios)),
  };
}

export function representativeSample<Sample>(
  samples: readonly Sample[],
  value: (sample: Sample) => number,
): Sample {
  if (samples.length === 0) {
    throw new RangeError("cannot select a representative from no samples");
  }
  const medianValue = median(samples.map(value));
  return samples.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(value(nearest) - medianValue);
    const candidateDistance = Math.abs(value(candidate) - medianValue);
    return candidateDistance < nearestDistance ? candidate : nearest;
  });
}

export function median(values: readonly number[]): number {
  requireSamples(values);
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered.length / 2;
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[Math.floor(middle)]!;
}

export function percentile(
  values: readonly number[],
  quantile: number,
): number {
  requireSamples(values);
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError(
      `quantile must be within [0, 1]; received ${quantile}`,
    );
  }
  const ordered = [...values].sort((left, right) => left - right);
  const rank = quantile * (ordered.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return ordered[lower]!;
  const weight = rank - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

function requireSamples(values: readonly number[]): void {
  if (values.length === 0) {
    throw new RangeError("cannot summarize an empty sample");
  }
  const invalidIndex = values.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex >= 0) {
    throw new TypeError(
      `sample ${invalidIndex} is not finite: ${values[invalidIndex]}`,
    );
  }
}
