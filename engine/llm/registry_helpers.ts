import type { DbConnection } from '../contract/index.ts';

export interface RemoteModelInfo {
  id: string;
  provider: string;
  available: boolean;
}

export async function listOllamaModels(baseUrl?: string): Promise<RemoteModelInfo[]> {
  const url = `${(baseUrl || process.env.BUREAU_OLLAMA_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '')}/models`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const data = json.data || [];
    return data.map((m: any) => ({
      id: m.id || m.name,
      provider: 'ollama',
      available: true
    }));
  } catch {
    return [];
  }
}

export async function listGoogleModels(): Promise<RemoteModelInfo[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return [];
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/models';
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const data = json.data || [];
    return data.map((m: any) => ({
      id: m.id,
      provider: 'google',
      available: true
    }));
  } catch {
    return [];
  }
}
