import type { ActionDraft, ActionType, Street } from './ai-context';

export type BlindConfig = { smallBlindBb: number; bigBlindBb: number };
export type StartingStacks = { hero: number; villain: number };
export type PlayerStackState = {
  startingStackBb: number;
  totalContributionBb: number;
  streetContributionBb: number;
  remainingStackBb: number;
  isAllIn: boolean;
};
export type Player = 'hero' | 'villain';
export type AllInKind = 'bet-all-in' | 'raise-all-in' | 'call-all-in';
export type ActionResolution = {
  additionalContributionBb: number;
  streetTotalBb: number;
  allInKind: AllInKind | null;
  player: PlayerStackState;
};
export type DecisionPoint = {
  /** Pot immediately before the opponent wager, including all prior matched contributions. */
  potBeforeOpponentActionBb: number;
  /** The opponent's actual contribution on this action. */
  opponentBetBb: number;
  /** Portion of that wager the Hero can contest (excess is returned if Hero calls all-in). */
  contestableOpponentBetBb: number;
  /** Legal incremental Hero call, capped at Hero's remaining stack. */
  callAmountBb: number;
  /** Amount required for a full call before applying Hero's stack cap. */
  amountDueBb: number;
  canFullCall: boolean;
  facingAllIn: boolean;
  finalContestablePotBb: number;
  heroRemainingStackBb: number;
  villainRemainingStackBb: number;
  currentEffectiveStackBb: number;
  startingEffectiveStackBb: number;
  heroIsAllIn: boolean;
  villainIsAllIn: boolean;
  spr: number | null;
  street: Street;
};
export type ActionStateResult = {
  potBb: number;
  streetContributions: Record<Player, number>;
  totalContributions: Record<Player, number>;
  players: Record<Player, PlayerStackState>;
  startingEffectiveStackBb: number;
  currentEffectiveStackBb: number;
  streetStartPotBb: number;
  streetStartEffectiveStackBb: number | null;
  streetStartSpr: number | null;
  spr: number | null;
  currentWagerBb: number;
  amountToCall: Record<Player, number>;
  decisionPoint: DecisionPoint | null;
  normalizedActions: ActionDraft[];
  actionResolutions: ActionResolution[];
  errors: { index: number | null; message: string }[];
};

const streetOrder: Record<Street, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
const EPSILON = 1e-8;
const defaultStacks: StartingStacks = { hero: 100, villain: 100 };
const nonnegative = (value: number) => Math.max(0, value);

function playerState(startingStackBb: number, totalContributionBb: number, streetContributionBb: number): PlayerStackState {
  const remainingStackBb = nonnegative(startingStackBb - totalContributionBb);
  return { startingStackBb, totalContributionBb, streetContributionBb, remainingStackBb, isAllIn: remainingStackBb <= EPSILON };
}

/** Betting ends once an all-in player has no unmatched wager left to resolve. */
export function isAllInBettingComplete(state: Pick<ActionStateResult, 'players' | 'streetContributions'>): boolean {
  return (state.players.hero.isAllIn || state.players.villain.isAllIn)
    && Math.abs(state.streetContributions.hero - state.streetContributions.villain) <= EPSILON;
}

