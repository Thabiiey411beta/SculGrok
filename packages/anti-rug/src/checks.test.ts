import { describe, expect, it } from "vitest";
import { evaluateRug, RUG_DEFERRED_FIELDS } from "./checks.js";

const clean = {
  mint: "TEST11111111111111111111111111111111111111",
  mintAuthorityLive: false,
  freezeAuthorityLive: false,
  top10Pct: 0.15,
  singleWalletPct: 0.05,
  bundlePct: 0.1,
  devSoldPct: 0.05,
  washPct: 0.1,
  lpLockedOrBurned: true,
  liquidityUsd: 20000,
  sellSimulationOk: true,
  token2022TransferFee: false,
  token2022TransferHook: false,
  token2022PermanentDelegate: false,
  token2022Pause: false,
  mutableMetadata: false,
};

describe("evaluateRug", () => {
  it("passes a clean token", () => {
    expect(evaluateRug(clean).verdict).toBe("pass");
  });
  it("blocks live mint authority", () => {
    expect(evaluateRug({ ...clean, mintAuthorityLive: true }).verdict).toBe("block");
  });
  it("blocks live freeze authority", () => {
    expect(evaluateRug({ ...clean, freezeAuthorityLive: true }).verdict).toBe("block");
  });
  it("blocks missing data", () => {
    expect(evaluateRug({ ...clean, mintAuthorityLive: undefined }).verdict).toBe("block");
  });
  it("blocks top10 over 30 percent", () => {
    expect(evaluateRug({ ...clean, top10Pct: 0.35 }).verdict).toBe("block");
  });
  it("blocks a failed sell simulation", () => {
    expect(evaluateRug({ ...clean, sellSimulationOk: false }).verdict).toBe("block");
  });
  it("blocks a missing single-wallet concentration (unknown, not pass)", () => {
    // SOUL audit fix: the old code passed when these fields were
    // absent. Missing data = block.
    const r = evaluateRug({ ...clean, singleWalletPct: undefined });
    expect(r.verdict).toBe("block");
    expect(r.failed).toContain("single_wallet_unknown");
  });
  it("blocks a missing dev-sold share", () => {
    const r = evaluateRug({ ...clean, devSoldPct: undefined });
    expect(r.verdict).toBe("block");
    expect(r.failed).toContain("dev_sold_unknown");
  });
  it("a missing wash share does NOT block (logged-only, v2.20)", () => {
    // Wash is measured and journaled but never gates: 27/30 live
    // fresh tokens have no organic fields at all, so wash_unknown
    // would block nearly every candidate without discriminating.
    const r = evaluateRug({ ...clean, washPct: undefined });
    expect(r.verdict).toBe("pass");
    expect(r.failed).not.toContain("wash_unknown");
  });
  it("a measured wash share of 0.975 does NOT block (logged-only, v2.20)", () => {
    const r = evaluateRug({ ...clean, washPct: 0.975 });
    expect(r.verdict).toBe("pass");
    expect(r.failed).not.toContain("wash_volume");
  });
  it("blocks a missing bundle share", () => {
    const r = evaluateRug({ ...clean, bundlePct: undefined });
    expect(r.verdict).toBe("block");
    expect(r.failed).toContain("bundle_unknown");
  });
  it("blocks when any Token-2022 flag is unmeasured", () => {
    const fields: Array<[keyof typeof clean, string]> = [
      ["token2022TransferFee", "token2022_transfer_fee_unknown"],
      ["token2022TransferHook", "token2022_transfer_hook_unknown"],
      ["token2022PermanentDelegate", "token2022_permanent_delegate_unknown"],
      ["token2022Pause", "token2022_pause_unknown"],
    ];
    for (const [field, reason] of fields) {
      const r = evaluateRug({ ...clean, [field]: undefined });
      expect(r.verdict).toBe("block");
      expect(r.failed).toContain(reason);
    }
  });
  it("blocks when every unmeasured field is absent at once", () => {
    const r = evaluateRug({ mint: "TEST11111111111111111111111111111111111111", mintAuthorityLive: false, freezeAuthorityLive: false, lpLockedOrBurned: true, liquidityUsd: 20000, sellSimulationOk: true });
    expect(r.verdict).toBe("block");
    for (const reason of ["top10_unknown", "single_wallet_unknown", "bundle_unknown", "dev_sold_unknown", "token2022_transfer_fee_unknown", "token2022_transfer_hook_unknown", "token2022_permanent_delegate_unknown", "token2022_pause_unknown"]) {
      expect(r.failed).toContain(reason);
    }
    // Wash is logged-only (v2.20): absent wash is not a failure.
    expect(r.failed).not.toContain("wash_unknown");
  });
});

