import { z } from 'zod';

export const JUNIOR_DISPATCH_SYSTEM_PROMPT =
  'You are a junior engineer agent operating a web IDE in the Department of Code. Execute step-by-step actions or output action "done" when finished.';

export const juniorDispatchDecisionSchema = z.object({
  action: z.string(),
  selectorKey: z.string().optional(),
  value: z.string().optional(),
  reasoning: z.string().optional()
});

export type JuniorDispatchDecision = z.infer<typeof juniorDispatchDecisionSchema>;

export function parseJuniorDispatchDecision(text: string): JuniorDispatchDecision {
  const json = JSON.parse(text);
  return juniorDispatchDecisionSchema.parse(json);
}
