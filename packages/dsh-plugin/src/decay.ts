/**
 * Deterministic tier-decay curve, ported from the OpenCode plugin
 * (packages/plugin/src/hooks/magic-context/decay-curve.ts) — council-validated
 * math, unchanged hyperparameters. In DSH the "render pass" is a fold boundary
 * (a compaction commit), and a compartment's age is its 1-based position from
 * the newest checkpoint node.
 */

export const H50_DEFAULT = 24;
/** Test/experiment hook: shrink the half-life so demotion is observable in short smokes. */
export const H50 = Number(process.env.MC_DSH_H50 ?? H50_DEFAULT);
/** Importance points needed to double the half-life (imp 75 -> 2x, 100 -> 4x). */
export const D = 25;
/** Max extra half-lives of P4 protection from full anchor overlap. */
export const G = 2;

/** Tier boundaries in log-cost space (geometric means of measured tier costs). */
export const Z1 = 0.201; // P1->P2
export const Z2 = 0.729; // P2->P3
export const Z3 = 1.322; // P3->P4
export const Z4 = 2.587; // P4->P5 (archive)

/** Pressure floor: prevents div-by-zero and caps relaxation at 10x. */
export const P_FLOOR = 0.1;

/** Per-tier average token cost, indexed by tier number (1..5). Index 0 unused. */
export const TIER_COST = [0, 322, 109, 35, 20, 5] as const;

export type Tier = 1 | 2 | 3 | 4 | 5;

/**
 * Which paraphrase tier a compartment renders at, ignoring archive protection.
 * @param compartmentIndex 1-based position from newest (1 = newest).
 * @param importance 1..100 (historian-emitted decay rate).
 * @param budgetPressure 0.10.. (computed once per pass via computeBudgetPressure).
 */
export function tier(compartmentIndex: number, importance: number, budgetPressure: number): Tier {
    const a = Math.max(compartmentIndex, 1) - 1;
    const imp = Math.max(1, Math.min(100, importance));
    const p = Math.max(budgetPressure, P_FLOOR);

    const F = 2 ** ((imp - 50) / D);
    const H = (H50 * F) / p;
    const z = a / H;

    if (z < Z1) return 1;
    if (z < Z2) return 2;
    if (z < Z3) return 3;
    if (z < Z4) return 4;
    return 5;
}

/**
 * Final rendered tier combining base tier + archive protection. Archived
 * compartments return 5; anchor-protected ones render at P4 instead of P5.
 */
export function renderedTier(
    compartmentIndex: number,
    importance: number,
    budgetPressure: number,
    anchorOverlap = 0,
): Tier {
    const a = Math.max(compartmentIndex, 1) - 1;
    const imp = Math.max(1, Math.min(100, importance));
    const p = Math.max(budgetPressure, P_FLOOR);
    const o = Math.max(0, Math.min(1, anchorOverlap));

    const F = 2 ** ((imp - 50) / D);
    const H = (H50 * F) / p;
    const z = a / H;

    if (z >= Z4 + G * o) return 5;
    return Math.min(tier(compartmentIndex, importance, budgetPressure), 4) as Tier;
}

/**
 * Compute budget pressure for a render pass in a single forward pass.
 * C(p) ~= C(1)/p, so p = C(1)/B fits the budget in one pass.
 */
export function computeBudgetPressure(
    compartments: ReadonlyArray<{ index: number; importance: number }>,
    historyBudget: number,
): number {
    if (historyBudget <= 0) return 1;
    let naturalCost = 0;
    for (const c of compartments) {
        const naturalTier = tier(c.index, c.importance, 1.0);
        naturalCost += naturalTier >= 5 ? 0 : TIER_COST[naturalTier];
    }
    return Math.max(P_FLOOR, naturalCost / historyBudget);
}
