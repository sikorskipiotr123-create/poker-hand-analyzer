import { Card, calculateEquity, cardKey, compare, deck, evaluate, ranks, suits, EquityResult, EquityMethod, MAX_EXACT_EQUITY_CASES, validateEquityInput } from './poker';

export type RangeHandKey = string;
export type RangeHandType = 'pair' | 'suited' | 'offsuit';
export type RangeHand = { key: RangeHandKey; label: string; highRank: number; lowRank: number; type: RangeHandType };
export type RangeEquityResult = EquityResult & { method: EquityMethod };
export type EquitySide = { mode: 'hand'; cards: Card[] } | { mode: 'range'; range: RangeHandKey[] };
const displayRank = (rank: number) => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' } as Record<number, string>)[rank] ?? String(rank);
const descendingRanks = [...ranks].sort((a, b) => b - a);

export const RANGE_HANDS: RangeHand[] = descendingRanks.flatMap((rowRank) => descendingRanks.map((columnRank): RangeHand => {
  if (rowRank === columnRank) return { key: `${rowRank}${rowRank}p`, label: `${displayRank(rowRank)}${displayRank(rowRank)}`, highRank: rowRank, lowRank: rowRank, type: 'pair' };
  const highRank = Math.max(rowRank, columnRank); const lowRank = Math.min(rowRank, columnRank); const type = rowRank > columnRank ? 'suited' : 'offsuit';
  return { key: `${highRank}${lowRank}${type === 'suited' ? 's' : 'o'}`, label: `${displayRank(highRank)}${displayRank(lowRank)}${type === 'suited' ? 's' : 'o'}`, highRank, lowRank, type };
}));

export function getRangeHand(key: RangeHandKey): RangeHand | undefined { return RANGE_HANDS.find((hand) => hand.key === key); }

/** Returns the matrix class for two actual hole cards (for membership checks). */
export function getRangeHandKey(cards: readonly Card[]): RangeHandKey | null {
  if (cards.length !== 2) return null;
  const [first, second] = cards;
  if (first.rank === second.rank) return `${first.rank}${second.rank}p`;
  const highRank = Math.max(first.rank, second.rank);
  const lowRank = Math.min(first.rank, second.rank);
  return `${highRank}${lowRank}${first.suit === second.suit ? 's' : 'o'}`;
}

export function includesActualHand(cards: readonly Card[], selected: Iterable<RangeHandKey>): boolean | null {
  const key = getRangeHandKey(cards);
  return key === null ? null : new Set(selected).has(key);
}

/** Generates every physical two-card combo represented by one matrix cell. */
export function getHandCombinations(hand: RangeHand): [Card, Card][] {
  if (hand.type === 'pair') {
    const cards = suits.map((suit) => ({ rank: hand.highRank, suit })); const combos: [Card, Card][] = [];
    for (let a = 0; a < cards.length; a++) for (let b = a + 1; b < cards.length; b++) combos.push([cards[a], cards[b]]);
    return combos;
  }
  if (hand.type === 'suited') return suits.map((suit) => [{ rank: hand.highRank, suit }, { rank: hand.lowRank, suit }]);
  return suits.flatMap((highSuit) => suits.filter((lowSuit) => lowSuit !== highSuit).map((lowSuit) => [
    { rank: hand.highRank, suit: highSuit }, { rank: hand.lowRank, suit: lowSuit },
  ] as [Card, Card]));
}

export function getAvailableRangeCombinations(selected: Iterable<RangeHandKey>, blockers: Card[]): [Card, Card][] {
  const blocked = new Set(blockers.map(cardKey)); const seen = new Set<string>(); const result: [Card, Card][] = [];
  for (const key of selected) {
    const hand = getRangeHand(key); if (!hand) continue;
    for (const combo of getHandCombinations(hand)) {
      const comboKey = combo.map(cardKey).sort().join('|');
      if (!blocked.has(cardKey(combo[0])) && !blocked.has(cardKey(combo[1])) && !seen.has(comboKey)) { seen.add(comboKey); result.push(combo); }
    }
  }
  return result;
}

export function getRangePreset(preset: 'tight' | 'standard' | 'wide'): RangeHandKey[] {
  return RANGE_HANDS.filter(({ type, highRank, lowRank }) => {
    if (preset === 'wide') return true;
    if (preset === 'tight') {
      if (type === 'pair') return highRank >= 8;
      if (type === 'suited') return (highRank === 14 && lowRank >= 10) || (highRank === 13 && lowRank >= 12);
      return (highRank === 14 && lowRank >= 12) || (highRank === 13 && lowRank === 12);
    }
    if (type === 'pair') return true;
    if (type === 'suited') return highRank === 14 || (highRank >= 10 && lowRank >= 8) || (highRank - lowRank <= 1 && highRank >= 5);
    return (highRank === 14 && lowRank >= 10) || (highRank === 13 && lowRank >= 11) || (highRank === 12 && lowRank === 11);
  }).map(({ key }) => key);
}

