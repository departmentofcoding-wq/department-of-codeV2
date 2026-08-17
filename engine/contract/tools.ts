import { z } from 'zod';
import type { LlmToolDefinition } from './types.ts';

export const ProposeFieldSchema = z.object({
  field: z.enum(['title', 'intent', 'spec', 'acceptance']),
  value: z.string()
});

export type ProposeFieldInput = z.infer<typeof ProposeFieldSchema>;

export const ProposeVerifySchema = z.object({
  command: z.string()
});

export type ProposeVerifyInput = z.infer<typeof ProposeVerifySchema>;

export const AskHumanSchema = z.object({
  question: z.string()
});

export type AskHumanInput = z.infer<typeof AskHumanSchema>;

export const FileTaskSchema = z.object({});

export type FileTaskInput = z.infer<typeof FileTaskSchema>;

export const OFFICER_TOOLS: LlmToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'propose_field',
      description: 'Propose a draft field value for the task (title, intent, spec, acceptance).',
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            enum: ['title', 'intent', 'spec', 'acceptance'],
            description: 'The field name to populate.'
          },
          value: {
            type: 'string',
            description: 'The proposed string value.'
          }
        },
        required: ['field', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_verify',
      description: 'Propose the verification command that tests if the task is finished.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The verify command (e.g. npm test or vitest run).'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_human',
      description: 'Ask the human operator a question to clarify task intent or requirements.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question for the human operator.'
          }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_task',
      description: 'Submit the task to be filed into queued state once all gaps are resolved.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
];

/**
 * Secret key patterns that must be stripped from environments passed to verify commands.
 * Patterns: GOOGLE_*, ANTHROPIC_*, OPENAI_*, BUREAU_*, *_API_KEY.
 */
export const SECRET_KEY_PATTERNS = [
  /^GOOGLE_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^BUREAU_/i,
  /_API_KEY$/i
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * Strips secret keys from an environment object (denylist).
 */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (val !== undefined && !isSecretKey(key)) {
      clean[key] = val;
    }
  }
  return clean;
}

/**
 * Redacts secrets (known values from process.env and key regex patterns) in output text.
 */
export function redactOutput(text: string): string {
  if (!text) {
    return text;
  }
  let redacted = text;

  // 1. Redact values of any env vars matching secret patterns in process.env
  for (const [key, val] of Object.entries(process.env)) {
    if (val && val.length >= 4 && isSecretKey(key)) {
      // Escape regex special chars
      const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      redacted = redacted.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }
  }

  // 2. Common API key string patterns
  const keyRegexes = [
    /AIzaSy[A-Za-z0-9_-]{33}/g,
    /sk-ant-[A-Za-z0-9_-]{32,}/g,
    /sk-[A-Za-z0-9_-]{32,}/g,
    /bureau-secret-[A-Za-z0-9_-]+/g
  ];

  for (const regex of keyRegexes) {
    redacted = redacted.replace(regex, '[REDACTED]');
  }

  return redacted;
}

export interface VerifyOutcome {
  success: boolean;
  timedOut: boolean;
  signal: string | null;
  exitCode: number | null;
}

export function parseVerifyOutcome(
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean
): VerifyOutcome {
  const isTimedOut = Boolean(timedOut);
  const sig = signal ?? null;
  const code = exitCode ?? null;
  const success = code === 0 && !isTimedOut && sig === null;

  return {
    success,
    timedOut: isTimedOut,
    signal: sig,
    exitCode: code
  };
}

