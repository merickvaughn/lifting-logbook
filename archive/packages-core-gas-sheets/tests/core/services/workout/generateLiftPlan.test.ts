import {
  generateLiftPlan,
  parseLiftingProgramSpec,
  parseTrainingMaxes,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

const trainingMaxesData = loadCsvFixture("training_maxes.csv");
const rptProgramSpecData = loadCsvFixture("rpt_program_spec.csv");
const testWeekSpecData = loadCsvFixture("rpt_program_spec_test_week.csv");
const deloadWeekSpecData = loadCsvFixture("rpt_program_spec_deload_week.csv");
const trainingMaxes = parseTrainingMaxes(trainingMaxesData);
const rptProgramSpec = parseLiftingProgramSpec(rptProgramSpecData);
const testWeekSpec = parseLiftingProgramSpec(testWeekSpecData);
const deloadWeekSpec = parseLiftingProgramSpec(deloadWeekSpecData);

describe("generateLiftPlan", () => {
  it("generates correct lift plan for Bench P. (training week)", () => {
    const tm = trainingMaxes.find((t) => t.lift === "Bench P.")!;
    const ps = rptProgramSpec.find((p) => p.lift === "Bench P.")!;
    const startDate = new Date("2026-01-01");
    const plan = generateLiftPlan(tm, ps, startDate);
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBe(6); // 3 warm-up + 3 work sets
    // Check first warm-up set
    const warmup = plan.find((row) => typeof row[2] === "string" && row[2].startsWith("Warm-up"));
    expect(warmup).toBeDefined();
    expect(warmup![1]).toBe("Bench P.");
    expect(warmup![2]).toMatch(/Warm-up \d+/);
    expect(warmup![4]).toBe(5);
    // Check first work set
    const workset = plan.find((row) => typeof row[2] === "string" && row[2].startsWith("Set"));
    expect(workset).toBeDefined();
    expect(workset![1]).toBe("Bench P.");
    expect(workset![2]).toMatch(/Set \d+/);
  });

  it("generates 5-set ascending ramp-up for test week", () => {
    const tm = trainingMaxes.find((t) => t.lift === "Bench P.")!;
    const ps = testWeekSpec.find((p) => p.lift === "Bench P.")!;
    expect(ps.weekType).toBe("test");
    const plan = generateLiftPlan(tm, ps, new Date("2026-01-01"));
    expect(plan.length).toBe(5);
    // All rows should be labeled "Set N"
    plan.forEach((row, i) => expect(row[2]).toBe(`Set ${i + 1}`));
    // Rep counts should follow the test-week protocol: 5, 3, 2, 1, 1
    expect(plan[0]![4]).toBe(5);
    expect(plan[1]![4]).toBe(3);
    expect(plan[2]![4]).toBe(2);
    expect(plan[3]![4]).toBe(1);
    expect(plan[4]![4]).toBe(1);
  });

  it("generates 3-set light protocol for deload week", () => {
    const tm = trainingMaxes.find((t) => t.lift === "Bench P.")!;
    const ps = deloadWeekSpec.find((p) => p.lift === "Bench P.")!;
    expect(ps.weekType).toBe("deload");
    const plan = generateLiftPlan(tm, ps, new Date("2026-01-01"));
    expect(plan.length).toBe(3);
    plan.forEach((row, i) => expect(row[2]).toBe(`Set ${i + 1}`));
    // Rep counts: 5, 5, 5
    plan.forEach((row) => expect(row[4]).toBe(5));
  });
});
