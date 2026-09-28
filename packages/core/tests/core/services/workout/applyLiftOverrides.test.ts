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

  it("lets a lift the plan shows keep the sets stored under its own name", () => {
    // Squat's slot was swapped and removed, then Leg Press's slot became Squat.
    // A Squat set logged in that slot must show there, not vanish with the old
    // slot. Older Squat sets come along: sets are keyed by name alone (#1027).
    const o: LiftOverride[] = [
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
      { lift: "Front Squat", action: "remove" },
      { lift: "Leg Press", action: "replace", replacedBy: "Squat" },
    ];
    const { planned, renamed, removed } = applyLiftOverrides([...lifts, "Leg Press"], o);
    expect(planned[2]).toEqual({ lift: "Squat", replaces: "Leg Press" });
    expect(removed.has("Squat")).toBe(false);
    expect(renamed.has("Squat")).toBe(false);
    expect([...removed]).toEqual(["Front Squat"]);
    expect(Object.fromEntries(renamed)).toEqual({ "Leg Press": "Squat" });
  });
});

describe("applyLiftOverrides — an override saved again", () => {
  // The repositories return overrides in the order each was last written, and
  // saving an override for a lift again moves it to the end. Each case below
  // is that order after the flow it names.

  it("redo after undo: a swap made again applies after the undo", () => {
    // Squat → Front Squat, back to Squat, then Squat → Front Squat again. The
    // Squat row was re-saved last; the undo (Front Squat → Squat) is older.
    const o: LiftOverride[] = [
      { lift: "Front Squat", action: "replace", replacedBy: "Squat" },
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
    ];
    expect(applyLiftOverrides(lifts, o).planned[0]).toEqual({ lift: "Front Squat", replaces: "Squat" });
  });

  it("a different swap after an undo keeps the undone lift’s sets with the slot", () => {
    // Squat → Front Squat (a set logged as Front Squat), back to Squat, then
    // Squat → Box Squat. The Front Squat set was the slot's, so it goes to Box Squat.
    const o: LiftOverride[] = [
      { lift: "Front Squat", action: "replace", replacedBy: "Squat" },
      { lift: "Squat", action: "replace", replacedBy: "Box Squat" },
    ];
    const { planned, renamed } = applyLiftOverrides(lifts, o);
    expect(planned[0]).toEqual({ lift: "Box Squat", replaces: "Squat" });
    expect(Object.fromEntries(renamed)).toEqual({ "Front Squat": "Box Squat", Squat: "Box Squat" });
  });

  it("removing after an undo hides the undone lift’s sets too", () => {
    // Squat → Front Squat (a set logged as Front Squat), back to Squat, then
    // remove Squat. The slot is gone, so is its Front Squat set.
    const o: LiftOverride[] = [
      { lift: "Front Squat", action: "replace", replacedBy: "Squat" },
      { lift: "Squat", action: "remove" },
    ];
    const { planned, removed } = applyLiftOverrides(lifts, o);
    expect(names(planned)).toEqual(["Bench Press", "Deadlift"]);
    expect([...removed].sort()).toEqual(["Front Squat", "Squat"]);
  });
});

describe("applyLiftOverrides — a lift’s add and its replace, stored apart (#1026)", () => {
  // The repositories keep a lift's add alongside its replace, each in the order
  // it was last written. (When one overwrote the other, replacing an added lift
  // left the replace no lift to swap, and adding a swapped-out lift undid the swap.)

  it("keeps a swap when the swapped-out lift is then added back", () => {
    // Squat → Front Squat, then Squat added: Front Squat keeps Squat's slot, and
    // Squat joins the workout as an added lift.
    const o: LiftOverride[] = [
      { lift: "Squat", action: "replace", replacedBy: "Front Squat" },
      { lift: "Squat", action: "add" },
    ];
    const { planned, renamed } = applyLiftOverrides(lifts, o);
    expect(planned).toEqual([
      { lift: "Front Squat", replaces: "Squat" },
      { lift: "Bench Press" },
      { lift: "Deadlift" },
      { lift: "Squat" },
    ]);
    // A lift the plan shows owns the sets under its own name (telling the two
    // Squats' sets apart needs slot identity, #1027).
    expect(renamed.size).toBe(0);
  });

  it("puts the replacement in the added lift’s place, with its logged sets", () => {
    // Chin-up, then Face Pulls, were added; then Chin-up was replaced.
    const o: LiftOverride[] = [
      { lift: "Chin-up", action: "add" },
      { lift: "Face Pulls", action: "add" },
      { lift: "Chin-up", action: "replace", replacedBy: "Pull-up" },
    ];
    const { planned, renamed, removed } = applyLiftOverrides(lifts, o);
    // It names the added lift as its slot, which has no prescription to inherit.
    expect(planned.slice(3)).toEqual([{ lift: "Pull-up", replaces: "Chin-up" }, { lift: "Face Pulls" }]);
    expect(Object.fromEntries(renamed)).toEqual({ "Chin-up": "Pull-up" });
    expect(removed.size).toBe(0);
  });

  it("follows a swap back and a redo on the added slot like any other", () => {
    // Chin-up → Pull-up, back to Chin-up: the added lift is back in its own slot.
    const undone: LiftOverride[] = [
      { lift: "Chin-up", action: "add" },
      { lift: "Chin-up", action: "replace", replacedBy: "Pull-up" },
      { lift: "Pull-up", action: "replace", replacedBy: "Chin-up" },
    ];
    expect(applyLiftOverrides(lifts, undone).planned[3]).toEqual({ lift: "Chin-up" });

    // Then Chin-up → Pull-up again: Chin-up's replace is re-saved after the undo.
    // A set logged as Pull-up before the undo is the slot's, so it comes back too.
    const redone: LiftOverride[] = [
      { lift: "Chin-up", action: "add" },
      { lift: "Pull-up", action: "replace", replacedBy: "Chin-up" },
      { lift: "Chin-up", action: "replace", replacedBy: "Pull-up" },
    ];
    const { planned, renamed } = applyLiftOverrides(lifts, redone);
    expect(planned[3]).toEqual({ lift: "Pull-up", replaces: "Chin-up" });
    expect(Object.fromEntries(renamed)).toEqual({ "Chin-up": "Pull-up" });
  });
});
