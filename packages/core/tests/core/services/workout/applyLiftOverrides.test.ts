import type { LiftOverride } from "@src/core/models/LiftOverride";
import {
  applyLiftOverrides,
  type PlannedLift,
} from "@src/core/services/workout/applyLiftOverrides";

const lifts = ["Squat", "Bench Press", "Deadlift"];
const names = (planned: PlannedLift[]) => planned.map((p) => p.lift);

describe("applyLiftOverrides — the planned list", () => {
  it("returns spec lifts unchanged when no overrides", () => {
    const { planned, renamed, removed } = applyLiftOverrides(lifts, []);
    expect(planned).toEqual(lifts.map((lift) => ({ lift })));
    expect(renamed.size).toBe(0);
    expect(removed.size).toBe(0);
  });

  it("remove — drops the target lift", () => {
    const o: LiftOverride[] = [{ lift: "Bench Press", action: "remove" }];
    expect(names(applyLiftOverrides(lifts, o).planned)).toEqual(["Squat", "Deadlift"]);
  });

  it("remove — no-op on the plan when the lift is not in it", () => {
    const o: LiftOverride[] = [{ lift: "Overhead Press", action: "remove" }];
    expect(names(applyLiftOverrides(lifts, o).planned)).toEqual(lifts);
  });

  it("replace — swaps in place, and the replacement records the slot it took (#1014)", () => {
    const o: LiftOverride[] = [{ lift: "Bench Press", action: "replace", replacedBy: "Dips" }];
    expect(applyLiftOverrides(lifts, o).planned).toEqual([
      { lift: "Squat" },
      { lift: "Dips", replaces: "Bench Press" },
      { lift: "Deadlift" },
    ]);
  });

  it("replace chain — follows back to the lift originally in the slot", () => {
    // Swapping the swap: the slot, and so its prescription, is still Squat's.
    const o: LiftOverride[] = [
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
      { lift: "Front Squat", action: "replace", replacedBy: "Box Squat" },
    ];
    expect(applyLiftOverrides(lifts, o).planned[0]).toEqual({ lift: "Box Squat", replaces: "Squat" });
  });

  it("replace back to the slot’s own lift — leaves nothing to inherit", () => {
    const o: LiftOverride[] = [
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
      { lift: "Front Squat", action: "replace", replacedBy: "Squat" },
    ];
    expect(applyLiftOverrides(lifts, o).planned[0]).toEqual({ lift: "Squat" });
  });

  it("replace without replacedBy — no-op (invalid but defensively handled)", () => {
    const o: LiftOverride[] = [{ lift: "Bench Press", action: "replace" }];
    const { planned, renamed } = applyLiftOverrides(lifts, o);
    expect(planned).toEqual(lifts.map((lift) => ({ lift })));
    expect(renamed.size).toBe(0);
  });

  it("add — appends a new lift, which fills no program slot", () => {
    const o: LiftOverride[] = [{ lift: "Chin-up", action: "add" }];
    const { planned } = applyLiftOverrides(lifts, o);
    expect(names(planned)).toEqual([...lifts, "Chin-up"]);
    expect(planned[3]).toEqual({ lift: "Chin-up" });
  });

  it("add — no-op when the lift is already planned", () => {
    const o: LiftOverride[] = [{ lift: "Squat", action: "add" }];
    expect(names(applyLiftOverrides(lifts, o).planned)).toEqual(lifts);
  });

  it("combined — remove, replace, add applied in order", () => {
    const o: LiftOverride[] = [
      { lift: "Squat", action: "remove" },
      { lift: "Bench Press", action: "replace", replacedBy: "Dips" },
      { lift: "Chin-up", action: "add" },
    ];
    expect(applyLiftOverrides(lifts, o).planned).toEqual([
      { lift: "Dips", replaces: "Bench Press" },
      { lift: "Deadlift" },
      { lift: "Chin-up" },
    ]);
  });

  it("depends on the order the overrides were made in", () => {
    // Reversed, the second swap runs before Front Squat is in the list and does
    // nothing — which is why the repositories must return overrides in creation
    // order.
    const o: LiftOverride[] = [
      { lift: "Front Squat", action: "replace", replacedBy: "Box Squat" },
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
    ];
    expect(applyLiftOverrides(lifts, o).planned[0]).toEqual({ lift: "Front Squat", replaces: "Squat" });
  });
});

describe("applyLiftOverrides — where logged sets belong", () => {
  it("regroups a replaced lift’s sets under its replacement", () => {
    const o: LiftOverride[] = [{ lift: "Squat", action: "replace", replacedBy: "Front Squat" }];
    const { renamed, removed } = applyLiftOverrides(lifts, o);
    expect(Object.fromEntries(renamed)).toEqual({ Squat: "Front Squat" });
    expect(removed.size).toBe(0);
  });

  it("regroups every earlier name of a slot under its current lift, through a chain", () => {
    // Sets logged as Squat before the first swap, and as Front Squat between the
    // two, both belong to the slot now shown as Box Squat.
    const o: LiftOverride[] = [
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
      { lift: "Front Squat", action: "replace", replacedBy: "Box Squat" },
    ];
    expect(Object.fromEntries(applyLiftOverrides(lifts, o).renamed)).toEqual({
      Squat: "Box Squat",
      "Front Squat": "Box Squat",
    });
  });

  it("hides every earlier name of a slot that is then removed", () => {
    // Replace-then-remove used to resurrect the removed lift, carrying the
    // original lift's sets.
    const o: LiftOverride[] = [
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
      { lift: "Front Squat", action: "remove" },
    ];
    const { planned, renamed, removed } = applyLiftOverrides(lifts, o);
    expect(names(planned)).toEqual(["Bench Press", "Deadlift"]);
    expect([...removed].sort()).toEqual(["Front Squat", "Squat"]);
    expect(renamed.size).toBe(0);
  });

  it("treats a lift swapped back to itself as unrenamed", () => {
    const o: LiftOverride[] = [
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
      { lift: "Front Squat", action: "replace", replacedBy: "Squat" },
    ];
    expect(Object.fromEntries(applyLiftOverrides(lifts, o).renamed)).toEqual({ "Front Squat": "Squat" });
  });

  it("still hides and regroups a lift that was logged ad hoc rather than planned", () => {
    // An unplanned lift reaches Manage Lifts from its logged sets; removing or
    // replacing it acts on those sets even though the plan has nothing to change.
    const removedAdHoc = applyLiftOverrides(lifts, [{ lift: "Chin-up", action: "remove" }]);
    expect([...removedAdHoc.removed]).toEqual(["Chin-up"]);

    const replacedAdHoc = applyLiftOverrides(lifts, [
      { lift: "Chin-up", action: "replace", replacedBy: "Pull-up" },
    ]);
    expect(names(replacedAdHoc.planned)).toEqual(lifts);
    expect(Object.fromEntries(replacedAdHoc.renamed)).toEqual({ "Chin-up": "Pull-up" });
  });

  it("leaves names no override touched out of both maps", () => {
    const o: LiftOverride[] = [{ lift: "Bench Press", action: "remove" }];
    const { renamed, removed } = applyLiftOverrides(lifts, o);
    expect(renamed.has("Squat")).toBe(false);
    expect(removed.has("Squat")).toBe(false);
  });
});
