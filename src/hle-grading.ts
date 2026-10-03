import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { DittoAgents } from './ditto.js';
import { limitsSchema, type Task } from './types.js';

const verdict = z.object({ extracted_final_answer: z.string(), reasoning: z.string(),
  correct: z.enum(['yes', 'no']), confidence: z.number().int().min(0).max(100), strict: z.literal(true) }).strict();

/** Official judge prompt/schema; the published Ditto Worker performs the judge call. */
export async function gradeHLE(task: Task, answer: string, agents?: DittoAgents) {
  if (!agents || !process.env.MFLOW_HLE_JUDGE_MODEL) throw new Error('HLE needs an explicit MFLOW_HLE_JUDGE_MODEL and Ditto grading context');
  const lock = JSON.parse(await readFile(new URL('../data/extended-benchmarks.lock.json', import.meta.url), 'utf8')).hle;
  const values: Record<string, string> = { question: task.prompt.replace(lock.systemPrompt + '\n\n', ''), correct_answer: task.answer, response: answer };
  const instruction = lock.judgePrompt.replace(/\{(question|correct_answer|response)\}/g, (_: string, key: string) => values[key]);
  const judge = new DittoAgents(agents.provider, { ...agents.model, model: process.env.MFLOW_HLE_JUDGE_MODEL,
    providerOptions: { ...agents.model.providerOptions, response_format: { type: 'json_object' } } }, []);
  const { value } = await judge.structured('hle-judge', instruction, {}, verdict,
    limitsSchema.parse({ maxOutputTokens: agents.model.model==='deepseek-flash'?393216:4096, maxTokens: Number.MAX_SAFE_INTEGER, timeoutMs: 2147483647 }), undefined, false);
  return { score: (value.correct === 'yes' ? 1 : 0) as 0|1, confidence: value.confidence, judge: value };
}
