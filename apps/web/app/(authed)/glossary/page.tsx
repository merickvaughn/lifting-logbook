import type { Metadata } from 'next';
import { GLOSSARY } from '@/lib/glossary';
import TargetHighlight from './TargetHighlight';
import styles from './glossary.module.css';

export const metadata: Metadata = {
  title: 'Glossary — Lifting Logbook',
  description:
    'What macrocycle, mesocycle, training max and the other terms in this app mean — and what the same words mean elsewhere.',
};

/**
 * The in-app glossary (`/glossary`). Static — no data fetch — so it renders
 * regardless of API state. Each term's `id` is an anchor that `GlossaryLink`
 * targets from headings across the app; the content lives in `lib/glossary.ts`.
 */
export default function GlossaryPage() {
  return (
    <main className={styles.page}>
      <TargetHighlight />
      <h1 className={styles.title}>Glossary</h1>
      {GLOSSARY.map((section) => (
        <section
          key={section.id}
          aria-labelledby={`${section.id}-heading`}
          className={styles.section}
        >
          <h2 id={`${section.id}-heading`} className={styles.sectionHeading}>
            {section.title}
          </h2>
          {'intro' in section && <p className={styles.intro}>{section.intro}</p>}
          <dl className={styles.terms}>
            {section.terms.map((t) => (
              <div key={t.id} id={t.id} className={styles.entry}>
                <dt className={styles.term}>
                  {t.term}
                  {'aka' in t && (
                    <span className={styles.aka}> (also: {t.aka.join(', ')})</span>
                  )}
                </dt>
                <dd className={styles.definition}>
                  <p>{t.definition}</p>
                  {'otherMeanings' in t && (
                    <>
                      <p className={styles.otherHeading}>Elsewhere:</p>
                      <ul className={styles.otherList}>
                        {t.otherMeanings.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </main>
  );
}
