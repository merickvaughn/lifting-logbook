import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchMacrocycleDashboard: jest.fn().mockResolvedValue(null),
  fetchProgramSpec: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));
jest.mock('@/lib/active-program', () => ({ getActiveProgram: jest.fn().mockResolvedValue('custom-1') }));
jest.mock('@/lib/preferences', () => ({ getPreferredUnit: jest.fn().mockResolvedValue('lbs') }));

// Echo the lifts the page offers focus rules.
jest.mock('./FocusSetup', () => ({
  __esModule: true,
  default: ({ programLifts }: { programLifts: string[] }) => <div data-lifts={JSON.stringify(programLifts)} />,
}));

import { fetchCustomLifts, fetchProgramSpec } from '@/lib/api';
import FocusPage from './page';

const row = (lift: string) => ({ week: 1, offset: 0, lift, order: 1, increment: 5, sets: 3, reps: 5, amrap: false, warmUpPct: '', wtDecrementPct: 0, activation: '' });

describe('FocusPage — program lifts', () => {
  it('names a custom lift by its name and leaves a complex row out (#1495)', async () => {
    jest.mocked(fetchProgramSpec).mockResolvedValue([row('Squat'), row('custom-uuid'), row('complex:c-bear')]);
    jest.mocked(fetchCustomLifts).mockResolvedValue([
      {
        id: 'custom-uuid',
        name: 'Belt Squat',
        classification: 'accessory',
        movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
        isBodyweightComponent: false,
        isCustom: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const html = renderToStaticMarkup((await FocusPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    const encoded = html.match(/data-lifts="([^"]*)"/)?.[1];
    if (encoded === undefined) throw new Error('data-lifts attribute not found');

    expect(JSON.parse(encoded.replace(/&quot;/g, '"'))).toEqual(['Squat', 'Belt Squat']);
  });
});
