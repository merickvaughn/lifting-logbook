import fs from 'node:fs';
import path from 'node:path';
import { GLOSSARY, GLOSSARY_TERMS, glossaryTerm } from '../glossary';

describe('glossary data', () => {
  it('gives every term a unique anchor id', () => {
    const ids = GLOSSARY_TERMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Section ids share the page's id namespace (`<id>-heading`), so no term may
    // collide with one either.
    const sectionHeadingIds = GLOSSARY.map((s) => `${s.id}-heading`);
    expect(ids.filter((id) => sectionHeadingIds.includes(id))).toEqual([]);
  });

  it('uses URL-fragment-safe ids', () => {
    for (const { id } of GLOSSARY_TERMS) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('defines the time-structure hierarchy the app labels use', () => {
    for (const id of ['macrocycle', 'mesocycle', 'microcycle', 'workout'] as const) {
      expect(glossaryTerm(id).definition.length).toBeGreaterThan(0);
    }
  });

  it('explains every overloaded term with at least two other meanings', () => {
    const cycle = glossaryTerm('cycle');
    const wave = glossaryTerm('wave');
    expect(cycle.otherMeanings?.length).toBeGreaterThanOrEqual(2);
    expect(wave.otherMeanings?.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves every <GlossaryLink id> used in the app to a defined term', () => {
    // GlossaryTermId already makes an unknown id a type error; this guards the
    // transpile-only Jest path and any id passed through a computed expression.
    const root = path.resolve(__dirname, '..', '..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          sources.push(fs.readFileSync(full, 'utf8'));
        }
      }
    };
    walk(path.join(root, 'app'));
    walk(path.join(root, 'components'));

    const known = new Set(GLOSSARY_TERMS.map((t) => t.id));
    const used = sources.flatMap((src) =>
      [...src.matchAll(/<GlossaryLink[^>]*?id=(?:"([^"]+)"|\{([^}]+)\})/g)].flatMap((m) =>
        m[1] ? [m[1]] : [...(m[2] ?? '').matchAll(/'([^']+)'/g)].flatMap((q) => (q[1] ? [q[1]] : [])),
      ),
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((id) => !known.has(id))).toEqual([]);
  });
});
