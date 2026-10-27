import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field } from './Field';
import { Seg } from './Seg';
import { Select } from './Select';
import { Stepper } from './Stepper';

describe('Seg', () => {
  it('is a radiogroup named by its label, with the value checked', () => {
    render(
      <Seg
        label="Period"
        options={[
          ['quarterly', 'Quarterly'],
          ['monthly', 'Monthly'],
        ]}
        value="monthly"
        onChange={jest.fn()}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Period' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Quarterly' })).toHaveAttribute('aria-checked', 'false');
  });

  it('reports the option clicked', async () => {
    const onChange = jest.fn();
    render(
      <Seg
        label="Period"
        options={[
          ['quarterly', 'Quarterly'],
          ['monthly', 'Monthly'],
        ]}
        value="monthly"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Quarterly' }));
    expect(onChange).toHaveBeenCalledWith('quarterly');
  });
});

describe('Stepper', () => {
  it('shows the formatted value and steps it up and down', async () => {
    const onChange = jest.fn();
    render(<Stepper name="Weight" value={25} step={2.5} format={(v) => `${v} lbs`} onChange={onChange} />);
    expect(screen.getByRole('status', { name: 'Weight' })).toHaveTextContent('25 lbs');
    await userEvent.click(screen.getByRole('button', { name: 'Increase Weight' }));
    expect(onChange).toHaveBeenLastCalledWith(27.5);
    await userEvent.click(screen.getByRole('button', { name: 'Decrease Weight' }));
    expect(onChange).toHaveBeenLastCalledWith(22.5);
  });

  it('clamps to its bounds and disables the button at each end', async () => {
    const onChange = jest.fn();
    const { rerender } = render(<Stepper name="RPE" value={9.5} step={1} min={5} max={10} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Increase RPE' }));
    expect(onChange).toHaveBeenLastCalledWith(10);

    rerender(<Stepper name="RPE" value={10} step={1} min={5} max={10} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Increase RPE' })).toBeDisabled();
    rerender(<Stepper name="RPE" value={5} step={1} min={5} max={10} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Decrease RPE' })).toBeDisabled();
  });

  it('does not drift on fractional steps', async () => {
    const onChange = jest.fn();
    render(<Stepper name="RPE" value={7.1} step={0.1} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Increase RPE' }));
    expect(onChange).toHaveBeenLastCalledWith(7.2);
  });
});

describe('Select', () => {
  it('lists plain and labelled options and reports the value chosen', async () => {
    const onChange = jest.fn();
    render(
      <Select label="Include" value="auto" options={[['auto', 'Follows selection'], 'off']} onChange={onChange} />,
    );
    const select = screen.getByRole('combobox', { name: 'Include' });
    expect(screen.getByRole('option', { name: 'Follows selection' })).toHaveValue('auto');
    await userEvent.selectOptions(select, 'off');
    expect(onChange).toHaveBeenCalledWith('off');
  });
});

describe('Field', () => {
  it('names its group by the label and describes it by the hint', () => {
    render(
      <Field label="Extra sets per day" hint="Advisory.">
        <span>control</span>
      </Field>,
    );
    const group = screen.getByRole('group', { name: 'Extra sets per day' });
    expect(group).toHaveAccessibleDescription('Advisory.');
  });

  it('has no description without a hint', () => {
    render(
      <Field label="Area">
        <span>control</span>
      </Field>,
    );
    expect(screen.getByRole('group', { name: 'Area' })).not.toHaveAttribute('aria-describedby');
  });
});
