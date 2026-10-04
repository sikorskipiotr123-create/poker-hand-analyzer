import { handleAnalyzeRequest } from '../../../lib/analyze-handler';
import { requestOpenAIAnalysis } from '../../../lib/ai-provider';

export const runtime = 'nodejs';
export const maxDuration = 65;

export async function POST(request: Request): Promise<Response> {
  return handleAnalyzeRequest(request, requestOpenAIAnalysis);
}
