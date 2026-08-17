import { LlmError } from '../contract/index.ts';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse, LlmMessage, LlmToolCall } from '../contract/index.ts';

export class GoogleClient implements LlmClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai';
  }

  public async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new LlmError('auth', 'GOOGLE_API_KEY environment variable is not set');
    }

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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: request.signal
      });

      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        // T18 KEY HYGIENE: Build error ONLY from status code and static sanitized text.
        // NEVER include raw response bodies, headers, or URL params that could echo the key!
        if (res.status === 429) {
          const retryHeader = res.headers.get('retry-after');
          let retryMs = 60000;
          if (retryHeader) {
            const parsed = parseInt(retryHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
              retryMs = parsed * 1000;
            }
          }
          throw new LlmError('rate-limited', `Google API rate limit (HTTP 429)`, retryMs);
        }

        if (res.status === 401 || res.status === 403) {
          throw new LlmError('auth', `Google API authentication failure (HTTP ${res.status})`);
        }

        throw new LlmError('network', `Google API error (HTTP ${res.status})`);
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
      throw new LlmError('network', 'Google API request failed');
    }
  }
}
