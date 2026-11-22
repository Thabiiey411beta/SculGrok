import { describe, expect, it } from "vitest";
import { evaluateRug } from "./checks.js";

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
});
