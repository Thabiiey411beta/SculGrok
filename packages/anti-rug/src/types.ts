export type Verdict = "pass" | "watch" | "block";

export interface RugCheckResult {
  mint: string;
  verdict: Verdict;
  rug_score: number; // 0-100, higher = safer
  failed: string[];
  warned: string[];
  details: Record<string, unknown>;
  checked_at: number;
  /** Fields whose measurement was explicitly DEFERRED to a later
   * stage (evaluateRug `deferFields`): their `*_unknown` reasons
   * are listed here instead of in `failed`, so a caller can pass
   * the other legs first and measure these before entry. A result
   * with a non-empty `deferred` is PROVISIONAL — it is not a pass
   * until the caller re-evaluates with the measured values. Never
   * treat a deferred field as measured, and never enter on a
   * result with deferred.length > 0. */
  deferred?: string[];
}
