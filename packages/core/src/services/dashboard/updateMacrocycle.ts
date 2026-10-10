import { WEEKDAY_MAP } from "@src/core/constants";
import { MacrocycleDashboard, UpdateMacrocycleOverrides, Weekday } from "@src/core/models";
import { formatDateYYYYMMDD, getNextDate } from "@src/core/utils/jsUtil";

export function updateMacrocycle(
  prevMacrocycle: MacrocycleDashboard,
  overrides: UpdateMacrocycleOverrides = {},
): MacrocycleDashboard {
  const prevNum = prevMacrocycle.macrocycleNum;
  const prevDate = new Date(prevMacrocycle.macrocycleDate);
  const { targetWeekday, today, overrideDate } = overrides;
  let targetWeekdayNum = 0;
  if (!overrideDate) {
    targetWeekdayNum = prevDate.getUTCDay();

    // Determine target weekday: if not specified, use previous macrocycle's weekday
    if (targetWeekday) {
      targetWeekdayNum = WEEKDAY_MAP[targetWeekday.toLowerCase()]!;
    } else {
      targetWeekdayNum = WEEKDAY_MAP[prevMacrocycle.macrocycleStartWeekday.toLowerCase()]!;
    }
  }
  // If today matches the target weekday and is at least 7 days after prevDate, use today
  const macrocycleDate =
    overrideDate ?? getNextDate(prevDate, targetWeekdayNum, today);
  // Update sheet link
  const newSheetName = `${prevMacrocycle.program}_Cycle_${prevNum + 1}_${formatDateYYYYMMDD(macrocycleDate)}`;
  return {
    ...prevMacrocycle,
    macrocycleNum: prevNum + 1,
    macrocycleDate: macrocycleDate,
    sheetName: newSheetName,
    macrocycleStartWeekday: overrides.updateStartWeekday
      ? (Object.keys(WEEKDAY_MAP).find(
          (key) => WEEKDAY_MAP[key] === macrocycleDate.getUTCDay(),
        ) as Weekday)
      : prevMacrocycle.macrocycleStartWeekday,
  };
}
