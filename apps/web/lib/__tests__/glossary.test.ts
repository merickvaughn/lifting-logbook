import { GLOSSARY, GLOSSARY_TERMS, glossaryTerm } from '../glossary';

// Every <GlossaryLink id> resolving to a defined term is enforced by the compiler:
// `id` is typed GlossaryTermId, derived from GLOSSARY, and `npm run typecheck` is a
// blocking CI gate. No runtime scan of call sites is needed.
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

});
