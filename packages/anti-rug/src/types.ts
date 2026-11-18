export type Verdict = "pass" | "watch" | "block";

export interface RugCheckResult {
  mint: string;
  verdict: Verdict;
  rug_score: number; // 0-100, higher = safer
  failed: string[];
  warned: string[];
  details: Record<string, unknown>;
  checked_at: number;
}

export interface HardCheck {
  name: string;
  /** Return true if this check alone forces a block */
  run: (ctx: CheckContext) => Promise<boolean> | boolean;
}

export interface CheckContext {
  mint: string;
  rpc: any; // Solana connection or equivalent
  tradeStream?: any;
  config: {
    maxTop10Pct: number;
    maxBundlePct: number;
    maxDevSoldPct: number;
    maxWashPct: number;
  };
}
