import { render, screen, within } from '@testing-library/react';
import { GLOSSARY, GLOSSARY_TERMS } from '@/lib/glossary';
import GlossaryPage from './page';

describe('Glossary page', () => {
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
});
