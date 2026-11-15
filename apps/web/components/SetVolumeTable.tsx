import {
  formatSetCount,
  toVolumeTable,
  type VolumeColumn,
  type VolumeRowOrder,
  type WeeklyVolume,
} from '@lifting-logbook/core';
import styles from './SetVolumeTable.module.css';

/** One column of a {@link SetVolumeTable}: a heading and the breakdown it shows. */
export interface VolumeTableColumn {
  label: string;
  volume: WeeklyVolume;
}

/**
 * Columns for weeks merged by `collapseIdenticalWeeks`. One column for every week reads
 * "Sets / week"; otherwise each is labelled with its week list ("Weeks 1, 3"), never a range,
 * since merged weeks need not be consecutive.
 */
export function weekColumns(columns: readonly VolumeColumn[]): VolumeTableColumn[] {
  if (columns.length === 1) return [{ label: 'Sets / week', volume: columns[0].volume }];
  return columns.map(({ weeks, volume }) => ({
    label: `${weeks.length === 1 ? 'Week' : 'Weeks'} ${weeks.join(', ')}`,
    volume,
  }));
}

interface Props {
  caption: string;
  /** Heading of the row-label column, such as "Muscle" or "Pattern". */
  rowHeader: string;
  order: VolumeRowOrder;
  columns: readonly VolumeTableColumn[];
}

/**
 * Weekly working sets as a table: a row per muscle group or movement pattern and a column per
 * breakdown (weeks, or Planned and Done). `toVolumeTable` orders the rows and joins keys across
 * columns. Lifts no row counts are listed under "Not counted" rather than dropped.
 */
export default function SetVolumeTable({ caption, rowHeader, order, columns }: Props) {
  const table = toVolumeTable(
    columns.map((column) => column.volume),
    order,
  );

  if (table.rows.length === 0 && table.uncounted.length === 0) {
    return <p className={styles.empty}>{caption}: no working sets.</p>;
  }

  return (
    <table className={styles.table}>
      <caption className={styles.caption}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{rowHeader}</th>
          {columns.map((column) => (
            <th scope="col" key={column.label} className={styles.number}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.key}</th>
            {row.sets.map((sets, i) => (
              <td key={columns[i]?.label ?? i} className={styles.number}>
                {formatSetCount(sets)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {table.uncounted.length > 0 && (
        <tfoot className={styles.uncounted}>
          <tr>
            <th scope="colgroup" colSpan={columns.length + 1}>
              Not counted
            </th>
          </tr>
          {table.uncounted.map((lift) => (
            <tr key={lift.lift}>
              <th scope="row">{lift.lift}</th>
              {lift.sets.map((sets, i) => (
                <td key={columns[i]?.label ?? i} className={styles.number}>
                  {formatSetCount(sets)}
                </td>
              ))}
            </tr>
          ))}
        </tfoot>
      )}
    </table>
  );
}
