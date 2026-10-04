'use client';
import { getAvailableRangeCombinations, getHandCombinations, getRangePreset, getRangeSummary, RANGE_HANDS, type RangeHandKey } from '../lib/range';
import type { Card } from '../lib/poker';
import { useLanguage } from './providers';

type Props = {
  title: string;
  eyebrow: string;
  description: string;
  selectedRange: RangeHandKey[];
  onRangeChange: (next: RangeHandKey[]) => void;
  blockers: Card[];
  equity?: number | null;
  calculating?: boolean;
  progress?: number;
  showEquity?: boolean;
};

/** Shared 13x13 range editor used by Mathematical Analysis and custom AI ranges. */
export function RangeMatrixPanel({ title, eyebrow, description, selectedRange, onRangeChange, blockers, equity = null, calculating = false, progress = 0, showEquity = true }: Props) {
  const { t, number } = useLanguage();
  const selected = new Set(selectedRange);
  const allKeys = RANGE_HANDS.map((hand) => hand.key);
  const available = getAvailableRangeCombinations(allKeys, blockers).length;
  const chosen = getAvailableRangeCombinations(selectedRange, blockers).length;
  const percentage = available ? chosen / available * 100 : 0;
  const choosePreset = (preset: 'tight' | 'standard' | 'wide') => onRangeChange(getRangePreset(preset));
  return <section className={`surface range-matrix-panel ${showEquity ? '' : 'range-matrix-compact'}`} aria-label={title}>
    <div className="range-matrix-header"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{description}</p></div><div className="range-toolbar"><button type="button" onClick={() => onRangeChange(allKeys)} className="button button-secondary">{t('selectAll')}</button><button type="button" onClick={() => onRangeChange([])} className="button button-secondary">{t('clear')}</button></div></div>
    <div className="range-preset-row"><span>{t('preset')}</span><div>{(['tight', 'standard', 'wide'] as const).map((preset) => <button type="button" key={preset} className={`range-preset ${selectedRange.length === getRangePreset(preset).length && getRangePreset(preset).every((key) => selected.has(key)) ? 'active' : ''}`} onClick={() => choosePreset(preset)}>{preset === 'tight' ? t('tight') : preset === 'standard' ? t('standard') : t('wide')}</button>)}</div></div>
    <div className="range-layout"><div className="range-matrix-wrap"><div className="range-matrix" role="group" aria-label={`${title}: ${t('rangeMatrixLabel')}`}>{RANGE_HANDS.map((hand) => { const combinations = getHandCombinations(hand); const availableCombos = getAvailableRangeCombinations([hand.key], blockers).length; const isSelected = selected.has(hand.key); return <button type="button" key={hand.key} aria-pressed={isSelected} disabled={!availableCombos && !isSelected} title={t('comboTooltip',{hand:hand.label,available:availableCombos,total:combinations.length})} className={`matrix-cell matrix-${hand.type} ${isSelected ? 'matrix-selected' : ''} ${!availableCombos ? 'matrix-blocked' : ''}`} onClick={() => onRangeChange(isSelected ? selectedRange.filter((key) => key !== hand.key) : [...selectedRange, hand.key])}><span>{hand.label}</span>{availableCombos < combinations.length && <small>{availableCombos}/{combinations.length}</small>}</button>; })}</div>
      <div className="matrix-legend"><span><i className="legend-pair"/> {t('pair')}</span><span><i className="legend-suited"/> {t('suited')}</span><span><i className="legend-offsuit"/> {t('offsuit')}</span><span><i className="legend-selected"/> {t('selected')}</span></div><p className="matrix-help">{t('matrixHelp')}</p></div>
      <aside className="range-summary"><div className="range-summary-title"><span className="player-kicker">{t('selectedRange')}</span><strong>{number(percentage,1)}<small>%</small></strong><span>{t('legalCombosAvailable')}</span></div><div className="range-stat"><span>{t('combinations')}</span><strong>{number(chosen,0)} <small>/ {number(available,0)}</small></strong></div><div className="range-stat"><span>{t('selectedClasses')}</span><strong>{selected.size} <small>/ 169</small></strong></div>{showEquity && <div className="range-equity-stat"><span>{t('heroEquity')}</span>{calculating ? <strong className="range-calculating"><i/> {t('calculatingEquity')}</strong> : <strong>{equity === null ? '—' : `${number(equity * 100,1)}%`}</strong>}{calculating && <div className="progress-track"><i style={{ width: `${Math.max(4, progress * 100)}%` }}/></div>}</div>}{showEquity && <p>{t('matrixEquityExplanation')}</p>}</aside>
    </div>
    <div className="range-blocker-note">{blockers.length ? t('blockedCards', { count: number(blockers.length,0) }) : t('enterCardsForBlockers')}</div>
  </section>;
}
