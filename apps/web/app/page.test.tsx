import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import Home from './page';

jest.mock('@clerk/nextjs/server', () => ({
  auth: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

const mockedAuth = auth as unknown as jest.Mock;
const mockedRedirect = redirect as unknown as jest.Mock;

describe('root page — signed-in redirect', () => {
  const originalDevToken = process.env.DEV_AUTH_TOKEN;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEV_AUTH_TOKEN;
    (process.env as Record<string, string>).NODE_ENV = 'test';
  });

  afterAll(() => {
    if (originalDevToken === undefined) {
      delete process.env.DEV_AUTH_TOKEN;
    } else {
      process.env.DEV_AUTH_TOKEN = originalDevToken;
    }
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  it('redirects signed-in users to /macrocycle', async () => {
    mockedAuth.mockResolvedValue({ userId: 'user_123' });

    await expect(Home()).rejects.toThrow('REDIRECT:/macrocycle');
    expect(mockedRedirect).toHaveBeenCalledWith('/macrocycle');
  });

  it('renders the marketing card for unauthenticated visitors', async () => {
    mockedAuth.mockResolvedValue({ userId: null });

    const element = (await Home()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(mockedRedirect).not.toHaveBeenCalled();
    expect(html).toContain('Lifting Logbook');
    expect(html).toContain('Get Started');
  });

  it('bypasses Clerk in non-production when DEV_AUTH_TOKEN is set', async () => {
    process.env.DEV_AUTH_TOKEN = 'dev-token';

    const element = (await Home()) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(mockedAuth).not.toHaveBeenCalled();
    expect(mockedRedirect).not.toHaveBeenCalled();
    expect(html).toContain('Lifting Logbook');
  });

  it('ignores DEV_AUTH_TOKEN in production and still calls auth()', async () => {
    process.env.DEV_AUTH_TOKEN = 'leaked-into-prod';
    (process.env as Record<string, string>).NODE_ENV = 'production';
    mockedAuth.mockResolvedValue({ userId: 'user_123' });

    await expect(Home()).rejects.toThrow('REDIRECT:/macrocycle');
    expect(mockedAuth).toHaveBeenCalled();
    expect(mockedRedirect).toHaveBeenCalledWith('/macrocycle');
  });
});
