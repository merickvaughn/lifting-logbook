import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CatalogTagPicker from './CatalogTagPicker';

function Harness({ initial = [], options }: { initial?: string[]; options?: readonly string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="picker">Tags</label>
      <CatalogTagPicker id="picker" value={value} onChange={setValue} options={options} />
    </>
  );
}

describe('CatalogTagPicker', () => {
  it('searches the lift catalog by default', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByLabelText('Tags')).toHaveAttribute('placeholder', 'Search lifts…');
    await user.type(screen.getByLabelText('Tags'), 'back squ');
    expect(screen.getByRole('option', { name: 'Back Squat' })).toBeInTheDocument();
  });

  // #1017: the lift editor's muscle pickers pass the muscle vocabulary.
  it('searches only the options it is given', async () => {
    const user = userEvent.setup();
    render(<Harness options={['Quads', 'Glutes']} />);
    await user.type(screen.getByLabelText('Tags'), 'u');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Quads', 'Glutes']);

    await user.click(screen.getByRole('option', { name: 'Glutes' }));
    expect(screen.getByRole('button', { name: 'Remove Glutes' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Tags'), 'u');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Quads']);
  });

  it('still shows and removes a value outside its options', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['posterior chain']} options={['Quads']} />);
    await user.click(screen.getByRole('button', { name: 'Remove posterior chain' }));
    expect(screen.queryByRole('button', { name: 'Remove posterior chain' })).not.toBeInTheDocument();
  });
});