describe("evaluateRug deferral (two-stage deep check)", () => {
  // Stage A: the six expensive fields are deferred to stage B.
  // Their *_unknown reasons move to `deferred`, not `failed`.
  // Wash was the seventh until v2.20 (logged-only now): it is
  // neither failed nor deferred, whether present or absent.
  const unmeasured = {
    ...clean,
    bundlePct: undefined,
    devSoldPct: undefined,
    washPct: undefined,
    token2022TransferFee: undefined,
    token2022TransferHook: undefined,
    token2022PermanentDelegate: undefined,
    token2022Pause: undefined,
  };
  it("defers the six expensive fields instead of failing them", () => {
    const r = evaluateRug(unmeasured, { deferFields: RUG_DEFERRED_FIELDS });
    expect(r.verdict).toBe("pass");
    expect(r.failed).toEqual([]);
    expect(r.deferred).toEqual([
      "bundle_unknown",
      "dev_sold_unknown",
      "token2022_transfer_fee_unknown",
      "token2022_transfer_hook_unknown",
      "token2022_permanent_delegate_unknown",
      "token2022_pause_unknown",
    ]);
  });
  it("still blocks a non-deferred failure while deferring the rest", () => {
    const r = evaluateRug({ ...unmeasured, mintAuthorityLive: true }, { deferFields: RUG_DEFERRED_FIELDS });
    expect(r.verdict).toBe("block");
    expect(r.failed).toEqual(["mint_authority_live"]);
    expect(r.deferred).toHaveLength(6);
  });
  it("a deferred field that IS present is still evaluated normally", () => {
    // Measured bundle 30% blocks even when the field is deferred.
    const r = evaluateRug({ ...unmeasured, bundlePct: 0.3 }, { deferFields: RUG_DEFERRED_FIELDS });
    expect(r.verdict).toBe("block");
    expect(r.failed).toContain("bundle_concentration");
    expect(r.deferred).not.toContain("bundle_unknown");
    // Measured wash 97.5% (Pikachu, live Jupiter stats1h) does NOT
    // block any more (v2.20, logged-only) — and is not deferred.
    const w = evaluateRug({ ...unmeasured, washPct: 0.975 }, { deferFields: RUG_DEFERRED_FIELDS });
    expect(w.verdict).toBe("pass");
    expect(w.failed).not.toContain("wash_volume");
    expect(w.deferred).not.toContain("wash_unknown");
    // A measured Token-2022 transfer fee blocks.
    const t = evaluateRug({ ...unmeasured, token2022TransferFee: true }, { deferFields: RUG_DEFERRED_FIELDS });
    expect(t.verdict).toBe("block");
    expect(t.failed).toContain("token2022_transfer_fee");
  });
  it("deferral is opt-in: without opts the same input blocks", () => {
    const r = evaluateRug(unmeasured);
    expect(r.verdict).toBe("block");
    expect(r.deferred).toEqual([]);
    expect(r.failed).toContain("bundle_unknown");
  });
  it("a partial deferral only defers the named fields", () => {
    const r = evaluateRug(unmeasured, { deferFields: ["bundlePct"] });
    expect(r.verdict).toBe("block");
    expect(r.deferred).toEqual(["bundle_unknown"]);
    expect(r.failed).toContain("dev_sold_unknown");
    expect(r.failed).not.toContain("wash_unknown");
  });
});
