import { BadRequestException, Logger } from '@nestjs/common';
import { LiftModification, LiftModificationMaxMode } from '@lifting-logbook/types';
import { RepositoryBundle } from '../ports/factory';
import {
  assertSetModifications,
  modificationLiftIds,
  modificationModesFor,
  modificationNamesFor,
} from './lift-modification.util';

const CUSTOM_CURL = { id: 'custom-curl', name: 'Cable Curl' };

function modification(id: string, lift: string, maxMode: LiftModificationMaxMode = 'none'): LiftModification {
  return { id, userId: 'u', lift, name: `${id} name`, description: '', maxMode, archivedAt: null, createdAt: new Date() };
}

function repos(modifications: LiftModification[], customLifts: { id: string; name: string }[] = []) {
  return {
    customLift: { list: jest.fn().mockResolvedValue(customLifts) },
    liftModification: { list: jest.fn().mockResolvedValue(modifications) },
  } as unknown as Pick<RepositoryBundle, 'customLift' | 'liftModification'>;
}

describe('modificationLiftIds', () => {
  it('is the built-in alone under any spelling, with no custom lift', () => {
    for (const name of ['Cable Curl', 'cable-curl', 'Cable Curls']) {
      expect([...modificationLiftIds(name, [])]).toEqual(['cable-curl']);
    }
  });

  it('reaches both lifts under every spelling when a custom lift shares the catalog name', () => {
    for (const name of ['Cable Curl', 'cable-curl', 'Cable Curls']) {
      expect([...modificationLiftIds(name, [CUSTOM_CURL])].sort()).toEqual(['cable-curl', 'custom-curl']);
    }
  });

  it('is the custom lift alone for a name the catalog does not have, and empty for an unknown name', () => {
    const custom = { id: 'custom-sbs', name: 'Safety Bar Squat' };
    expect([...modificationLiftIds('Safety Bar Squat', [custom])]).toEqual(['custom-sbs']);
    expect([...modificationLiftIds('custom-sbs', [custom])]).toEqual(['custom-sbs']);
    expect(modificationLiftIds('Nothing', [custom]).size).toBe(0);
  });
});

describe('assertSetModifications', () => {
  it('reads nothing when there are no ids', async () => {
    const bundle = repos([]);
    await expect(assertSetModifications(bundle, 'Squat', [])).resolves.toEqual(new Map());
    expect(bundle.liftModification.list).not.toHaveBeenCalled();
  });

  it('attaches a modification stored under the custom lift to a set logged under the built-in, and the reverse', async () => {
    const bundle = repos([modification('on-custom', 'custom-curl'), modification('on-built-in', 'cable-curl')], [CUSTOM_CURL]);
    await expect(assertSetModifications(bundle, 'cable-curl', ['on-custom'])).resolves.toBeDefined();
    await expect(assertSetModifications(bundle, 'Cable Curl', ['on-built-in'])).resolves.toBeDefined();
  });

  it('returns the names of the modifications, for the response', async () => {
    const names = await assertSetModifications(repos([modification('a', 'bench-press')]), 'Bench Press', ['a']);
    expect(names.get('a')).toBe('a name');
  });

  it('lets an id the set already has stay when its lift no longer resolves, but no new one', async () => {
    const bundle = repos([modification('kept', 'custom-old'), modification('new', 'custom-old')]);
    await expect(assertSetModifications(bundle, 'Old Name', ['kept'], ['kept'])).resolves.toBeDefined();
    await expect(assertSetModifications(bundle, 'Old Name', ['kept', 'new'], ['kept'])).rejects.toThrow(BadRequestException);
  });

  it('still applies the `own` rule to ids the set already has', async () => {
    const bundle = repos([modification('a', 'squat', 'own'), modification('b', 'squat', 'own')]);
    await expect(assertSetModifications(bundle, 'Squat', ['a', 'b'], ['a', 'b'])).rejects.toThrow(BadRequestException);
  });

  it('rejects an id with no row even if the set already has it', async () => {
    await expect(assertSetModifications(repos([]), 'Squat', ['gone'], ['gone'])).rejects.toThrow(BadRequestException);
  });
});

describe('modificationModesFor', () => {
  it('reads nothing when no record has any', async () => {
    const bundle = repos([]);
    await expect(modificationModesFor(bundle, [{}, { modifications: [] }])).resolves.toEqual(new Map());
    expect(bundle.liftModification.list).not.toHaveBeenCalled();
  });

  it('maps each id to its mode, archived ones included, and logs an id with no row', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const archived = { ...modification('b', 'squat', 'lift'), archivedAt: new Date() };
    const modes = await modificationModesFor(repos([modification('a', 'squat', 'own'), archived]), [
      { modifications: ['a', 'gone'] },
      { modifications: ['b'] },
    ]);
    expect(modes).toEqual(new Map([['a', 'own'], ['b', 'lift']]));
    expect(warn).toHaveBeenCalledWith({ missing: ['gone'] }, expect.any(String));
    warn.mockRestore();
  });
});

describe('modificationNamesFor', () => {
  it('reads nothing when no record has any', async () => {
    const bundle = repos([]);
    await expect(modificationNamesFor(bundle, [{}, { modifications: [] }])).resolves.toEqual(new Map());
    expect(bundle.liftModification.list).not.toHaveBeenCalled();
  });

  it('logs an id with no row, by id only, and still names the rest', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const names = await modificationNamesFor(repos([modification('a', 'squat')]), [{ modifications: ['a', 'gone'] }]);
    expect(names).toEqual(new Map([['a', 'a name']]));
    expect(warn).toHaveBeenCalledWith({ missing: ['gone'] }, expect.any(String));
    warn.mockRestore();
  });
});
