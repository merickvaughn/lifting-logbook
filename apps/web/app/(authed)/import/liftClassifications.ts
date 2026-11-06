import type { LiftClassification } from '@lifting-logbook/types';

// Exhaustive BY CONSTRUCTION (issue #911 review) — LIFT_CLASSIFICATION_LABELS
// is typed Record<LiftClassification, string>, so the compiler itself rejects
// an incomplete map if LiftClassification ever gains a member. The earlier
// hand-written array version made the identical "exhaustive" claim in its own
// comment but was just a plain array literal — it type-checked fine with a
// member missing, silently leaving that value unreachable in the "create new
// lift" affordance despite the comment (#911 review, third pass — this is
// the same overclaiming-comment pattern the second pass already corrected
// once in this same PR, in effective-slot-map.util.ts).
const LIFT_CLASSIFICATION_LABELS: Record<LiftClassification, string> = {
  compound: 'Compound',
  accessory: 'Accessory',
};
export const LIFT_CLASSIFICATIONS: { value: LiftClassification; label: string }[] = (
  Object.entries(LIFT_CLASSIFICATION_LABELS) as [LiftClassification, string][]
).map(([value, label]) => ({ value, label }));
