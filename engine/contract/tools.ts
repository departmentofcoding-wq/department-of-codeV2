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
