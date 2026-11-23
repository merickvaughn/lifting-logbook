import { SupplementStackState } from '@lifting-logbook/core';
import { SupplementChange, SupplementItem } from '@lifting-logbook/types';
import { SheetsRequest, SpreadsheetTab } from '../google-sheet/google-sheet.client';

/** The two tabs the mirror owns (ADR-047, decision 20). */
export const SUPPLEMENTS_TAB = 'Supplements';
export const HISTORY_TAB = 'History';

type Cell = string | number;

export const SUPPLEMENTS_HEADER = ['Name', 'Slot', 'Amount', 'Servings', 'Day types', 'Timing', 'Notes', 'Links', 'Status'];
export const HISTORY_HEADER = ['Date', 'Change', 'Item', 'Summary'];

/** Google rejects a cell over 50,000 characters, and a rejected write would be retried for ever. */
const MAX_CELL_CHARS = 49_000;

const joinNonEmpty = (parts: string[], separator: string) => parts.filter((p) => p !== '').join(separator);

/**
 * "Supplements": one row per item and dose, with a header row. Neither tab holds an internal ID
 * (decision 20), so day types show by name and an unknown day type is left out.
 */
export function supplementsRows(state: SupplementStackState): Cell[][] {
  const dayTypeName = new Map(state.dayTypes.map((d) => [d.id, d.name]));
  const rows: Cell[][] = [SUPPLEMENTS_HEADER];
  for (const item of state.items) {
    const notes = joinNonEmpty([item.shortNote, item.longNote], '\n\n');
    const links = item.links.map((l) => (l.label ? `${l.label}: ${l.url}` : l.url)).join('\n');
    const shared = [item.timing, notes, links, item.status];
    if (item.doses.length === 0) rows.push([item.name, '', '', '', '', ...shared]);
    for (const dose of item.doses) {
      const dayTypes = dose.dayTypes.flatMap((id) => dayTypeName.get(id) ?? []).join(', ');
      rows.push([item.name, dose.slot, dose.amount, dose.servings, dayTypes, ...shared]);
    }
  }
  return rows;
}

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  keyCompound: 'key compound',
  timing: 'timing',
  shortNote: 'short note',
  longNote: 'long note',
  links: 'links',
  ingredients: 'ingredients',
  category: 'category',
  typicalRange: 'typical range',
};

/** The change as the lifter reads it: its label and a summary, with names where the log has IDs. */
function describe(change: SupplementChange, name: (id: string) => string): { label: string; item: string; summary: string } {
  switch (change.type) {
    case 'added':
      return { label: 'Added', item: change.item.name, summary: change.note ?? '' };
    case 'edited':
      return {
        label: 'Edited',
        item: name(change.itemId),
        summary: `Changed ${Object.keys(change.changes).map((k) => FIELD_LABELS[k] ?? k).join(', ')}`,
      };
    case 'moved':
      return {
        label: 'Moved',
        item: name(change.itemId),
        summary: change.doses.length === 0 ? 'No doses' : change.doses.map((d) => `${d.slot} ${d.amount}`.trim()).join(', '),
      };
    case 'started':
      return { label: 'Started', item: name(change.itemId), summary: 'Moved to the active stack' };
    case 'moved_to_pending':
      return { label: 'Moved to pending', item: name(change.itemId), summary: '' };
    case 'removed':
      return { label: 'Removed', item: change.item.name, summary: '' };
    case 'restored':
      return { label: 'Restored', item: name(change.itemId), summary: '' };
    case 'confirmed':
      return { label: 'Confirmed', item: name(change.itemId), summary: 'Checked against its label' };
    case 'mix_created':
      return { label: 'Mix created', item: change.mix.name, summary: `From ${change.partIds.map(name).join(', ')}` };
    case 'folded_into_mix':
      return { label: 'Added to mix', item: name(change.itemId), summary: `Folded into ${name(change.mixId)}` };
    case 'mix_split':
      return { label: 'Mix split', item: name(change.mixId), summary: '' };
    case 'day_types_set':
      return { label: 'Day types set', item: '', summary: change.dayTypes.map((d) => d.name).join(', ') };
    case 'caffeine_cutoff_set':
      return { label: 'Caffeine cutoff set', item: '', summary: change.caffeineCutoff };
  }
}

/** "History": one row per change, newest first, with a header row. */
export function historyRows(changes: SupplementChange[]): Cell[][] {
  const names = new Map<string, string>();
  const remember = (item: SupplementItem) => names.set(item.id, item.name);
  for (const c of changes) {
    if (c.type === 'added' || c.type === 'removed') remember(c.item);
    if (c.type === 'mix_created') remember(c.mix);
  }
  const name = (id: string) => names.get(id) ?? 'an item';
  const newestFirst = [...changes].sort((a, b) => b.seq - a.seq);
  return [
    HISTORY_HEADER,
    ...newestFirst.map((c) => {
      const d = describe(c, name);
      return [c.date, d.label, d.item, d.summary];
    }),
  ];
}

const cell = (value: Cell) => ({
  // stringValue and numberValue only, never formulaValue, so a note beginning with `=` stays text
  // (decision 19).
  userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: value.slice(0, MAX_CELL_CHARS) },
});

/**
 * One `batchUpdate` body that writes both tabs whole: an `addSheet` for each tab that's missing,
 * then an `updateCells` over each tab's whole range, which clears whatever the new rows don't
 * cover (decision 19). A new tab gets an ID of its own, chosen here, so the same batch can fill it.
 */
export function mirrorRequests(existing: SpreadsheetTab[], tabs: { title: string; rows: Cell[][] }[]): SheetsRequest[] {
  let nextId = existing.reduce((max, t) => Math.max(max, t.sheetId), 0) + 1;
  const adds: SheetsRequest[] = [];
  const writes: SheetsRequest[] = [];
  for (const tab of tabs) {
    let sheetId = existing.find((t) => t.title === tab.title)?.sheetId;
    if (sheetId === undefined) {
      sheetId = nextId++;
      adds.push({ addSheet: { properties: { sheetId, title: tab.title } } });
    }
    writes.push({
      updateCells: {
        range: { sheetId },
        fields: 'userEnteredValue',
        rows: tab.rows.map((row) => ({ values: row.map(cell) })),
      },
    });
  }
  return [...adds, ...writes];
}
