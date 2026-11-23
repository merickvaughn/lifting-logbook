'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADVISORY_INGREDIENTS, itemIngredients, supplementSourceUrl } from '@lifting-logbook/core';
import type { SupplementItem } from '@lifting-logbook/types';
import { localToday } from '@/lib/calendarDay';
import { updateSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import {
  ingredientName,
  linkHost,
  NO_DAY_TYPE,
  overlapRows,
  placementText,
  storeName,
  suggestedSearch,
  SLOT_LABEL,
  num,
  type AdvisoryNote,
  type Stack,
} from '@/lib/supplementsView';
import styles from './supplements.module.css';

const EVIDENCE_LABEL = { strong: 'Strong evidence', moderate: 'Moderate evidence', limited: 'Limited evidence' } as const;

interface Props {
  stack: Stack;
  item: SupplementItem;
  dayTypeId: string;
  notes: AdvisoryNote[];
  onClose: () => void;
  /** Opens the item's Edit form above this panel. */
  onEdit: () => void;
  /** Opens the Add form preset from this item, offering to replace it (#1411). */
  onReplace: () => void;
}

/** The detail panel: a native modal `<dialog>`, so the browser traps focus and closes it on Esc. */
export default function SupplementDetail({ stack, item, dayTypeId, notes, onClose, onEdit, onReplace }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirmFailed, setConfirmFailed] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const dayType = stack.dayTypes.find((d) => d.id === dayTypeId) ?? (stack.dayTypes.length === 0 ? NO_DAY_TYPE : undefined);
  const reference = item.reference;
  const suggestion = suggestedSearch(stack, item);
  const slots = [...new Set(item.doses.map((d) => SLOT_LABEL[d.slot]))].join(' · ');
  const ingredients = itemIngredients(item);
  const overlaps = overlapRows(stack, item, dayTypeId);
  const protein = ingredients.filter((i) => i.key === 'protein').reduce((n, i) => n + i.amount, 0);


  async function keep() {
    if (!suggestion) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await updateSupplementItem(item.id, { links: [{ label: '', url: suggestion.url }] }, localToday());
      router.refresh();
    } catch (err) {
      logClientError('supplements.keepLink', err, { itemId: item.id });
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  /** Counts the item: it was saved unverified, and the lifter has now checked it against their label (#1381). */
  async function confirm() {
    setSaving(true);
    setConfirmFailed(false);
    try {
      await updateSupplementItem(item.id, { unverified: false }, localToday());
      router.refresh();
    } catch (err) {
      logClientError('supplements.confirmItem', err, { itemId: item.id });
      setConfirmFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="supp-detail-title"
      // `close` follows Esc and the native close alike; `cancel` alone would miss `dialog.close()`.
      onClose={onClose}
    >
      <header className={styles.dialogHeader}>
        <div>
          <h2 id="supp-detail-title">{item.name}</h2>
          {(item.category || slots) && <p className={styles.muted}>{item.category || slots}</p>}
        </div>
        <div>
          <button type="button" onClick={onReplace}>
            Replace with…
          </button>
          <button type="button" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className={styles.close} aria-label="Close" onClick={() => ref.current?.close()}>
            ×
          </button>
        </div>
      </header>

      {item.unverified && (
        <section>
          <p className={styles.aiBanner}>
            <span className={styles.aiTag}>AI · unverified</span> Not counted in your totals, protein or advisories until you confirm it
            against the product’s label.
          </p>
          <button type="button" disabled={saving} onClick={() => void confirm()}>
            Confirm
          </button>
          {confirmFailed && <p role="alert">Couldn’t confirm the item. Try again.</p>}
        </section>
      )}

      {notes.length > 0 && (
        <section>
          <h3 className={styles.sectionHeading}>Worth a look</h3>
          {notes.map((n) => (
            <p key={n.rule} className={styles.callout}>
              <strong>{n.line}.</strong> {n.explanation}
            </p>
          ))}
        </section>
      )}

      <section>
        <h3 className={styles.sectionHeading}>How you take it</h3>
        <dl className={styles.facts}>
          {item.keyCompound && (
            <>
              <dt>Key compound</dt>
              <dd>{item.keyCompound}</dd>
            </>
          )}
          <dt>Dose</dt>
          <dd>
            {item.doses.length === 0 && <em>no dose yet</em>}
            {item.doses.map((d, i) => (
              <div key={i}>
                {d.amount.trim() ? d.amount : <em>no amount yet</em>} · {placementText(d, stack.dayTypes)}
              </div>
            ))}
          </dd>
          <dt>Timing</dt>
          <dd>{item.timing.trim() || '—'}</dd>
          {protein > 0 && (
            <>
              <dt>Protein</dt>
              <dd>{num(protein)} g per serving</dd>
            </>
          )}
          {item.shortNote && (
            <>
              <dt>Note</dt>
              <dd className={styles.line3}>{item.shortNote}</dd>
            </>
          )}
        </dl>
      </section>

      <section>
        <h3 className={styles.sectionHeading}>Where to buy</h3>
        {item.links.map((link, n) => {
          const host = linkHost(link.url);
          return host ? (
            <p key={n} className={styles.buyRow}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label || storeName(host)} ↗
              </a>
              <span className={styles.muted}>{host}</span>
            </p>
          ) : (
            <p key={n} className={styles.buyRow}>
              {link.url}
            </p>
          );
        })}
        {suggestion && (
          <>
            <p className={styles.buyRow}>
              <a href={suggestion.url} target="_blank" rel="noopener noreferrer">
                Search {suggestion.store} ↗
              </a>
              <span className={styles.pill}>suggested</span>
              <button type="button" disabled={saving} onClick={keep}>
                Keep
              </button>
            </p>
            <p className={styles.muted}>
              No link saved yet, so this searches the store you usually use. Keep it, or edit the item to paste the exact product.
            </p>
            {saveFailed && <p role="alert">Couldn’t save the link. Try again.</p>}
          </>
        )}
        {item.links.length === 0 && !suggestion && <p className={styles.muted}>No link saved.</p>}
      </section>

      {item.longNote && <p>{item.longNote}</p>}

      <section>
        <h3 className={styles.sectionHeading}>{ingredients.some((i) => i.key === 'protein') ? 'Nutrition facts' : 'Supplement facts'}</h3>
        {ingredients.length === 0 ? (
          <p className={styles.muted}>No label entered yet.</p>
        ) : (
          <>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Ingredient</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map((i, n) => {
                  // Tint the ingredients an advisory on this item reads.
                  const feeds = notes.some((n) => ADVISORY_INGREDIENTS[n.rule].includes(i.key));
                  return (
                    <tr key={n} className={feeds ? styles.flaggedCell : undefined}>
                      <td>{ingredientName(i.key)}</td>
                      <td>
                        {num(i.amount)} {i.unit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className={styles.muted}>
              Highlighted rows feed advisories. Formulas change between batches and flavors, so check your tub.
            </p>
          </>
        )}
      </section>

      {overlaps.length > 0 && dayType && (
        <section>
          <h3 className={styles.sectionHeading}>Overlaps · {dayType.name}</h3>
          <p className={styles.muted}>
            Day total = everything you take {dayType === NO_DAY_TYPE ? 'in a day' : `on a ${dayType.name.toLowerCase()}`}.
          </p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Ingredient</th>
                <th scope="col">This item</th>
                <th scope="col">Day total</th>
              </tr>
            </thead>
            <tbody>
              {overlaps.map((o) => (
                <tr key={o.key}>
                  <td>
                    {o.name}
                    <div className={styles.muted}>Also from {o.others}</div>
                  </td>
                  <td>{o.thisItem}</td>
                  <td>
                    <strong>{o.dayTotal}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {reference && (
        <>
          <section>
            <h3 className={styles.sectionHeading}>Why athletes take it</h3>
            <ul>
              {reference.uses.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className={styles.sectionHeading}>Evidence</h3>
            <p>
              <span className={reference.evidence.level === 'strong' ? `${styles.pill} ${styles.pillStrong}` : styles.pill}>
                {EVIDENCE_LABEL[reference.evidence.level]}
              </span>{' '}
              {reference.evidence.reason}
            </p>
          </section>
          {reference.cautions.length > 0 && (
            <section>
              <h3 className={styles.sectionHeading}>Good to know</h3>
              <ul>
                {reference.cautions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className={styles.sectionHeading}>Sources</h3>
            <ol>
              {reference.sources.flatMap((key) => {
                const url = supplementSourceUrl(key);
                return url ? (
                  <li key={key}>
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {url.replace(/^https?:\/\//, '')}
                    </a>
                  </li>
                ) : [];
              })}
            </ol>
          </section>
        </>
      )}
    </dialog>
  );
}
