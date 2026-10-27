import { render, screen } from '@testing-library/react';
import AppNav from './AppNav';

jest.mock('next/navigation', () => ({
  usePathname: jest.fn(),
}));

import { usePathname } from 'next/navigation';

const mockedUsePathname = usePathname as unknown as jest.Mock;

describe('AppNav', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the brand home-link and the five primary links', () => {
    mockedUsePathname.mockReturnValue('/macrocycle/1');
    render(<AppNav />);

    expect(screen.getByRole('link', { name: 'Lifting Logbook' })).toHaveAttribute('href', '/macrocycle');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/history');
    expect(screen.getByRole('link', { name: 'Programs' })).toHaveAttribute('href', '/programs');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
    expect(screen.getByRole('link', { name: 'Glossary' })).toHaveAttribute('href', '/glossary');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('marks the active section with aria-current for any sub-route', () => {
    // Settings is active for the whole /settings/* subtree, not just the linked page.
    mockedUsePathname.mockReturnValue('/settings/weight-rounding');
    render(<AppNav />);

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'History' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Programs' })).not.toHaveAttribute('aria-current');
  });

  it('renders nothing during the onboarding flow', () => {
    mockedUsePathname.mockReturnValue('/onboarding');
    const { container } = render(<AppNav />);
    expect(container).toBeEmptyDOMElement();
  });
});
