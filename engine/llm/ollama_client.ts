import { LlmError } from '../contract/index.ts';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse, LlmMessage, LlmToolCall } from '../contract/index.ts';

export class OllamaClient implements LlmClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.BUREAU_OLLAMA_URL || 'http://127.0.0.1:11434/v1';
  }

  public async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const startTime = Date.now();
    const endpoint = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const formattedMessages = request.messages.map((m: LlmMessage) => {
      if (m.role === 'assistant') {
        if (m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }))
          };
        }
        return { role: 'assistant', content: m.content || '' };
      } else if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.toolCallId,
          content: m.content
        };
      } else {
        return { role: m.role, content: m.content };
      }
    });

    const body: Record<string, unknown> = {
      model: request.modelId,
      messages: formattedMessages
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        if (res.status === 429) {
          const retryHeader = res.headers.get('retry-after');
          const retryMs = retryHeader ? parseInt(retryHeader, 10) * 1000 : 60000;
          throw new LlmError('rate-limited', `Ollama rate limit: HTTP ${res.status}`, retryMs);
        }
        throw new LlmError('network', `Ollama HTTP error ${res.status}`);
      }

      const json = (await res.json()) as any;
      const choice = json.choices?.[0];
      const message = choice?.message;

      const toolCalls: LlmToolCall[] = [];
      if (message?.tool_calls && Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          let parsedArgs = {};
          try {
            parsedArgs = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : (tc.function?.arguments ?? {});
          } catch {
            parsedArgs = {};
          }
          toolCalls.push({
            id: tc.id || `call_${crypto.randomUUID()}`,
            name: tc.function?.name || '',
            arguments: parsedArgs
          });
        }
      }

      const usage = json.usage ?? {};
      const tokensIn = Number(usage.prompt_tokens ?? 0);
      const tokensOut = Number(usage.completion_tokens ?? 0);

      return {
        text: message?.content ?? null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        tokensIn,
        tokensOut,
        latencyMs,
        costUsd: null,
        finishReason: choice?.finish_reason || 'stop',
        truncated: choice?.finish_reason === 'length'
      };
    } catch (err: any) {
      if (err instanceof LlmError) {
        throw err;
      }
      throw new LlmError('network', `Ollama request failed: ${err.message}`);
    }
  }
}
