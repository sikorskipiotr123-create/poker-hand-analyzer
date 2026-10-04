export const EV_BREAK_EVEN_TOLERANCE = 0.05;

export type CallAnalysis = {
  pot: number;
  villainBet: number;
  callAmount: number;
  finalPot: number;
  requiredEquity: number;
  callEv: number | null;
  recommendation: 'SPRAWDŹ · +EV' | 'PASUJ · −EV' | '≈ BREAK-EVEN' | null;
};

/** Amounts must use the same unit (for example, big blinds). */
export function calculateCallAnalysis(potInput: number, betInput: number, callInput: number, equity: number | null): CallAnalysis {
  if (equity !== null && (!Number.isFinite(equity) || equity < 0 || equity > 1)) throw new RangeError('Equity must be a finite value between 0 and 1.');
  const pot = Number.isFinite(potInput) ? Math.max(0, potInput) : 0;
  const villainBet = Number.isFinite(betInput) ? Math.max(0, betInput) : 0;
  const callAmount = Number.isFinite(callInput) ? Math.max(0, callInput) : 0;
  const finalPot = pot + villainBet + callAmount;
  const requiredEquity = finalPot > 0 ? callAmount / finalPot : 0;
  const callEv = equity !== null && finalPot > 0 ? equity * finalPot - callAmount : null;
  return {
    pot, villainBet, callAmount, finalPot, requiredEquity, callEv,
    recommendation: callEv === null ? null : Math.abs(callEv) <= EV_BREAK_EVEN_TOLERANCE ? '≈ BREAK-EVEN' : callEv > 0 ? 'SPRAWDŹ · +EV' : 'PASUJ · −EV',
  };
}
