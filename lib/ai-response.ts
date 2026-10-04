import { STREETS, type Street, type AIAnalysisContext } from './ai-context';
import { createMathematicalSummary, deriveInputQuality, type AIAnalysisResult } from './ai-analysis';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number, min = 1): value is string => typeof value === 'string' && value.trim().length >= min && value.length <= max;
const hasKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const STREET_FIELDS = ['assessment', 'explanation'];
const BASE_FIELDS = ['situationSummary', 'mathematicalContext', 'streetAnalysis', 'rangeAnalysis', 'opponentAnalysis', 'recommendedLine', 'keyTakeaways', 'confidence', 'missingInformation'];

const nullableStreetSchema = {
  anyOf: [
    { type: 'null' },
    { type: 'object', properties: { assessment: { type: 'string' }, explanation: { type: 'string' } }, required: STREET_FIELDS, additionalProperties: false },
  ],
};
/** OpenAI Responses Structured Outputs schema, kept alongside its runtime validator. */
export const AI_ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    situationSummary: { type: 'string' },
    mathematicalContext: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    streetAnalysis: { type: 'object', properties: { preflop: nullableStreetSchema, flop: nullableStreetSchema, turn: nullableStreetSchema, river: nullableStreetSchema }, required: [...STREETS], additionalProperties: false },
    rangeAnalysis: { type: 'object', properties: { hero: { type: 'string' }, villain: { type: 'string' }, interaction: { type: 'string' } }, required: ['hero', 'villain', 'interaction'], additionalProperties: false },
    opponentAnalysis: { type: 'string' },
    recommendedLine: { type: 'object', properties: { action: { type: 'string' }, explanation: { type: 'string' } }, required: ['action', 'explanation'], additionalProperties: false },
    keyTakeaways: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    missingInformation: { type: 'array', items: { type: 'string' } },
  },
  required: BASE_FIELDS,
  additionalProperties: false,
} as const;

/** Validates model content, then replaces math summary and uncertainty with server-derived facts. */
export function validateAIAnalysisResult(value: unknown, context: AIAnalysisContext): AIAnalysisResult {
  if (!isObject(value) || !hasKeys(value, BASE_FIELDS)) throw new Error('The AI response did not match the hand-review format.');
  if (!isObject(value.mathematicalContext) || !hasKeys(value.mathematicalContext, ['summary']) || !isText(value.mathematicalContext.summary, 1200)) throw new Error('The AI response has an invalid mathematical section.');
  if (!isObject(value.streetAnalysis) || !hasKeys(value.streetAnalysis, [...STREETS])) throw new Error('The AI response has an invalid street analysis.');
  const streetAnalysis = {} as AIAnalysisResult['streetAnalysis'];
  const applicable = new Set<Street>(context.actionHistory.map(({ street }) => street));
  if (context.board.length >= 3) applicable.add('flop');
  if (context.board.length >= 4) applicable.add('turn');
  if (context.board.length >= 5) applicable.add('river');
  for (const street of STREETS) {
    const item = value.streetAnalysis[street];
    if (item === null) { streetAnalysis[street] = null; continue; }
    if (!applicable.has(street)) { streetAnalysis[street] = null; continue; }
    if (!isObject(item) || !hasKeys(item, STREET_FIELDS) || !isText(item.assessment, 240) || !isText(item.explanation, 1400)) throw new Error(`The AI response has an invalid ${street} analysis.`);
    streetAnalysis[street] = { assessment: item.assessment, explanation: item.explanation };
  }
  if (!isObject(value.rangeAnalysis) || !hasKeys(value.rangeAnalysis, ['hero', 'villain', 'interaction']) || !isText(value.rangeAnalysis.hero, 1200) || !isText(value.rangeAnalysis.villain, 1200) || !isText(value.rangeAnalysis.interaction, 1600)) throw new Error('The AI response has an invalid range analysis.');
  if (!isObject(value.recommendedLine) || !hasKeys(value.recommendedLine, ['action', 'explanation']) || !isText(value.recommendedLine.action, 120) || !isText(value.recommendedLine.explanation, 1600)) throw new Error('The AI response has an invalid recommendation.');
  if (!isText(value.situationSummary, 1400) || !isText(value.opponentAnalysis, 1400) || !Array.isArray(value.keyTakeaways) || value.keyTakeaways.length < 1 || value.keyTakeaways.length > 6 || value.keyTakeaways.some((item) => !isText(item, 320)) || !['low', 'medium', 'high'].includes(String(value.confidence)) || !Array.isArray(value.missingInformation) || value.missingInformation.length > 12 || value.missingInformation.some((item) => !isText(item, 240))) throw new Error('The AI response is incomplete or malformed.');
  const quality = deriveInputQuality(context);
  return {
    situationSummary: value.situationSummary,
    mathematicalContext: { summary: createMathematicalSummary(context) },
    streetAnalysis,
    rangeAnalysis: { hero: value.rangeAnalysis.hero, villain: value.rangeAnalysis.villain, interaction: value.rangeAnalysis.interaction },
    opponentAnalysis: value.opponentAnalysis,
    recommendedLine: { action: value.recommendedLine.action, explanation: value.recommendedLine.explanation },
    keyTakeaways: value.keyTakeaways as string[],
    confidence: quality.confidence,
    missingInformation: quality.missingInformation,
  };
}
