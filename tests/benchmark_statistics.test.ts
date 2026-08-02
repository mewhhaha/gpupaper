import {
  median,
  representativeSample,
  summarizePairedSamples,
  summarizeSamples,
} from "../scripts/benchmark_statistics.ts";

Deno.test("median averages the two central observations", () => {
  if (median([1, 2, 10, 20]) !== 6) {
    throw new Error("even-sized median did not average the central pair");
  }
});

Deno.test("a representative profile is one observed execution", () => {
  const samples = [
    { total: 1, stage: 100 },
    { total: 3, stage: 300 },
    { total: 9, stage: 900 },
  ] as const;
  const representative = representativeSample(
    samples,
    (sample) => sample.total,
  );
  if (representative !== samples[1]) {
    throw new Error("representative selection synthesized a profile");
  }
});

Deno.test("p95 is withheld below the declared sample threshold", () => {
  const summary = summarizeSamples([1, 2, 3, 4]);
  if (summary.p95.status !== "insufficient") {
    throw new Error("four observations were presented as a p95 estimate");
  }
});

Deno.test("paired summaries preserve pairwise differences and ratios", () => {
  const summary = summarizePairedSamples([4, 8], [2, 4]);
  if (summary.differences[0] !== 2 || summary.differences[1] !== 4) {
    throw new Error("paired differences were not preserved");
  }
  if (Math.abs(summary.medianRatio - 2) > Number.EPSILON) {
    throw new Error(`paired ratio was ${summary.medianRatio}; expected 2`);
  }
});
