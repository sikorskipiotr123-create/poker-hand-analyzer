import { STREETS, type Street, type AIAnalysisContext } from './ai-context';
import { createMathematicalSummary, deriveInputQuality, type AIAnalysisResult } from './ai-analysis';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const STREET_FIELDS = ['assessment', 'explanation'];
const BASE_FIELDS = ['situationSummary', 'mathematicalContext', 'streetAnalysis', 'rangeAnalysis', 'opponentAnalysis', 'recommendedLine', 'keyTakeaways', 'confidence', 'missingInformation'];

export type AIResponseValidationCategory =
  | 'object_expected'
  | 'object_keys_mismatch'
  | 'field_shape_mismatch'
  | 'text_type_mismatch'
  | 'text_empty'
  | 'text_too_long'
  | 'array_type_mismatch'
  | 'array_length_out_of_bounds'
  | 'array_item_invalid'
  | 'enum_value_invalid';

export class AIResponseValidationError extends Error {
  constructor(
    readonly fieldPath: string,
    readonly category: AIResponseValidationCategory,
    readonly constraint: string,
    message: string,
  ) {
    super(message);
    this.name = 'AIResponseValidationError';
  }
}

function fail(path: string, category: AIResponseValidationCategory, constraint: string, message: string): never {
  throw new AIResponseValidationError(path, category, constraint, message);
}

function requireObject(value: unknown, path: string, message: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, 'object_expected', 'type:object', message);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: string[], path: string, message: string): void {
  if (!hasKeys(value, keys)) fail(path, 'object_keys_mismatch', 'exact_schema_keys', message);
}

function requireText(value: unknown, path: string, max: number, message: string, min = 1): asserts value is string {
  if (typeof value !== 'string') fail(path, 'text_type_mismatch', 'type:string', message);
  if (value.trim().length < min) fail(path, 'text_empty', 'non_empty_string', message);
  if (value.length > max) fail(path, 'text_too_long', 'max_length:' + max, message);
}

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
  const root = requireObject(value, '$', 'The AI response did not match the hand-review format.');
  requireExactKeys(root, BASE_FIELDS, '$', 'The AI response did not match the hand-review format.');

  const math = requireObject(root.mathematicalContext, 'mathematicalContext', 'The AI response has an invalid mathematical section.');
  requireExactKeys(math, ['summary'], 'mathematicalContext', 'The AI response has an invalid mathematical section.');
  requireText(math.summary, 'mathematicalContext.summary', 1200, 'The AI response has an invalid mathematical section.');

  const suppliedStreets = requireObject(root.streetAnalysis, 'streetAnalysis', 'The AI response has an invalid street analysis.');
  requireExactKeys(suppliedStreets, [...STREETS], 'streetAnalysis', 'The AI response has an invalid street analysis.');
  const streetAnalysis = {} as AIAnalysisResult['streetAnalysis'];
  const applicable = new Set<Street>(context.actionHistory.map(({ street }) => street));
  if (context.board.length >= 3) applicable.add('flop');
  if (context.board.length >= 4) applicable.add('turn');
  if (context.board.length >= 5) applicable.add('river');
  for (const street of STREETS) {
    const item = suppliedStreets[street];
    if (item === null) { streetAnalysis[street] = null; continue; }
    if (!applicable.has(street)) { streetAnalysis[street] = null; continue; }
    const path = 'streetAnalysis.' + street;
    const streetItem = requireObject(item, path, 'The AI response has an invalid ' + street + ' analysis.');
    requireExactKeys(streetItem, STREET_FIELDS, path, 'The AI response has an invalid ' + street + ' analysis.');
    requireText(streetItem.assessment, path + '.assessment', 240, 'The AI response has an invalid ' + street + ' analysis.');
    requireText(streetItem.explanation, path + '.explanation', 1400, 'The AI response has an invalid ' + street + ' analysis.');
    streetAnalysis[street] = { assessment: streetItem.assessment as string, explanation: streetItem.explanation as string };
  }

  const ranges = requireObject(root.rangeAnalysis, 'rangeAnalysis', 'The AI response has an invalid range analysis.');
  requireExactKeys(ranges, ['hero', 'villain', 'interaction'], 'rangeAnalysis', 'The AI response has an invalid range analysis.');
  requireText(ranges.hero, 'rangeAnalysis.hero', 1200, 'The AI response has an invalid range analysis.');
  requireText(ranges.villain, 'rangeAnalysis.villain', 1200, 'The AI response has an invalid range analysis.');
  requireText(ranges.interaction, 'rangeAnalysis.interaction', 1600, 'The AI response has an invalid range analysis.');

  const line = requireObject(root.recommendedLine, 'recommendedLine', 'The AI response has an invalid recommendation.');
  requireExactKeys(line, ['action', 'explanation'], 'recommendedLine', 'The AI response has an invalid recommendation.');
  requireText(line.action, 'recommendedLine.action', 120, 'The AI response has an invalid recommendation.');
  requireText(line.explanation, 'recommendedLine.explanation', 1600, 'The AI response has an invalid recommendation.');

  requireText(root.situationSummary, 'situationSummary', 1400, 'The AI response is incomplete or malformed.');
  requireText(root.opponentAnalysis, 'opponentAnalysis', 1400, 'The AI response is incomplete or malformed.');

  if (!Array.isArray(root.keyTakeaways)) fail('keyTakeaways', 'array_type_mismatch', 'type:array', 'The AI response is incomplete or malformed.');
  if (root.keyTakeaways.length < 1 || root.keyTakeaways.length > 6) fail('keyTakeaways', 'array_length_out_of_bounds', 'items:1-6', 'The AI response is incomplete or malformed.');
  root.keyTakeaways.forEach((item, index) => {
    try { requireText(item, 'keyTakeaways[' + index + ']', 320, 'The AI response is incomplete or malformed.'); }
    catch (error) {
      if (error instanceof AIResponseValidationError) fail(error.fieldPath, 'array_item_invalid', error.constraint, 'The AI response is incomplete or malformed.');
      throw error;
    }
  });

  if (!['low', 'medium', 'high'].includes(String(root.confidence))) fail('confidence', 'enum_value_invalid', 'allowed:low|medium|high', 'The AI response is incomplete or malformed.');

  if (!Array.isArray(root.missingInformation)) fail('missingInformation', 'array_type_mismatch', 'type:array', 'The AI response is incomplete or malformed.');
  if (root.missingInformation.length > 12) fail('missingInformation', 'array_length_out_of_bounds', 'items:0-12', 'The AI response is incomplete or malformed.');
  root.missingInformation.forEach((item, index) => {
    try { requireText(item, 'missingInformation[' + index + ']', 240, 'The AI response is incomplete or malformed.'); }
    catch (error) {
      if (error instanceof AIResponseValidationError) fail(error.fieldPath, 'array_item_invalid', error.constraint, 'The AI response is incomplete or malformed.');
      throw error;
    }
  });

  const quality = deriveInputQuality(context);
  return {
    situationSummary: root.situationSummary as string,
    mathematicalContext: { summary: createMathematicalSummary(context) },
    streetAnalysis,
    rangeAnalysis: { hero: ranges.hero as string, villain: ranges.villain as string, interaction: ranges.interaction as string },
    opponentAnalysis: root.opponentAnalysis as string,
    recommendedLine: { action: line.action as string, explanation: line.explanation as string },
    keyTakeaways: root.keyTakeaways as string[],
    confidence: quality.confidence,
    missingInformation: quality.missingInformation,
  };
}
