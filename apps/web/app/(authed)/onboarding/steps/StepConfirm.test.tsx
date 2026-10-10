import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StepConfirm } from './StepConfirm';

const BASE_PROPS = {
  onConfirm: () => {},
  isPending: false,
};

describe('StepConfirm — 1RM-derived methods', () => {
  it('shows the 1RM with the derived training max alongside it', () => {
    render(
      <StepConfirm
        {...BASE_PROPS}
        method="estimate"
        maxes={[{ lift: 'Squat', oneRm: 225, trainingMax: 203 }]}
      />,
    );
    expect(screen.getByText('Squat')).toBeInTheDocument();
    // Both the 1RM and the derived TM are shown.
    expect(screen.getByText(/225 lb/)).toBeInTheDocument();
    expect(screen.getByText(/TM 203 lb/)).toBeInTheDocument();
    expect(screen.getByText(/90% of the 1RM/i)).toBeInTheDocument();
  });
});

describe('StepConfirm — training-max method', () => {
  it('shows the entered training max as-is with no 1RM or 90% note', () => {
    render(
      <StepConfirm
        {...BASE_PROPS}
        method="tm"
        maxes={[{ lift: 'Squat', oneRm: null, trainingMax: 315 }]}
      />,
    );
    expect(screen.getByText('Squat')).toBeInTheDocument();
    expect(screen.getByText(/TM 315 lb/)).toBeInTheDocument();
    // No 1RM value and no 90% derivation copy for a direct training max.
    expect(screen.queryByText(/90% of the 1RM/i)).not.toBeInTheDocument();
    expect(screen.getByText(/as entered/i)).toBeInTheDocument();
  });
});

describe('StepConfirm — submit action', () => {
  it('renders the "Start My Program" button and calls onConfirm when clicked', async () => {
    const user = userEvent.setup();
    const handleConfirm = jest.fn();
    render(
      <StepConfirm
        method="estimate"
        maxes={[{ lift: 'Squat', oneRm: 225, trainingMax: 203 }]}
        onConfirm={handleConfirm}
        isPending={false}
      />,
    );

    const btn = screen.getByRole('button', { name: /start my program/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();

    await user.click(btn);
    expect(handleConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows "Starting…" and disables the button when isPending is true', () => {
    render(
      <StepConfirm
        method="estimate"
        maxes={[{ lift: 'Squat', oneRm: 225, trainingMax: 203 }]}
        onConfirm={() => {}}
        isPending={true}
      />,
    );

    const btn = screen.getByRole('button', { name: /starting/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Starting…');
  });

  it('shows a macrocycleError alert when provided', () => {
    render(
      <StepConfirm
        method="estimate"
        maxes={[{ lift: 'Squat', oneRm: 225, trainingMax: 203 }]}
        onConfirm={() => {}}
        isPending={false}
        macrocycleError="Something went wrong"
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
  });
});
