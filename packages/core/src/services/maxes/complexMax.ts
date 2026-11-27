/** How a program row names a barbell complex instead of a lift (#1495): `complex:<id>`. */
export const COMPLEX_LIFT_PREFIX = "complex:";

/** The `lift` a program row stores to plan the complex with this id. */
export function complexLift(id: string): string {
  return `${COMPLEX_LIFT_PREFIX}${id}`;
}

/** The complex id a row's `lift` names, or `undefined` for an ordinary lift. */
export function complexIdOf(lift: string): string | undefined {
  return lift.startsWith(COMPLEX_LIFT_PREFIX) ? lift.slice(COMPLEX_LIFT_PREFIX.length) : undefined;
}

/**
 * The max a complex plans from, or the components that have none. `limitingLift` is the
 * component the weight comes from.
 */
export type ComplexMax = { weight: number; limitingLift: string } | { missing: string[] };

/**
 * A complex's weight is limited by its weakest lift, so it plans from its lowest component max
 * (#1495). It has no max of its own. A component with no max leaves the complex unplanned:
 * planning from the others would overload the lift that has none. Each such lift is listed once,
 * in the complex's order. On a tie, the first component in order is named as limiting.
 */
export function complexMax(
  components: readonly { lift: string }[],
  maxFor: (lift: string) => number | undefined,
): ComplexMax {
  const missing: string[] = [];
  let lowest: { weight: number; limitingLift: string } | undefined;
  for (const { lift } of components) {
    const weight = maxFor(lift);
    if (weight === undefined || !(weight > 0)) {
      if (!missing.includes(lift)) missing.push(lift);
    } else if (lowest === undefined || weight < lowest.weight) {
      lowest = { weight, limitingLift: lift };
    }
  }
  if (missing.length > 0 || lowest === undefined) return { missing };
  return lowest;
}
