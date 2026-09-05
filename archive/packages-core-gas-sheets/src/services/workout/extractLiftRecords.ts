import { REPS_HEADER } from "@src/core/constants";
import { LiftRecord, LiftRecordRequiredKeys, SpreadsheetCell } from "@src/core/models";

/**
 * Extract lift records from a 2D grid of data.
 * @param {SpreadsheetCell[][]} data
 * @returns {LiftRecord[]}
 */

export function extractLiftRecords(data: SpreadsheetCell[][]): LiftRecord[] {
  if (!data || data.length < 2) return [];
  // Extract program and cycle from the first few rows (look for 'Program' and 'Cycle' headers)
  let program: string | undefined = undefined;
  let cycleNum: number | undefined = undefined;
  for (let i = 0; i < Math.min(5, data.length); i++) {
    const row = data[i];
    if (Array.isArray(row)) {
      for (let j = 0; j < row.length; j++) {
        if (typeof row[j] === "string" && (row[j] as string).trim() === "Program") {
          program = row[j + 1] !== undefined ? String(row[j + 1]) : undefined;
        }
        if (typeof row[j] === "string" && (row[j] as string).trim() === "Cycle") {
          const val = row[j + 1];
          if (val !== undefined && val !== "") {
            const num = Number(val);
            if (!isNaN(num)) cycleNum = num;
          }
        }
      }
    }
  }
  // Enforce required fields
  if (!program || cycleNum === undefined) {
    throw new Error(
      `Missing required program or cycle number in lift records data.`,
    );
  }
  // Find the header row for lift records
  const headerIdx = data.findIndex((row) => row.includes(REPS_HEADER));

  if (headerIdx === -1) throw new Error("Lift records header row not found.");
  const headers = data[headerIdx]!;
  const records: LiftRecord[] = [];
  // Map of date string to workout number (incremented as new dates are found)
  const dateToWorkoutNum = new Map<string, number>();
  let workoutCounter = 1;
  // Process rows after header
  for (let i = headerIdx + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 5) continue;
    // Check for required fields (all except Notes)
    const requiredIdxs = [0, 1, 2, 3]; // Date, Lift, Set, Weight
    for (const idx of requiredIdxs) {
      if (row[idx] === undefined || row[idx] === "") {
        throw new Error(
          `Missing required field '${String(headers[idx])}' at row ${headerIdx + i + 1}, column ${idx + 1}`,
        );
      }
    }
    // Exclude warm-up sets
    const setVal = row[2];
    if (
      typeof setVal === "string" &&
      setVal.trim().toLowerCase().startsWith("warm-up")
    ) {
      continue;
    }
    // Exclude skipped work sets
    const repVal = row[4];
    if (repVal === undefined || repVal === "" || Number(repVal) === 0) {
      continue;
    }
    // Determine workoutNum from date
    const dateStr = String(row[0]);
    let workoutNum: number;
    if (dateToWorkoutNum.has(dateStr)) {
      workoutNum = dateToWorkoutNum.get(dateStr)!;
    } else {
      workoutNum = workoutCounter++;
      dateToWorkoutNum.set(dateStr, workoutNum);
    }
    // Map row to LiftRecord
    const rec: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const value = row[j];
      switch (key) {
        case "Set": {
          const currSetMatch = (value as string).match(/Set\s*(\d+)/i);
          if (currSetMatch) {
            rec["setNum"] = Number(currSetMatch[1]);
          } else {
            throw new Error(
              `Invalid Set string format at row ${headerIdx + i + 1}: ${String(value)}`,
            );
          }
          break;
        }
        case "Weight":
        case "Reps":
          rec[(key as string).trim().toLowerCase()] = Number(value);
          break;
        default:
          if (
            !LiftRecordRequiredKeys.includes(
              String(key).toLowerCase().trim() as keyof LiftRecord,
            )
          ) {
            throw new Error(
              `Unexpected column header '${String(key)}' at row ${headerIdx + 1}, column ${j + 1}.`,
            );
          }
          rec[String(key).trim().toLowerCase()] = value;
          break;
      }
    }
    // Add required program and cycleNum
    rec["program"] = program;
    rec["cycleNum"] = cycleNum;
    rec["workoutNum"] = workoutNum;

    // Validate all LiftRecord keys (including notes)
    const recTyped = rec as unknown as LiftRecord;
    const missingKeys = LiftRecordRequiredKeys.filter(
      (key) => recTyped[key] === undefined || recTyped[key] === null,
    );
    if (missingKeys.length > 0) {
      throw new Error(
        `LiftRecord is missing required values for keys: ${missingKeys.join(", ")} at row ${headerIdx + i + 1}`,
      );
    }
    records.push(recTyped);
  }
  return records;
}
