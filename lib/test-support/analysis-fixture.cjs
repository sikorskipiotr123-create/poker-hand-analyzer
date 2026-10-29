// Synthetic deals only. Shared by regression tests and the offline benchmark.
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { calculateActionState } = require('../action-state.ts');
const { suggestNextAction } = require('../next-action.ts');
const { serializeActions } = require('../ai-context.ts');
const { calculateCallAnalysis } = require('../calculations.ts');
const { getRangeSummary, RANGE_HANDS } = require('../range.ts');
const { toCard } = require('../ai-analysis.ts');
const action = (street, actor, type, amountBb = null) => ({ street, actor, action: type, amountBb });
const checksToRiver = [action('preflop', 'hero', 'raise', 2.5), action('preflop', 'villain', 'call'), action('flop', 'villain', 'check'), action('flop', 'hero', 'check'), action('turn', 'villain', 'check'), action('turn', 'hero', 'check')];
function fixture(options = {}) {
  const positions = options.positions ?? { hero: 'CO', villain: 'BB' };
  const blinds = options.blinds ?? { smallBlindBb: 0.5, bigBlindBb: 1 };
  const stacks = options.stacks ?? { hero: 100, villain: 100 };
  const actions = options.actions ?? [...checksToRiver, action('river', 'villain', 'bet', 20)];
  const next = suggestNextAction(actions, positions, blinds, stacks);
  const state = calculateActionState(actions, positions, blinds, stacks, next.street);
  const decision = state.decisionPoint?.amountDueBb > 1e-7 ? state.decisionPoint : null;
  const equity = options.equity ?? { status: 'unknown', reason: 'missing-cards' };
  const math = calculateCallAnalysis(decision?.potBeforeOpponentActionBb ?? state.potBb, decision?.contestableOpponentBetBb ?? 0, decision?.callAmountBb ?? 0, equity.status === 'known' ? equity.value : null);
  const stack = name => ({ startingStackBb: state.players[name].startingStackBb, remainingStackBb: state.players[name].remainingStackBb, isAllIn: state.players[name].isAllIn });
  const context = {
    language: options.language ?? 'en', blinds,
    hero: { cards: options.hero ?? ['As', 'Qh'], position: positions.hero, range: { mode: 'auto' } },
    villain: { cards: options.villain ?? ['Jc', 'Jd'], position: positions.villain, profile: 'unknown', stats: { vpip: null, pfr: null, threeBet: null, aggressionFactor: null }, range: { mode: 'auto' } },
    board: options.board ?? ['Qs', '7d', '4c', '2h', '9s'],
    actionHistory: serializeActions(state.normalizedActions, positions.hero, positions.villain, state.actionResolutions),
    pot: { currentPotBb: math.pot, villainBetBb: math.villainBet, callAmountBb: math.callAmount, finalPotBb: math.finalPot },
    stackState: { hero: stack('hero'), villain: stack('villain'), startingEffectiveStackBb: state.startingEffectiveStackBb, currentEffectiveStackBb: state.currentEffectiveStackBb, spr: decision?.spr ?? state.spr, streetStartPotBb: state.streetStartPotBb, streetStartEffectiveStackBb: state.streetStartEffectiveStackBb, streetStartSpr: state.streetStartSpr, facingAllIn: decision?.facingAllIn ?? false, canFullCall: decision?.canFullCall ?? false },
    mathematicalContext: { equity, requiredEquity: math.requiredEquity, callEV: equity.status === 'known' && math.callAmount > 0 ? { status: 'known', value: math.callEv } : { status: 'unknown', reason: equity.status === 'unknown' ? 'equity-unknown' : 'no-active-call' } },
  };
  if (options.range) {
    const keys = options.range.map(label => RANGE_HANDS.find(hand => hand.label === label).key);
    const summary = getRangeSummary(keys, [...context.hero.cards, ...context.board].map(toCard));
    context.villain.range = { mode: 'custom', selectedHands: options.range, comboCount: summary.selectedCombos, percentage: summary.percentage };
  }
  return context;
}
const known = (value, options = {}) => ({ status: 'known', value, source: 'known-hand', villainEquity: 1 - value, tiePercent: 0, method: 'exact', evaluatedCases: 1, ...options });
module.exports = { fixture, action, checksToRiver, known };
