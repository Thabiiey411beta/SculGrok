/**
 * Fail-closed gate verdict (SOUL audit fix, 2026-11-23).
 *
 * A gate is never a boolean. It returns one of three verdicts:
 * - "pass": the check ran and the input is clean.
 * - "fail": the check ran and the input is unsafe.
 * - "unknown": the check could not reach a verdict (missing data,
 *   transient fetch failure, unparseable response).
 * Unknown BLOCKS entry exactly like fail. Callers must handle all
 * three cases; gateBlocks is exhaustive — adding a fourth verdict is
 * a compile error via assertNever.
 */
export type GateVerdict = "pass" | "fail" | "unknown";

export function assertNever(v: never): never {
  throw new Error("unreachable gate verdict: " + String(v));
}

export function gateBlocks(v: GateVerdict): boolean {
  switch (v) {
    case "pass":
      return false;
    case "fail":
      return true;
    case "unknown":
      return true;
    default:
      return assertNever(v);
  }
}
