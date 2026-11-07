import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { APP_NAV_TOOLS_ID } from '@/lib/app-nav-tools';
import WorkoutLayout from './layout';

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('kg'),
}));

describe('workout layout', () => {
  it('gives its views the calculator, in the preferred unit', async () => {
    render(
      <>
        <div id={APP_NAV_TOOLS_ID} />
        {await WorkoutLayout({ children: <p>the view</p> })}
      </>,
    );
    expect(screen.getByText('the view')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rep max calculator' }));
    expect(screen.getByLabelText('Weight (kg)')).toBeInTheDocument();
  });
});
