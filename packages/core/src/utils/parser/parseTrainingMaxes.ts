import { TRAINING_MAX_HEADER_MAP } from "@src/core/constants";
import { TrainingMax, SpreadsheetCell } from "@src/core/models";
import { parseDateStringUTC, toUTCMidnight } from "../jsUtil";
import { tableToObjects } from "./tableToObjects";

/**
 * Example: parseTrainingMaxes(sheet.getDataRange().getValues())
 * @param {SpreadsheetCell[][]} data
 * @returns {TrainingMax[]}
 */

export function parseTrainingMaxes(data: SpreadsheetCell[][]): TrainingMax[] {
  const headerMap = TRAINING_MAX_HEADER_MAP;
  const rawObjects = tableToObjects(data, undefined);
  // console.log(`Raw training max objects: ${JSON.stringify(rawObjects)}.`);
  return rawObjects.map((obj) => {
    const result: Record<string, unknown> = {};
    for (const header in headerMap) {
      const { key, type } = headerMap[header]!;
      let value: unknown = obj[header];
      if (type === "number") {
        value = Number(value);
      }
      if (key === "dateUpdated") {
        // Same bug class as parseLiftRecords.ts (issue #894): a non-ISO cell
        // like "12/29/2025" parsed via bare `new Date(string)` lands on the
        // WRONG UTC calendar day on any host ahead of UTC, and carries a
        // non-midnight time-of-day on ANY non-UTC host (this call site had no
        // toUTCMidnight normalization at all). updateMaxes.ts compares this
        // value against LiftRecord.date via getTime(), so both parsers must
        // agree on the same UTC-midnight-of-the-named-day convention or the
        // comparison silently disagrees with what the sheet says.
        value = toUTCMidnight(parseDateStringUTC(String(value ?? "")));
      }
      result[key] = value;
    }
    // console.log(`Parsed training max object: ${JSON.stringify(result)}.`);
    const isDateValid =
      result["dateUpdated"] instanceof Date &&
      !isNaN((result["dateUpdated"] as Date).getTime());
    const isWeightValid =
      typeof result["weight"] === "number" && !isNaN(result["weight"] as number);
    const isLiftValid =
      typeof result["lift"] === "string" && (result["lift"] as string).length > 0;
    if (!isLiftValid) {
      throw new Error(
        `Invalid lift value: ${String(result["lift"])} (${JSON.stringify(result)})`,
      );
    }
    if (!isWeightValid) {
      throw new Error(`Invalid weight value: ${String(result["weight"])}`);
    }
    if (!isDateValid) {
      throw new Error(`Invalid dateUpdated value: ${String(result["dateUpdated"])}`);
    }
    return result as unknown as TrainingMax;
  });
}
