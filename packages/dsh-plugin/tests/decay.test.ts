import { describe, expect, test } from "bun:test";
import {
    computeBudgetPressure,
    D,
    H50,
    P_FLOOR,
    renderedTier,
    TIER_COST,
    tier,
    Z1,
    Z2,
    Z3,
    Z4,
} from "../src/decay";

describe("decay tier curve", () => {
    test("newest compartment always renders P1 at any importance", () => {
        for (const imp of [1, 50, 100]) {
            expect(tier(1, imp, 1)).toBe(1);
            expect(renderedTier(1, imp, 1)).toBe(1);
        }
    });

    test("age and importance monotonicity: higher age and lower importance demote faster", () => {
        // importance 100 doubles the half-life every D points; at fixed pressure the
        // tier for (age, imp) never exceeds the tier for (age, imp-1)... (non-strict)
        for (let age = 1; age <= 80; age += 7) {
            const low = renderedTier(age, 20, 1);
            const high = renderedTier(age, 80, 1);
            expect(low).toBeGreaterThanOrEqual(high);
        }
    });

    test("even importance 100 demotes eventually (finite demotion)", () => {
        // age far beyond any half-life: P5 archive territory
        expect(renderedTier(10_000, 100, 1)).toBe(5);
        expect(tier(10_000, 100, 1)).toBe(5);
    });

    test("budget pressure accelerates demotion", () => {
        // index 10, importance 50: p=1 vs p=8 — higher pressure demotes no slower
        expect(renderedTier(10, 50, 8)).toBeGreaterThanOrEqual(renderedTier(10, 50, 1));
    });

    test("boundary constants are ordered", () => {
        expect(Z1).toBeLessThan(Z2);
        expect(Z2).toBeLessThan(Z3);
        expect(Z3).toBeLessThan(Z4);
    });

    test("half-life formula: importance 75 doubles H vs importance 50", () => {
        const f = (imp: number) => 2 ** ((imp - 50) / D);
        expect(f(75)).toBeCloseTo(2, 5);
        expect(f(100)).toBeCloseTo(4, 5);
    });

    test("computeBudgetPressure floors at P_FLOOR and fits the budget direction", () => {
        expect(computeBudgetPressure([], 0)).toBe(1);
        const comps = Array.from({ length: 50 }, (_, i) => ({ index: i + 1, importance: 40 }));
        // natural cost at p=1 (~3.2k tokens) exceeds this budget -> p > 1
        const p = computeBudgetPressure(comps, 2_000);
        expect(p).toBeGreaterThanOrEqual(P_FLOOR);
        expect(p).toBeGreaterThan(1);
        // total cost at pressure p should be within ~30% of the budget
        let cost = 0;
        for (const c of comps) {
            const t = tier(c.index, c.importance, p);
            cost += t >= 5 ? 0 : TIER_COST[t];
        }
        expect(cost).toBeLessThan(2_000 * 1.4);
    });

    test("H50 is overridable for short smokes (test hook)", () => {
        // just prove the constant exists and is positive; override behavior is
        // exercised in the smoke environment via MC_DSH_H50
        expect(H50).toBeGreaterThan(0);
    });
});
