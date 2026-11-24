/**
 * Fee model for the $10 run.
 * All amounts in SOL unless stated. ATA rent is a cost by default:
 * it is reclaimed only on a confirmed clean close, which the paper
 * books never confirm (rugs and halts never close cleanly, exactly
 * when the rent is lost). Models therefore carry ataReclaimed: false
 * and every break-even / leg cost includes the rent.
 */
export const ATA_RENT_SOL = 0.00203928;
export const BASE_FEE_SOL = 0.000005;

export interface FeeModel {
  name: "light" | "sniper";
  priorityFeeSol: number;
  jitoTipSol: number;
  poolFeePct: number;
  slippagePct: number;
  ataRentSol: number;
  ataReclaimed: boolean;
}

export const LIGHT_FEES: FeeModel = {
  name: "light",
  priorityFeeSol: 0.00005,
  jitoTipSol: 0,
  poolFeePct: 0.01,
  slippagePct: 0.02,
  ataRentSol: ATA_RENT_SOL,
  ataReclaimed: false,
};

export const SNIPER_FEES: FeeModel = {
  name: "sniper",
  priorityFeeSol: 0.001,
  jitoTipSol: 0.001,
  poolFeePct: 0.01,
  slippagePct: 0.02,
  ataRentSol: ATA_RENT_SOL,
  ataReclaimed: false,
};

export function fixedCostPerLegSol(model: FeeModel): number {
  return BASE_FEE_SOL + model.priorityFeeSol + model.jitoTipSol;
}

export function legCostSol(amountSol: number, model: FeeModel, isFirstLeg: boolean): number {
  const fixed = fixedCostPerLegSol(model);
  const proportional = amountSol * (model.poolFeePct + model.slippagePct);
  const rent = isFirstLeg && !model.ataReclaimed ? model.ataRentSol : 0;
  return fixed + proportional + rent;
}

export function netAtaCostSol(model: FeeModel): number {
  return model.ataReclaimed ? 0 : model.ataRentSol;
}

/** Gross % move needed to break even on a round trip with `legs` legs. */
export function breakEvenGrossPct(positionSol: number, model: FeeModel, legs = 2): number {
  if (positionSol <= 0) return Number.POSITIVE_INFINITY;
  const fixedTotal = fixedCostPerLegSol(model) * legs + netAtaCostSol(model);
  const proportionalPerLeg = model.poolFeePct + model.slippagePct;
  // Solve: position * (1 + g) * (1 - prop) - position * (1 + prop) - fixed = position
  // Simplified conservative form used in tests: fixed / position + prop * legs
  return fixedTotal / positionSol + proportionalPerLeg * legs;
}

export function fixedCostPctOfPosition(positionSol: number, model: FeeModel, legs = 2): number {
  if (positionSol <= 0) return Number.POSITIVE_INFINITY;
  return (fixedCostPerLegSol(model) * legs + netAtaCostSol(model)) / positionSol;
}
