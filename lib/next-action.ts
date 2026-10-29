import type { ActionDraft, ActionType, Position, Street } from './ai-context';
import { calculateActionState, isAllInBettingComplete, type ActionStateResult, type BlindConfig, type Player, type StartingStacks } from './action-state';

export type NextActionSuggestion = {
  player: 'hero' | 'villain' | null;
  street: Street;
  defaultAction: ActionType | null;
  callAmountBb: number;
  callIsAllIn: boolean;
  advancedStreet: boolean;
  bettingRoundComplete: boolean;
  reason: 'fold' | 'all-in' | 'invalid' | 'river-complete' | null;
};

const preflopOrder: Position[] = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const postflopOrder: Position[] = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'];
const streetNext: Record<Street, Street | null> = { preflop: 'flop', flop: 'turn', turn: 'river', river: null };
export function getNextStreet(street: Street): Street | null { return streetNext[street]; }

/** Legal UI choices are derived from the replay immediately before the selected action. */
export function getLegalActions(state: ActionStateResult, player: Player): ActionType[] {
  if (state.errors.length || state.players[player].isAllIn || isAllInBettingComplete(state) || state.normalizedActions.some(action => action.action === 'fold')) return [];
  const other: Player = player === 'hero' ? 'villain' : 'hero';
  const current = state.players[player];
  const opponent = state.players[other];
  const due = state.amountToCall[player];
  const legal: ActionType[] = ['fold'];

  if (due > 0) {
    legal.push('call');
    if (!opponent.isAllIn && current.remainingStackBb > due + 1e-8) legal.push('raise');
    if (!opponent.isAllIn || current.remainingStackBb <= due + 1e-8) legal.push('all_in');
    return legal;
  }

  legal.push('check');
  if (opponent.isAllIn) return legal;
  if (state.currentWagerBb > 0) {
    if (current.remainingStackBb > 0) legal.push('raise', 'all_in');
  } else {
    legal.push('bet');
    if (current.remainingStackBb > 0) legal.push('all_in');
  }
  return legal;
}

function firstPlayer(street: Street, positions: { hero: Position; villain: Position }): 'hero' | 'villain' {
  const order = street === 'preflop' ? preflopOrder : postflopOrder;
  return order.indexOf(positions.hero) < order.indexOf(positions.villain) ? 'hero' : 'villain';
}

/** Uses the replayed action history as the source of truth; it never chooses a strategy. */
export function suggestNextAction(
  actions: ActionDraft[],
  positions: { hero: Position; villain: Position },
  blinds: BlindConfig,
  stacks: StartingStacks,
): NextActionSuggestion {
  // The current street comes from the action history, not the board-card count.
  const currentStreet = actions.at(-1)?.street ?? 'preflop';
  const replay = calculateActionState(actions, positions, blinds, stacks, currentStreet);
  const none = (street: Street, reason: NextActionSuggestion['reason'], bettingRoundComplete = false): NextActionSuggestion => ({
    player: null, street, defaultAction: null, callAmountBb: 0, callIsAllIn: false,
    advancedStreet: false, bettingRoundComplete, reason,
  });

  if (replay.errors.length) return none(currentStreet, 'invalid');
  if (actions.some((action) => action.action === 'fold')) return none(currentStreet, 'fold');
  if (isAllInBettingComplete(replay)) return none(currentStreet, 'all-in', true);

  const streetActions = actions.filter((action) => action.street === currentStreet);
  const last = streetActions.at(-1);
  const nextPlayer = last ? (last.actor === 'hero' ? 'villain' : 'hero') : firstPlayer(currentStreet, positions);
  let player = nextPlayer;
  if (replay.players[player].isAllIn) player = player === 'hero' ? 'villain' : 'hero';
  if (replay.players[player].isAllIn) return none(currentStreet, 'all-in');

  // Resolve the player and any outstanding wager before considering street advancement.
  const callAmountBb = replay.amountToCall[player];
  if (callAmountBb > 0) {
    return {
      player, street: currentStreet, defaultAction: 'call', callAmountBb,
      callIsAllIn: callAmountBb >= replay.players[player].remainingStackBb - 1e-8,
      advancedStreet: false, bettingRoundComplete: false, reason: null,
    };
  }

  const bbOptionRemainsAfterCall = () => {
    if (currentStreet !== 'preflop' || !last) return false;
    const other = last.actor === 'hero' ? 'villain' : 'hero';
    // In heads-up preflop, the big blind still has the option to check after a limp.
    return positions[other] === 'BB'
      && !streetActions.slice(0, -1).some((action) => action.actor === other || ['bet', 'raise', 'all_in'].includes(action.action));
  };
  let bettingRoundComplete = false;
  if (last?.action === 'call') bettingRoundComplete = !bbOptionRemainsAfterCall();
  if (last?.action === 'all_in') {
    const lastIndex = actions.lastIndexOf(last);
    const isCallAllIn = replay.actionResolutions[lastIndex]?.allInKind === 'call-all-in';
    bettingRoundComplete = isCallAllIn && !bbOptionRemainsAfterCall();
  }
  if (last?.action === 'check' && streetActions.length >= 2) {
    const previous = streetActions.at(-2)!;
    const checkedAround = previous.action === 'check' && previous.actor !== last.actor;
    const previousIndex = actions.lastIndexOf(previous);
    const previousWasCall = previous.action === 'call' || (previous.action === 'all_in' && replay.actionResolutions[previousIndex]?.allInKind === 'call-all-in');
    const bigBlindCheckedAfterLimp = currentStreet === 'preflop' && previousWasCall && positions[last.actor] === 'BB';
    bettingRoundComplete = checkedAround || bigBlindCheckedAfterLimp;
  }

  if (!bettingRoundComplete) {
    return {
      player, street: currentStreet, defaultAction: 'check', callAmountBb: 0,
      callIsAllIn: false, advancedStreet: false, bettingRoundComplete: false, reason: null,
    };
  }

  const followingStreet = getNextStreet(currentStreet);
  if (!followingStreet) return { ...none(currentStreet, 'river-complete', true), bettingRoundComplete: true };

  // Advance exactly one street, then replay there so its first action uses the same stacks/pot.
  const nextState = calculateActionState(actions, positions, blinds, stacks, followingStreet);
  if (nextState.errors.length) return none(currentStreet, 'invalid');
  if (isAllInBettingComplete(nextState)) return none(followingStreet, 'all-in', true);

  let first = firstPlayer(followingStreet, positions);
  if (nextState.players[first].isAllIn) first = first === 'hero' ? 'villain' : 'hero';
  if (nextState.players[first].isAllIn) return none(followingStreet, 'all-in', true);
  const nextCall = nextState.amountToCall[first];
  return {
    player: first, street: followingStreet, defaultAction: nextCall > 0 ? 'call' : 'check',
    callAmountBb: nextCall, callIsAllIn: nextCall > 0 && nextCall >= nextState.players[first].remainingStackBb - 1e-8,
    advancedStreet: true, bettingRoundComplete: true, reason: null,
  };
}
