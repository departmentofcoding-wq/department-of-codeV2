import { LlmError } from '../contract/index.ts';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from '../contract/index.ts';

export type ScriptedResponse = LlmCompletionResponse | Error;

export class MockClient implements LlmClient {
  private queue: ScriptedResponse[] = [];
  public callHistory: LlmCompletionRequest[] = [];

  constructor(script?: ScriptedResponse[]) {
    if (script) {
      this.queue = [...script];
    }
  }

  public enqueueResponse(response: ScriptedResponse): void {
    this.queue.push(response);
  }

  public setScript(responses: ScriptedResponse[]): void {
    this.queue = [...responses];
  }

  public async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.callHistory.push(request);

    if (this.queue.length === 0) {
      return {
        text: 'Default mock response',
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 15,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      };
    }

    const next = this.queue.shift()!;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}
