import { render } from '@testing-library/react';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import TimeZoneCookie from './TimeZoneCookie';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function clearZoneCookie() {
  document.cookie = 'tz=; path=/; max-age=0';
}

beforeEach(() => {
  refresh.mockClear();
  clearZoneCookie();
});

afterAll(clearZoneCookie);

describe('TimeZoneCookie', () => {
  it('records the browser time zone and re-renders the page with it', () => {
    render(<TimeZoneCookie />);
    expect(document.cookie).toContain(`tz=${zone}`);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the cookie already holds the browser time zone', () => {
    document.cookie = `tz=${zone}; path=/`;
    render(<TimeZoneCookie />);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('replaces a stale zone, as after travelling', () => {
    document.cookie = 'tz=Not/TheBrowserZone; path=/';
    render(<TimeZoneCookie />);
    expect(document.cookie).toContain(`tz=${zone}`);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