/** Deterministic replay. Bet/raise amounts are street-total targets; calls and All-in are stack-capped. */
export function calculateActionState(
  actions: ActionDraft[],
  positions: { hero: string; villain: string },
  blinds: BlindConfig = { smallBlindBb: 0.5, bigBlindBb: 1 },
  stacks: StartingStacks = defaultStacks,
  throughStreet: Street = 'preflop',
): ActionStateResult {
  const errors: ActionStateResult['errors'] = [];
  const duplicatePosition = positions.hero === positions.villain;
  if (duplicatePosition) errors.push({ index: null, message: 'Hero i rywal muszą mieć różne pozycje przy stole.' });
  const invalidBlind = !Number.isFinite(blinds.smallBlindBb) || !Number.isFinite(blinds.bigBlindBb) || blinds.smallBlindBb < 0 || blinds.bigBlindBb < 0 || blinds.smallBlindBb > blinds.bigBlindBb;
  if (invalidBlind) errors.push({ index: null, message: 'Blindy muszą być nieujemne, a mały blind nie może być większy od dużego.' });
  const invalidStack = (['hero', 'villain'] as const).some((player) => !Number.isFinite(stacks[player]) || stacks[player] <= 0);
  if (invalidStack) errors.push({ index: null, message: 'Stack startowy każdego gracza musi być dodatni.' });

  const validBlinds = invalidBlind || duplicatePosition ? { smallBlindBb: 0, bigBlindBb: 0 } : blinds;
  const startingStack = (player: Player) => invalidStack ? defaultStacks[player] : stacks[player];
  let potBb = 0;
  let total: Record<Player, number> = { hero: 0, villain: 0 };
  let streetContributions: Record<Player, number> = { hero: 0, villain: 0 };
  // Untracked seats post the configured dead blinds; tracked blind players can post only their stack.
  for (const [position, amount] of [['SB', validBlinds.smallBlindBb], ['BB', validBlinds.bigBlindBb]] as const) {
    const player: Player | null = positions.hero === position ? 'hero' : positions.villain === position ? 'villain' : null;
    const posted = player ? Math.min(amount, startingStack(player)) : amount;
    potBb += posted;
    if (player) { total[player] += posted; streetContributions[player] += posted; }
  }
  let street: Street = 'preflop';
  let streetStartPotBb = 0;
  let streetStartEffectiveStackBb: number | null = null;
  let foldedBy: Player | null = null;
  let decisionPoint: DecisionPoint | null = null;
  const normalizedActions: ActionDraft[] = [];
  const actionResolutions: ActionResolution[] = [];
  const startingEffectiveStackBb = Math.min(startingStack('hero'), startingStack('villain'));
  const players = (): Record<Player, PlayerStackState> => ({
    hero: playerState(startingStack('hero'), total.hero, streetContributions.hero),
    villain: playerState(startingStack('villain'), total.villain, streetContributions.villain),
  });

  const returnUnmatched = (player: Player, amount: number) => {
    streetContributions[player] -= amount;
    total[player] -= amount;
    potBb -= amount;
  };
  const allInComplete = () => isAllInBettingComplete({ players: players(), streetContributions });
  // Forced blinds need no response when the shorter contributor is already exhausted.
  const shorter: Player = streetContributions.hero < streetContributions.villain ? 'hero' : 'villain';
  const larger: Player = shorter === 'hero' ? 'villain' : 'hero';
  if (players()[shorter].isAllIn) {
    returnUnmatched(larger, streetContributions[larger] - streetContributions[shorter]);
  }

  actions.forEach((action, index) => {
    const errorCount = errors.length;
    const error = (message: string) => errors.push({ index, message });
    const normalized: ActionDraft = { ...action };
    if (foldedBy) { error('Nie można wykonać akcji po foldzie.'); normalizedActions.push(normalized); actionResolutions.push({ additionalContributionBb: 0, streetTotalBb: streetContributions[action.actor], allInKind: null, player: players()[action.actor] }); return; }
    if (allInComplete()) { error('Zakłady są zakończone — wkłady gracza all-in zostały wyrównane.'); normalizedActions.push(normalized); actionResolutions.push({ additionalContributionBb: 0, streetTotalBb: streetContributions[action.actor], allInKind: null, player: players()[action.actor] }); return; }
    if (streetOrder[action.street] < streetOrder[street]) { error('Ulice muszą występować w kolejności: preflop, flop, turn, river.'); normalizedActions.push(normalized); actionResolutions.push({ additionalContributionBb: 0, streetTotalBb: streetContributions[action.actor], allInKind: null, player: players()[action.actor] }); return; }
    if (action.street !== street && (players().hero.isAllIn || players().villain.isAllIn)
      && Math.abs(streetContributions.hero - streetContributions.villain) > EPSILON) {
      error('Nie można zmienić ulicy — zakład all-in wymaga call lub fold.');
      normalizedActions.push(normalized);
      actionResolutions.push({ additionalContributionBb: 0, streetTotalBb: streetContributions[action.actor], allInKind: null, player: players()[action.actor] });
      return;
    }
    if (action.street !== street) {
      street = action.street;
      streetContributions = { hero: 0, villain: 0 };
      streetStartPotBb = potBb;
      streetStartEffectiveStackBb = Math.min(players().hero.remainingStackBb, players().villain.remainingStackBb);
      decisionPoint = null;
    }
    const beforePlayers = players();
    const current = beforePlayers[action.actor];
    const other: Player = action.actor === 'hero' ? 'villain' : 'hero';
    const otherState = beforePlayers[other];
    const highest = Math.max(streetContributions.hero, streetContributions.villain);
    const due = Math.max(0, highest - streetContributions[action.actor]);
    if (current.isAllIn) error('Gracz jest już all-in i nie może wykonać kolejnej akcji.');
    else if (otherState.isAllIn && (due > EPSILON ? !(['call', 'fold'].includes(action.action) || (action.action === 'all_in' && current.remainingStackBb <= due + EPSILON)) : !['check', 'fold'].includes(action.action))) error('Przeciwnik jest all-in — dalsze zakłady nie są możliwe.')
    if (action.action === 'check' && due > EPSILON) error(`Check jest niemożliwy — do sprawdzenia pozostaje ${due.toFixed(2)} bb.`);
    if (action.action === 'call' && due <= EPSILON) error('Call jest niemożliwy — nie ma zakładu do wyrównania.');
    if (action.action === 'bet' && highest > EPSILON) error('Przy otwartym zakładzie wybierz Raise zamiast Bet.');
    if (action.action === 'raise' && highest <= EPSILON) error('Raise wymaga wcześniejszego zakładu — wybierz Bet.');

    let added = 0;
    let allInKind: AllInKind | null = null;
    let streetTotalBb = streetContributions[action.actor];
    if (errors.length === errorCount && action.action === 'call') {
      added = Math.min(due, current.remainingStackBb);
      streetContributions[action.actor] += added;
      total[action.actor] += added;
      potBb += added;
      normalized.amountBb = added;
      if (current.remainingStackBb - added <= EPSILON) allInKind = 'call-all-in';
      if (added + EPSILON < due) {
        allInKind = 'call-all-in';
        const unmatched = due - added;
        returnUnmatched(other, unmatched);
      }
      streetTotalBb = streetContributions[action.actor];
    } else if (errors.length === errorCount && action.action === 'all_in') {
      added = current.remainingStackBb;
      streetTotalBb += added;
      if (due > EPSILON) {
        allInKind = added <= due + EPSILON ? 'call-all-in' : 'raise-all-in';
        if (added + EPSILON < due) {
          const unmatched = due - added;
          returnUnmatched(other, unmatched);
        }
      } else allInKind = highest > EPSILON ? 'raise-all-in' : 'bet-all-in';
      streetContributions[action.actor] = streetTotalBb;
      total[action.actor] += added;
      potBb += added;
      normalized.amountBb = null;
    } else if (errors.length === errorCount && ['bet', 'raise'].includes(action.action)) {
      const target = action.amountBb;
      if (target === null || !Number.isFinite(target) || target <= 0) error('Podaj dodatnią kwotę w bb.');
      else if (action.action === 'raise' && target <= highest) error(`Raise to musi być większy niż aktualny zakład (${highest.toFixed(2)} bb).`);
      else if (target < streetContributions[action.actor]) error('Kwota docelowa nie może być mniejsza od wcześniejszego wkładu na tej ulicy.');
      else {
        added = target - streetContributions[action.actor];
        if (added > current.remainingStackBb + EPSILON) error(`Gracz ma tylko ${current.remainingStackBb.toFixed(2)} BB w stacku.`);
        else {
          streetTotalBb = target;
          streetContributions[action.actor] = target;
          total[action.actor] += added;
          potBb += added;
          if (current.remainingStackBb - added <= EPSILON) allInKind = action.action === 'bet' ? 'bet-all-in' : 'raise-all-in';
        }
      }
    }
    if (errors.length === errorCount && action.action === 'fold') {
      foldedBy = action.actor;
      // Return the winner's uncalled wager; the matched pot is not awarded here.
      returnUnmatched(other, Math.max(0, streetContributions[other] - streetContributions[action.actor]));
    }
    if (errors.length === errorCount && action.actor === 'villain' && ['bet', 'raise', 'all_in'].includes(action.action)) {
      const after = players();
      const heroDue = Math.max(0, streetContributions.villain - streetContributions.hero);
      const legalCall = Math.min(heroDue, after.hero.remainingStackBb);
      // Only the unmatched excess is returned. A raise also matches earlier Hero chips.
      const contestableOpponentBetBb = Math.max(0, added - Math.max(0, heroDue - legalCall));
      const finalContestablePotBb = potBb - Math.max(0, added - contestableOpponentBetBb) + legalCall;
      const currentEffectiveStackBb = Math.min(after.hero.remainingStackBb, after.villain.remainingStackBb);
      decisionPoint = {
        potBeforeOpponentActionBb: potBb - added,
        opponentBetBb: added,
        contestableOpponentBetBb,
        callAmountBb: legalCall,
        amountDueBb: heroDue,
        canFullCall: legalCall + EPSILON >= heroDue,
        facingAllIn: after.villain.isAllIn,
        finalContestablePotBb,
        heroRemainingStackBb: after.hero.remainingStackBb,
        villainRemainingStackBb: after.villain.remainingStackBb,
        currentEffectiveStackBb,
        startingEffectiveStackBb,
        heroIsAllIn: after.hero.isAllIn,
        villainIsAllIn: after.villain.isAllIn,
        spr: potBb - Math.max(0, added - contestableOpponentBetBb) > 0 ? currentEffectiveStackBb / (potBb - Math.max(0, added - contestableOpponentBetBb)) : null,
        street,
      };
    }
    normalizedActions.push(normalized);
    actionResolutions.push({ additionalContributionBb: added, streetTotalBb, allInKind, player: players()[action.actor] });
  });
  // The visible board may be ahead of the last recorded action; still expose SPR for its current postflop street.
  if (streetOrder[throughStreet] > streetOrder[street]
    && !((players().hero.isAllIn || players().villain.isAllIn)
      && Math.abs(streetContributions.hero - streetContributions.villain) > EPSILON)) {
    street = throughStreet;
    streetContributions = { hero: 0, villain: 0 };
    streetStartPotBb = potBb;
    streetStartEffectiveStackBb = Math.min(players().hero.remainingStackBb, players().villain.remainingStackBb);
  }

  const last = actions.at(-1);
  if (!last || last.actor !== 'villain' || !['bet', 'raise', 'all_in'].includes(last.action) || errors.some(({ index }) => index === actions.length - 1)) decisionPoint = null;
  const finalPlayers = players();
  const currentEffectiveStackBb = Math.min(finalPlayers.hero.remainingStackBb, finalPlayers.villain.remainingStackBb);
  const currentWagerBb = Math.max(streetContributions.hero, streetContributions.villain);
  const streetStartSpr = streetStartPotBb > 0 && street !== 'preflop' && streetStartEffectiveStackBb !== null ? streetStartEffectiveStackBb / streetStartPotBb : null;
  const spr = potBb > 0 ? currentEffectiveStackBb / potBb : null;
  return {
    potBb,
    streetContributions,
    totalContributions: total,
    players: finalPlayers,
    startingEffectiveStackBb,
    currentEffectiveStackBb,
    streetStartPotBb,
    streetStartEffectiveStackBb,
    streetStartSpr,
    spr,
    currentWagerBb,
    amountToCall: { hero: Math.min(Math.max(0, currentWagerBb - streetContributions.hero), finalPlayers.hero.remainingStackBb), villain: Math.min(Math.max(0, currentWagerBb - streetContributions.villain), finalPlayers.villain.remainingStackBb) },
    decisionPoint,
    normalizedActions,
    actionResolutions,
    errors,
  };
}

/** Boundaries: 1 belongs to low, 3 and 6 belong to medium. */
export function getSprCategory(spr: number): 'very-low' | 'low' | 'medium' | 'high' {
  if (spr < 1) return 'very-low';
  if (spr < 3) return 'low';
  if (spr <= 6) return 'medium';
  return 'high';
}