export function getLegacyRangePreset(preset: 'random' | 'broadway' | 'pairs'): RangeHandKey[] {
  if (preset === 'random') return getRangePreset('wide');
  return RANGE_HANDS.filter(({ type, highRank, lowRank }) => preset === 'pairs' ? type === 'pair' : type !== 'pair' && highRank >= 10 && lowRank >= 10).map(({ key }) => key);
}

const combinations = (n: number, k: number): number => { if (k < 0 || n < k) return 0; let result = 1; for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i; return result; };
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Every legal physical combo has equal weight; exhaustive combo/runout evaluation is preferred under the shared case limit. */
export async function calculateRangeEquity(
  hero: Card[], board: Card[], range: Iterable<RangeHandKey>,
  options: { samples?: number; blockers?: Card[]; knownVillain?: Card[]; onProgress?: (progress: number) => void; shouldCancel?: () => boolean; rng?: () => number; exactCaseLimit?: number } = {},
): Promise<RangeEquityResult> {
  const { samples = 8000, blockers = [], knownVillain = [], onProgress, shouldCancel, rng: sourceRng = Math.random, exactCaseLimit = MAX_EXACT_EQUITY_CASES } = options;
  const rng = () => { const value = sourceRng(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random generator must return a value in [0, 1).'); return value; };
  validateEquityInput(hero, board, knownVillain);
  validateEquityInput(hero, board, [...blockers, ...knownVillain]);
  if (!Number.isInteger(samples) || samples < 1) throw new RangeError('Monte Carlo sample count must be a positive integer.');
  if (!Number.isInteger(exactCaseLimit) || exactCaseLimit < 1) throw new RangeError('Exact enumeration limit must be a positive integer.');
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = (wins: number, ties: number, losses: number, total: number, method: EquityMethod): RangeEquityResult => ({ wins, ties, losses, samples: total, equity: total ? (wins + ties / 2) / total : 0, heroWinPercent: total ? wins / total * 100 : 0, villainWinPercent: total ? losses / total * 100 : 0, tiePercent: total ? ties / total * 100 : 0, method, durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started });
  const known = [...hero, ...board, ...blockers];
  const combos = getAvailableRangeCombinations(range, known).filter((combo) => knownVillain.every((knownCard) => combo.some((card) => cardKey(card) === cardKey(knownCard))));
  if (!combos.length) throw new RangeError('The selected range has no legal combinations after blockers.');
  const availableDeck = deck.filter((card) => !known.some((item) => cardKey(item) === cardKey(card)));
  const missingBoard = 5 - board.length; const runoutsPerCombo = combinations(availableDeck.length - 2, missingBoard);
  const canEnumerate = combos.length * runoutsPerCombo <= exactCaseLimit;
  let wins = 0; let ties = 0; let losses = 0; let total = 0;
  const score = (villain: Card[], runout: Card[]) => {
    const result = compare(evaluate([...hero, ...board, ...runout]), evaluate([...villain, ...board, ...runout]));
    if (result > 0) wins++; else if (result === 0) ties++; else losses++; total++;
  };

  if (canEnumerate) {
    let sinceYield = 0;
    for (let index = 0; index < combos.length; index++) {
      if (shouldCancel?.()) return result(wins, ties, losses, total, 'exact');
      const villain = combos[index]; const runoutDeck = availableDeck.filter((card) => !villain.some((knownCard) => cardKey(knownCard) === cardKey(card))); const runout: Card[] = [];
      const visit = (start: number) => {
        if (runout.length === missingBoard) { score(villain, runout); return; }
        for (let i = start; i <= runoutDeck.length - (missingBoard - runout.length); i++) { runout.push(runoutDeck[i]); visit(i + 1); runout.pop(); }
      };
      visit(0); sinceYield += runoutsPerCombo;
      if (sinceYield >= 2400) { sinceYield = 0; onProgress?.(index / combos.length); await yieldToBrowser(); }
    }
    onProgress?.(1);
    return result(wins, ties, losses, total, 'exact');
  }

  const targetSamples = Math.max(1, samples);
  for (let start = 0; start < targetSamples; start += 200) {
    if (shouldCancel?.()) return result(wins, ties, losses, total, 'monte-carlo');
    const end = Math.min(start + 200, targetSamples);
    for (let i = start; i < end; i++) {
      const villain = combos[Math.floor(rng() * combos.length)];
      const runoutDeck = availableDeck.filter((card) => !villain.some((knownCard) => cardKey(knownCard) === cardKey(card)));
      for (let j = runoutDeck.length - 1; j > 0; j--) { const k = Math.floor(rng() * (j + 1)); [runoutDeck[j], runoutDeck[k]] = [runoutDeck[k], runoutDeck[j]]; }
      score(villain, runoutDeck.slice(0, missingBoard));
    }
    onProgress?.(end / targetSamples);
    if (end < targetSamples) await yieldToBrowser();
  }
  return result(wins, ties, losses, total, 'monte-carlo');
}



/** Exact or simulated equity for two unweighted physical-card ranges.
 * Each compatible physical combo pair and each legal runout have equal weight.
 */
export async function calculateRangeVsRangeEquity(
  heroRange: Iterable<RangeHandKey>, villainRange: Iterable<RangeHandKey>, board: Card[],
  options: { samples?: number; onProgress?: (progress: number) => void; shouldCancel?: () => boolean; rng?: () => number; exactCaseLimit?: number } = {},
): Promise<RangeEquityResult> {
  const heroKeys = [...heroRange]; const villainKeys = [...villainRange];
  if (!heroKeys.length) throw new RangeError('Hero range is empty. Select at least one hand class.');
  if (!villainKeys.length) throw new RangeError('Villain range is empty. Select at least one hand class.');
  if (heroKeys.some((key) => !getRangeHand(key))) throw new RangeError('Hero range contains an invalid hand class.');
  if (villainKeys.some((key) => !getRangeHand(key))) throw new RangeError('Villain range contains an invalid hand class.');
  if (!Array.isArray(board) || ![0, 3, 4, 5].includes(board.length)) throw new RangeError('Board must contain 0, 3, 4, or 5 cards.');
  if (board.some((card) => !Number.isInteger(card.rank) || card.rank < 2 || card.rank > 14 || !suits.includes(card.suit))) throw new RangeError('A card has an invalid rank or suit.');
  if (new Set(board.map(cardKey)).size !== board.length) throw new RangeError('A physical card cannot appear more than once.');
  const { samples = 8000, onProgress, shouldCancel, rng: sourceRng = Math.random, exactCaseLimit = MAX_EXACT_EQUITY_CASES } = options;
  if (!Number.isInteger(samples) || samples < 1) throw new RangeError('Monte Carlo sample count must be a positive integer.');
  if (!Number.isInteger(exactCaseLimit) || exactCaseLimit < 1) throw new RangeError('Exact enumeration limit must be a positive integer.');
  const rng = () => { const value = sourceRng(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random generator must return a value in [0, 1).'); return value; };
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const heroCombos = getAvailableRangeCombinations(heroKeys, board);
  const villainCombos = getAvailableRangeCombinations(villainKeys, board);
  if (!heroCombos.length) throw new RangeError('Hero range has no legal combinations after board blockers.');
  if (!villainCombos.length) throw new RangeError('Villain range has no legal combinations after board blockers.');

  // Group legal Villain indices by Hero combo. A 16-bit index covers all 1,326 Hold’em combos.
  const offsets = new Uint32Array(heroCombos.length + 1);
  let totalPairs = 0;
  for (let h = 0; h < heroCombos.length; h++) {
    offsets[h] = totalPairs;
    const [h1, h2] = heroCombos[h];
    for (const [v1, v2] of villainCombos) if (cardKey(h1) !== cardKey(v1) && cardKey(h1) !== cardKey(v2) && cardKey(h2) !== cardKey(v1) && cardKey(h2) !== cardKey(v2)) totalPairs++;
    if (h % 32 === 31) { onProgress?.((h / heroCombos.length) * 0.04); await yieldToBrowser(); if (shouldCancel?.()) throw new Error('Equity calculation cancelled.'); }
  }
  offsets[heroCombos.length] = totalPairs;
  if (!totalPairs) throw new RangeError('The selected ranges have no legal Hero/Villain combination pairs.');
  const pairVillains = new Uint16Array(totalPairs);
  let cursor = 0;
  for (let h = 0; h < heroCombos.length; h++) {
    const [h1, h2] = heroCombos[h];
    for (let v = 0; v < villainCombos.length; v++) {
      const [v1, v2] = villainCombos[v];
      if (cardKey(h1) !== cardKey(v1) && cardKey(h1) !== cardKey(v2) && cardKey(h2) !== cardKey(v1) && cardKey(h2) !== cardKey(v2)) pairVillains[cursor++] = v;
    }
    if (h % 32 === 31) { onProgress?.(0.04 + (h / heroCombos.length) * 0.04); await yieldToBrowser(); if (shouldCancel?.()) throw new Error('Equity calculation cancelled.'); }
  }
  const missingBoard = 5 - board.length;
  const available = deck.filter((card) => !board.some((known) => cardKey(known) === cardKey(card)));
  const runoutsPerPair = combinations(available.length - 4, missingBoard);
  const exactCases = totalPairs * runoutsPerPair;
  let wins = 0; let ties = 0; let losses = 0; let total = 0;
  const record = (hero: [Card, Card], villain: [Card, Card], runout: Card[]) => {
    const outcome = compare(evaluate([...hero, ...board, ...runout]), evaluate([...villain, ...board, ...runout]));
    if (outcome > 0) wins++; else if (outcome < 0) losses++; else ties++;
    total++;
  };
  const result = (method: EquityMethod): RangeEquityResult => ({ wins, ties, losses, samples: total, equity: total ? (wins + ties / 2) / total : 0, heroWinPercent: total ? wins / total * 100 : 0, villainWinPercent: total ? losses / total * 100 : 0, tiePercent: total ? ties / total * 100 : 0, method, durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started });

  if (exactCases <= exactCaseLimit) {
    let sinceYield = 0;
    for (let h = 0; h < heroCombos.length; h++) {
      for (let pair = offsets[h]; pair < offsets[h + 1]; pair++) {
        if (shouldCancel?.()) return result('exact');
        const hero = heroCombos[h]; const villain = villainCombos[pairVillains[pair]];
        const runoutDeck = available.filter((card) => !hero.some((known) => cardKey(known) === cardKey(card)) && !villain.some((known) => cardKey(known) === cardKey(card)));
        const runout: Card[] = [];
        const visit = (startIndex: number) => {
          if (runout.length === missingBoard) { record(hero, villain, runout); return; }
          for (let i = startIndex; i <= runoutDeck.length - (missingBoard - runout.length); i++) { runout.push(runoutDeck[i]); visit(i + 1); runout.pop(); }
        };
        visit(0); sinceYield += runoutsPerPair;
        if (sinceYield >= 2400) { sinceYield = 0; onProgress?.(total / exactCases); await yieldToBrowser(); }
      }
    }
    onProgress?.(1);
    return result('exact');
  }

  // Uniform integer indexing over compatible physical combo pairs avoids range-class weighting.
  for (let start = 0; start < samples; start += 200) {
    if (shouldCancel?.()) return result('monte-carlo');
    const end = Math.min(start + 200, samples);
    for (let trial = start; trial < end; trial++) {
      const pairIndex = Math.floor(rng() * totalPairs);
      let low = 0; let high = heroCombos.length;
      while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid + 1] <= pairIndex) low = mid + 1; else high = mid; }
      const hero = heroCombos[low]; const villain = villainCombos[pairVillains[pairIndex]];
      const runoutDeck = available.filter((card) => !hero.some((known) => cardKey(known) === cardKey(card)) && !villain.some((known) => cardKey(known) === cardKey(card)));
      for (let i = runoutDeck.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [runoutDeck[i], runoutDeck[j]] = [runoutDeck[j], runoutDeck[i]]; }
      record(hero, villain, runoutDeck.slice(0, missingBoard));
    }
    onProgress?.(end / samples);
    if (end < samples) await yieldToBrowser();
  }
  return result('monte-carlo');
}

/** Routes the four matchup modes through the shared hand evaluator and card logic. */
export async function calculateMatchupEquity(hero: EquitySide, board: Card[], villain: EquitySide, options: Parameters<typeof calculateEquity>[3] & { blockers?: Card[] } = {}): Promise<RangeEquityResult> {
  if (hero.mode === 'hand' && villain.mode === 'hand') return calculateEquity(hero.cards, board, villain.cards, options);
  if (hero.mode === 'hand' && villain.mode === 'range') return calculateRangeEquity(hero.cards, board, villain.range, options);
  if (hero.mode === 'range' && villain.mode === 'range') return calculateRangeVsRangeEquity(hero.range, villain.range, board, options);
  const reversed = await calculateRangeEquity(villain.mode === 'hand' ? villain.cards : [], board, hero.mode === 'range' ? hero.range : [], options);
  return { ...reversed, wins: reversed.losses, losses: reversed.wins, heroWinPercent: reversed.villainWinPercent, villainWinPercent: reversed.heroWinPercent, equity: 1 - reversed.equity };
}

/** Counts currently legal physical combos while leaving selected matrix classes untouched. */
export function getRangeSummary(selectedRange: Iterable<RangeHandKey>, blockers: Card[]) {
  const selectedHands = [...selectedRange];
  const selectedCombos = getAvailableRangeCombinations(selectedHands, blockers).length;
  const availableCombos = getAvailableRangeCombinations(RANGE_HANDS.map((hand) => hand.key), blockers).length;
  return { selectedHandClasses: selectedHands.length, selectedCombos, availableCombos, percentage: availableCombos ? selectedCombos / availableCombos * 100 : 0 };
}
