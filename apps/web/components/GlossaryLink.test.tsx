import { render, screen } from '@testing-library/react';
import GlossaryLink from './GlossaryLink';

describe('GlossaryLink', () => {
  it('links to the term anchor on /glossary with a descriptive accessible name', () => {
    render(<GlossaryLink id="mesocycle" />);
    const link = screen.getByRole('link', { name: 'What does “Mesocycle” mean?' });
    expect(link).toHaveAttribute('href', '/glossary#mesocycle');
    expect(link).toHaveTextContent('?');
  });
});
