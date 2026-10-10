import { act, render, screen, within } from '@testing-library/react';
import { GLOSSARY, GLOSSARY_TERMS } from '@/lib/glossary';
import GlossaryPage from './page';

describe('Glossary page', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('renders one labelled region per section', () => {
    render(<GlossaryPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Glossary' })).toBeInTheDocument();
    for (const section of GLOSSARY) {
      expect(screen.getByRole('region', { name: section.title })).toBeInTheDocument();
    }
  });

  it('renders every term at its anchor id, with its definition', () => {
    const { container } = render(<GlossaryPage />);
    for (const t of GLOSSARY_TERMS) {
      const entry = container.querySelector(`#${t.id}`);
      expect(entry).not.toBeNull();
      expect(entry).toHaveTextContent(t.term);
      expect(entry).toHaveTextContent(t.definition);
    }
  });

  it('lists the other meanings of an overloaded term', () => {
    const { container } = render(<GlossaryPage />);
    const cycle = container.querySelector('#cycle') as HTMLElement;
    const items = within(cycle).getAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(cycle).toHaveTextContent(/5\/3\/1/);
  });

  // A GlossaryLink click is a soft navigation: the URL changes via pushState,
  // which never updates CSS :target, so the page marks the entry itself.
  it('marks the entry named by a pushState hash, which :target would miss', () => {
    window.history.pushState(null, '', '/glossary#mesocycle');
    const { container } = render(<GlossaryPage />);
    expect(container.querySelector('#mesocycle')).toHaveAttribute('data-targeted', 'true');
    expect(container.querySelectorAll('[data-targeted]')).toHaveLength(1);
  });

  it('moves the mark when the hash changes', () => {
    window.history.pushState(null, '', '/glossary#mesocycle');
    const { container } = render(<GlossaryPage />);
    act(() => {
      window.history.pushState(null, '', '/glossary#training-max');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.querySelector('#training-max')).toHaveAttribute('data-targeted', 'true');
    expect(container.querySelector('#mesocycle')).not.toHaveAttribute('data-targeted');
  });

  it('marks nothing without a hash', () => {
    const { container } = render(<GlossaryPage />);
    expect(container.querySelectorAll('[data-targeted]')).toHaveLength(0);
  });
});
