export type Suit = 's' | 'h' | 'd' | 'c';
export type Card = { rank: number; suit: Suit };
export type HandScore = { category: number; tiebreak: number[]; label: string };
export const suits: Suit[] = ['s', 'h', 'd', 'c'];
export const ranks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const rankLabel = (rank: number) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' } as Record<number, string>)[rank] ?? String(rank);
export const suitLabel = (suit: Suit) => ({ s: '♠', h: '♥', d: '♦', c: '♣' })[suit];
export const cardKey = (card: Card) => `${card.rank}${card.suit}`;
export const parseCard = (key: string): Card => ({ rank: Number(key.slice(0, -1)), suit: key.slice(-1) as Suit });
export const deck: Card[] = suits.flatMap((suit) => ranks.map((rank) => ({ rank, suit })));
const suitSet = new Set<string>(suits);
const handNames = ['Wysoka karta', 'Para', 'Dwie pary', 'Trójka', 'Strit', 'Kolor', 'Full', 'Kareta', 'Poker'];

export type EquityMethod = 'exact' | 'monte-carlo';
export type EquityResult = {
  equity: number;
  heroWinPercent: number;
  villainWinPercent: number;
  tiePercent: number;
  wins: number;
  ties: number;
  losses: number;
  /** Runouts for hand-vs-hand, combo/runout cases for ranges, or trials for Monte Carlo. */
  samples: number;
  method: EquityMethod;
  durationMs: number;
};
export const MAX_EXACT_EQUITY_CASES = 120_000;
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function isValidCard(card: Card): boolean {
  return Number.isInteger(card?.rank) && card.rank >= 2 && card.rank <= 14 && suitSet.has(card?.suit);
}

/** Checks Hold'em card counts, legal streets and physical card uniqueness. */
export function validateEquityInput(hero: Card[], board: Card[], villain: Card[] = []): void {
  if (!Array.isArray(hero) || hero.length !== 2) throw new RangeError('Hero must have exactly two hole cards.');
  if (!Array.isArray(board) || ![0, 3, 4, 5].includes(board.length)) throw new RangeError('Board must contain 0, 3, 4, or 5 cards.');
  if (!Array.isArray(villain) || villain.length > 2) throw new RangeError('Villain can have at most two hole cards.');
  const cards = [...hero, ...board, ...villain];
  if (cards.some((card) => !isValidCard(card))) throw new RangeError('A card has an invalid rank or suit.');
  if (new Set(cards.map(cardKey)).size !== cards.length) throw new RangeError('A physical card cannot appear more than once.');
}

