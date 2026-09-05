// Configuration constants for core logic
//
// The Google-Sheets-era dashboard keys and sheet header constants that used to
// live here moved with their only consumers to
// `archive/packages-core-gas-sheets/src/constants/sheets-config.ts` (issue #979).

export const WARMUP_BASE_REPS = 5;

export const PROG_SPEC_WARMUP_PCTS = (
  warmUpPcts: string,
  delimiter: string = ",",
) =>
  `${warmUpPcts}`
    .trim()
    .split(delimiter)
    .map((pct) => parseFloat(pct));

export const MROUND = (number: number, multiple: number) => {
  // A zero multiple (e.g. a custom program saved with increment 0) would divide
  // by zero and yield NaN. Degrade safely to the unrounded value instead.
  if (multiple === 0) return number;
  return Math.round(number / multiple) * multiple;
};

// Floors down to the nearest lower multiple of `increment` (default 2.5 lb
// plates), for formula-derived estimates — see docs/standards/training-max-precision.md.
// Zero-guard matches MROUND above: degrade to the unrounded value instead of dividing by zero.
export const floorToIncrement = (value: number, increment = 2.5): number => {
  if (increment === 0) return value;
  return Math.floor(value / increment) * increment;
};

export const PROG_SPEC_WORK_PCTS = (
  numSets: number,
  wtDecrementPct: number,
) => {
  // Each set i gets work percentage (1 - i * wtDecrementPct). When wtDecrementPct
  // is large relative to numSets the final set goes negative, which would produce
  // a negative prescribed weight. Reject rather than silently emit bad sets.
  const minPct = 1 - (numSets - 1) * wtDecrementPct;
  if (minPct < 0) {
    throw new RangeError(
      `wtDecrementPct ${wtDecrementPct} produces a negative work percentage ` +
        `(${minPct}) over ${numSets} sets; it must be at most ${1 / (numSets - 1)}.`,
    );
  }
  return Array(numSets)
    .fill(1)
    .reduce((acc, num) => {
      acc.push(num - acc.length * wtDecrementPct);
      return acc;
    }, []);
};
