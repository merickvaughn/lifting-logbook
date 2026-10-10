jest.mock('@/lib/api', () => ({
  switchProgram: jest.fn(),
  updateTrainingMaxes: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { switchProgram, updateTrainingMaxes } from '@/lib/api';
import { createFirstMacrocycle } from './actions';

const mockedSwitchProgram = switchProgram as unknown as jest.Mock;
const mockedUpdateTrainingMaxes = updateTrainingMaxes as unknown as jest.Mock;

describe('createFirstMacrocycle', () => {
  beforeEach(() => jest.clearAllMocks());

  // Regression test for #650: completing onboarding must set activeProgram (via
  // switchProgram), not just create the macrocycle — otherwise the dashboard page's
  // getActiveProgram() lookup resolves to the wrong program and 404s even though
  // the macrocycle was created successfully.
  it('redirects to /macrocycle/1 using the macrocycleNum switchProgram returns (genuine first-time setup)', async () => {
    mockedSwitchProgram.mockResolvedValue({ activeProgram: 'leangains', macrocycleNum: 1 });

    await expect(createFirstMacrocycle('leangains', [])).rejects.toThrow('REDIRECT:/macrocycle/1');
    expect(mockedSwitchProgram).toHaveBeenCalledWith('leangains');
  });

  // Proves the redirect target is not hardcoded — switchProgram returns the
  // existing macrocycleNum when a macrocycle already exists, and the redirect must follow it.
  it('redirects to the returned macrocycleNum, not a hardcoded /macrocycle/1', async () => {
    mockedSwitchProgram.mockResolvedValue({ activeProgram: 'leangains', macrocycleNum: 3 });

    await expect(createFirstMacrocycle('leangains', [])).rejects.toThrow('REDIRECT:/macrocycle/3');
  });

  it('persists confirmed training maxes after switchProgram succeeds', async () => {
    mockedSwitchProgram.mockResolvedValue({ activeProgram: 'leangains', macrocycleNum: 1 });
    mockedUpdateTrainingMaxes.mockResolvedValue(undefined);

    await expect(
      createFirstMacrocycle('leangains', [{ lift: 'Squat', trainingMax: 315 }]),
    ).rejects.toThrow('REDIRECT:/macrocycle/1');

    expect(mockedUpdateTrainingMaxes).toHaveBeenCalledWith('leangains', {
      maxes: [{ lift: 'Squat', weight: 315, unit: 'lbs' }],
    });
  });

  it('rejects a program that is not available', async () => {
    const result = await createFirstMacrocycle('not-a-real-program', []);

    expect(result).toEqual({ ok: false, error: 'That program is not yet available.' });
    expect(mockedSwitchProgram).not.toHaveBeenCalled();
  });

  it('returns a generic error and does not redirect when switchProgram fails', async () => {
    mockedSwitchProgram.mockRejectedValue(new Error('API down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await createFirstMacrocycle('leangains', []);

    expect(result).toEqual({
      ok: false,
      error: 'Failed to start your program. Please try again.',
    });
    errSpy.mockRestore();
  });
});