function scoreFive(cards: Card[]): HandScore {
  const values = cards.map(({ rank }) => rank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique = [...new Set(values)].sort((a, b) => b - a);
  const wheel = unique.join(',') === '14,5,4,3,2';
  const straight = unique.length === 5 && (unique[0] - unique[4] === 4 || wheel);
  const straightHigh = wheel ? 5 : unique[0];
  let category = 0;
  let tiebreak: number[] = [];

  // Categories follow standard Hold'em order; tiebreak vectors compare kickers lexicographically.
  if (flush && straight) { category = 8; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 4) { category = 7; tiebreak = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { category = 6; tiebreak = [groups[0][0], groups[1][0]]; }
  else if (flush) { category = 5; tiebreak = values; }
  else if (straight) { category = 4; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 3) { category = 3; tiebreak = [groups[0][0], ...groups.slice(1).map((group) => group[0]).sort((a, b) => b - a)]; }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { category = 2; tiebreak = [Math.max(groups[0][0], groups[1][0]), Math.min(groups[0][0], groups[1][0]), groups[2][0]]; }
  else if (groups[0][1] === 2) { category = 1; tiebreak = [groups[0][0], ...groups.slice(1).map((group) => group[0]).sort((a, b) => b - a)]; }
  else tiebreak = values;
  return { category, tiebreak, label: handNames[category] };
}

export function compare(first: HandScore, second: HandScore): number {
  if (first.category !== second.category) return first.category - second.category;
  for (let i = 0; i < Math.max(first.tiebreak.length, second.tiebreak.length); i++) {
    const difference = (first.tiebreak[i] ?? 0) - (second.tiebreak[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function evaluate(cards: Card[]): HandScore {
  if (!Array.isArray(cards) || cards.length > 7) throw new RangeError('A Hold’em hand can contain at most seven cards.');
  if (cards.some((card) => !isValidCard(card))) throw new RangeError('A card has an invalid rank or suit.');
  if (new Set(cards.map(cardKey)).size !== cards.length) throw new RangeError('A physical card cannot appear more than once.');
  if (cards.length < 5) return { category: -1, tiebreak: [], label: cards.length ? 'Niepełny układ' : 'Brak układu' };
  let best: HandScore = { category: -1, tiebreak: [], label: '' };
  for (let a = 0; a < cards.length - 4; a++) for (let b = a + 1; b < cards.length - 3; b++) for (let c = b + 1; c < cards.length - 2; c++) for (let d = c + 1; d < cards.length - 1; d++) for (let e = d + 1; e < cards.length; e++) {
    const current = scoreFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    if (compare(current, best) > 0) best = current;
  }
  return best;
}

export type EquityOptions = { yieldEvery?: number; samples?: number; rng?: () => number; exactCaseLimit?: number; shouldCancel?: () => boolean; onProgress?: (progress: number) => void };
const choose = (n: number, k: number): number => {
  if (k < 0 || n < k) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i;
  return result;
};
function* combinations<T>(items: T[], count: number, start = 0, prefix: T[] = []): Generator<T[]> {
  if (prefix.length === count) { yield [...prefix]; return; }
  for (let i = start; i <= items.length - (count - prefix.length); i++) {
    prefix.push(items[i]); yield* combinations(items, count, i + 1, prefix); prefix.pop();
  }
}

/**
 * Calculates fixed hand vs fixed hand equity. All feasible runouts are enumerated;
 * the expensive preflop space (48 choose 5) falls back to chunked Monte Carlo.
 */
export async function calculateEquity(hero: Card[], board: Card[], villain: Card[], options: EquityOptions = {}): Promise<EquityResult> {
  validateEquityInput(hero, board, villain);
  if (villain.length !== 2) throw new RangeError('Known-hand equity requires exactly two villain hole cards.');
  const started = now();
  const samples = options.samples ?? 8_000;
  const exactCaseLimit = options.exactCaseLimit ?? MAX_EXACT_EQUITY_CASES;
  const sourceRng = options.rng ?? Math.random;
  const rng = () => { const value = sourceRng(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random generator must return a value in [0, 1).'); return value; };
  const yieldEvery = options.yieldEvery ?? 2_000;
  if (!Number.isInteger(yieldEvery) || yieldEvery < 1) throw new RangeError('Yield interval must be a positive integer.');
  const shouldCancel = options.shouldCancel;
  const onProgress = options.onProgress;
  if (!Number.isInteger(samples) || samples < 1) throw new RangeError('Monte Carlo sample count must be a positive integer.');
  if (!Number.isInteger(exactCaseLimit) || exactCaseLimit < 1) throw new RangeError('Exact enumeration limit must be a positive integer.');
  const known = [...hero, ...board, ...villain];
  const remaining = deck.filter((card) => !known.some((item) => cardKey(item) === cardKey(card)));
  const missingBoard = 5 - board.length;
  const exactRunouts = choose(remaining.length, missingBoard);
  let wins = 0; let ties = 0; let losses = 0; let total = 0;
  const record = (runout: Card[]) => {
    const outcome = compare(evaluate([...hero, ...board, ...runout]), evaluate([...villain, ...board, ...runout]));
    if (outcome > 0) wins++; else if (outcome < 0) losses++; else ties++;
    total++;
  };
  const result = (method: EquityMethod): EquityResult => ({
    wins, ties, losses, samples: total,
    equity: total ? (wins + ties / 2) / total : 0,
    heroWinPercent: total ? wins / total * 100 : 0,
    villainWinPercent: total ? losses / total * 100 : 0,
    tiePercent: total ? ties / total * 100 : 0,
    method, durationMs: now() - started,
  });

  if (exactRunouts <= exactCaseLimit) {
    for (const runout of combinations(remaining, missingBoard)) {
      if (shouldCancel?.()) break;
      record(runout);
      if (total % yieldEvery === 0) { onProgress?.(total / exactRunouts); await yieldToBrowser(); }
    }
    onProgress?.(1);
    return result('exact');
  }

  // Shuffle unseen board cards for each trial; bounded chunks let React paint progress/UI updates.
  for (let start = 0; start < samples; start += 200) {
    const end = Math.min(start + 200, samples);
    for (let trial = start; trial < end; trial++) {
      if (shouldCancel?.()) break;
      const runoutDeck = [...remaining];
      for (let i = runoutDeck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [runoutDeck[i], runoutDeck[j]] = [runoutDeck[j], runoutDeck[i]];
      }
      record(runoutDeck.slice(0, missingBoard));
    }
    onProgress?.(total / samples);
    if (end < samples) await yieldToBrowser();
  }
  return result('monte-carlo');
}

export function boardTexture(board: Card[]): string {
  if (!board.length) return 'Preflop';
  const boardRanks = board.map((card) => card.rank);
  const unique = new Set(boardRanks).size;
  const suitsCount = board.reduce((counts, card) => (counts[card.suit] = (counts[card.suit] || 0) + 1, counts), {} as Record<string, number>);
  const maxSuit = Math.max(...Object.values(suitsCount));
  const connected = Math.max(...boardRanks) - Math.min(...boardRanks) <= 4 && unique >= 3;
  return `${maxSuit >= 3 ? 'Monotonne' : maxSuit === 2 ? 'Dwukolorowa' : 'Tęczowa'} · ${connected ? 'Połączony' : 'Niesparowany'} board`;
}
