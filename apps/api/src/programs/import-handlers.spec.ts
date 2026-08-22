import { IMPORT_HANDLERS } from './import-handlers';

// #911 review (second pass): IMPORT_HANDLERS['lift-records'].validate is a
// deliberate throw, not a working implementation — ImportController.commit
// special-cases 'lift-records' to validate against a custom-lift-aware slot
// map (effectiveSlotMapFor) instead of ever calling this closure. That
// invariant previously had no direct test, only a code comment — a future
// refactor that accidentally routed 'lift-records' through the generic
// handler.validate(parsed) path would regress silently in production (a
// runtime 500 on a real import) rather than failing a test. This asserts the
// throw directly, so removing/changing it without updating the caller fails
// here first.
describe('IMPORT_HANDLERS.lift-records.validate', () => {
  it('throws rather than silently falling back to DEFAULT_SLOT_MAP', () => {
    const handler = IMPORT_HANDLERS['lift-records'];
    expect(() => handler.validate([])).toThrow(
      /must not be called directly/,
    );
  });
});

// #914: training-maxes and strength-goals now get the same custom-lift-aware
// slot map treatment as lift-records above — validateTrainingMaxImport and
// validateStrengthGoalImport both default their `slotMap` parameter to
// DEFAULT_SLOT_MAP, so unlike liftRecordsHandler.validate (which requires a
// slotMap argument and therefore couldn't be assigned directly),
// IMPORT_HANDLERS['training-maxes'].validate / ['strength-goals'].validate
// COULD have been left as working-but-wrong single-arg-callable references.
// Asserting the throw directly means a future refactor that routes either
// destination through the generic handler.validate(parsed) path fails here
// first, rather than silently reintroducing this issue's bug.
describe('IMPORT_HANDLERS.training-maxes.validate', () => {
  it('throws rather than silently falling back to DEFAULT_SLOT_MAP', () => {
    const handler = IMPORT_HANDLERS['training-maxes'];
    expect(() => handler.validate([])).toThrow(
      /must not be called directly/,
    );
  });
});

describe('IMPORT_HANDLERS.strength-goals.validate', () => {
  it('throws rather than silently falling back to DEFAULT_SLOT_MAP', () => {
    const handler = IMPORT_HANDLERS['strength-goals'];
    expect(() => handler.validate([])).toThrow(
      /must not be called directly/,
    );
  });
});
