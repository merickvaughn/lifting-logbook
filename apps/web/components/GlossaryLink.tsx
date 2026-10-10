import Link from 'next/link';
import { glossaryTerm, type GlossaryTermId } from '@/lib/glossary';
import styles from './GlossaryLink.module.css';

/**
 * A small "?" next to a term that opens its `/glossary` entry. The accessible
 * name spells the question out, since a bare "?" tells a screen-reader user
 * nothing about what it explains.
 */
export default function GlossaryLink({ id }: { id: GlossaryTermId }) {
  const { term } = glossaryTerm(id);
  return (
    <Link
      href={`/glossary#${id}`}
      className={styles.link}
      aria-label={`What does “${term}” mean?`}
      title={`What does “${term}” mean?`}
    >
      ?
    </Link>
  );
}
