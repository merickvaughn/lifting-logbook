import { CORE_LIFT_HEADER, LIFT_SPEC_HEADERS } from "@src/core/constants";
import { LiftingProgramSpec, SpreadsheetCell, TrainingMax } from "@src/core/models";
import { addDaysLocal } from "@src/core/utils/jsUtil";

/**
 * Creates a lift specification from a training max and program spec.
 * @param {TrainingMax} tm
 * @param {LiftingProgramSpec} ps
 * @param {Date} startDate
 * @return {SpreadsheetCell[]}
 */

export function generateLiftSpec(
  tm: TrainingMax,
  ps: LiftingProgramSpec,
  startDate: Date,
): SpreadsheetCell[] {
  // console.log(`Offset for ${ps.lift}: ${ps.offset}`);
  const liftDate = addDaysLocal(startDate, ps.offset);
  // console.log(`Original start date: ${formatDateYYYYMMDD(startDate)}; offset date: ${formatDateYYYYMMDD(liftDate)}`);

  // Build a mapping from header to value
  const specMap: Record<string, SpreadsheetCell> = {
    [CORE_LIFT_HEADER]: ps.lift,
    Scheme: `${ps.sets} × ${ps.reps}`,
    "Inc. Amt.": ps.increment,
    TM: tm.weight,
    "Lift Date": liftDate,
    "Activ. Ex.": ps.activation,
  };

  // Return values in the order of LIFT_SPEC_HEADERS
  return LIFT_SPEC_HEADERS.map((header) => specMap[header] ?? null);
}
