import { StrengthGoalEntry, SpreadsheetCell } from '../../models';
import { parseDateStringUTC, toUTCMidnight } from '../jsUtil';

/**
 * Parses the `Strength_Goals` CSV into `StrengthGoalEntry[]`.
 *
 * The real export is a **tier ladder**, not one goal per lift. Layout:
 *
 *   Weight,175,,,                 ← bodyweight (metadata)
 *   Start Date,10/24/2022,,,
 *   Today's Date,6/9/2026,,,
 *   Lift,Current TM,Intermediate,Advanced,Elite   ← header row
 *   Squat,250,280,350,420
 *   Bench P.,185,210,262.5,315
 *   …
 *   Goal Date,N/A,2024/10/24,2027/10/24,2032/10/24
 *   Note: …                       ← footer (ignored)
 *
 * Each lift carries a Current TM plus several goal tiers (Intermediate / Advanced
 * / Elite) as absolute target weights. The `StrengthGoalEntry` model holds a
 * single goal, so Phase 1 imports the **next milestone**: the lowest tier strictly
 * above the lift's Current TM (falling back to the highest tier when all are
 * already cleared, or the first tier when no Current TM is given). Goals are
 * absolute, in lbs (the export carries no unit column).
 *
 * NOTE (#477): full multi-tier goals + per-tier goal dates need a model change and
 * are tracked as a follow-up; the header/tier matching here is name-based and
 * tolerant so minor export variations still parse.
 */
export function parseStrengthGoals(data: SpreadsheetCell[][]): StrengthGoalEntry[] {
  const norm = (c: SpreadsheetCell | undefined): string =>
    String(c ?? '').trim().toLowerCase();

  // The header row is the one whose first cell is "Lift".
  const headerIdx = data.findIndex((r) => norm(r[0]) === 'lift');
  if (headerIdx === -1) return [];
  const headerNames = (data[headerIdx] ?? []).map(norm);

  // Classify columns: the Current-TM column vs. the goal-tier columns (in order).
  let currentTmIdx = -1;
  const tierIdxs: number[] = [];
  for (let c = 1; c < headerNames.length; c++) {
    const name = headerNames[c]!;
    if (!name) continue;
    if (name.includes('current') || name === 'tm') currentTmIdx = c;
    else tierIdxs.push(c);
  }

  // Stamp goals with the export's "Today's Date" when present, else now.
  const todayRow = data.find((r) => norm(r[0]).includes('today'));
  const todayRaw = todayRow ? String(todayRow[1] ?? '').trim() : '';
  // Non-ISO cells (e.g. "6/9/2026") parse at LOCAL midnight via bare
  // `new Date(string)`, landing on the WRONG UTC calendar day on any host
  // ahead of UTC -- same bug class as issue #894. toUTCMidnight normalizes
  // the time-of-day, matching the convention parseLiftRecords.ts /
  // parseTrainingMaxes.ts already use (issue #899).
  const parsedToday = todayRaw ? toUTCMidnight(parseDateStringUTC(todayRaw)) : null;
  const updatedAt = parsedToday && !isNaN(parsedToday.getTime()) ? parsedToday : new Date();

  const num = (c: SpreadsheetCell | undefined): number | undefined => {
    const s = String(c ?? '').trim();
    if (!s) return undefined;
    const n = Number(s);
    return isNaN(n) ? undefined : n;
  };

  // Metadata/footer rows that are not lifts.
  const STOP = ['goal date', 'note', 'start date', "today's date", 'today', 'weight'];

  const entries: StrengthGoalEntry[] = [];
  for (let i = headerIdx + 1; i < data.length; i++) {
    const row = data[i] ?? [];
    const lift = String(row[0] ?? '').trim();
    const lc = lift.toLowerCase();
    if (!lift || STOP.some((s) => lc.startsWith(s))) continue;

    const tiers = tierIdxs
      .map((c) => num(row[c]))
      .filter((n): n is number => n !== undefined)
      // Sort ascending so "next milestone" is the numerically lowest tier above
      // the Current TM regardless of column order in the export.
      .sort((a, b) => a - b);
    if (tiers.length === 0) continue;

    const currentTM = currentTmIdx >= 0 ? num(row[currentTmIdx]) : undefined;
    // Next milestone: lowest tier strictly above the Current TM; else the top tier
    // (all cleared); the lowest tier when no Current TM is given.
    let target =
      currentTM !== undefined ? tiers.find((t) => t > currentTM) : tiers[0];
    if (target === undefined) target = tiers[tiers.length - 1];

    entries.push({
      lift,
      goalType: 'absolute',
      unit: 'lbs',
      updatedAt,
      ...(target !== undefined ? { target } : {}),
    });
  }

  return entries;
}
