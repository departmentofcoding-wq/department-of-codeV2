import { openDbConnection } from '../engine/db/index.ts';
import { callModel } from '../engine/llm/call_model.ts';
import { listGoogleModels, listOllamaModels } from '../engine/llm/registry_helpers.ts';

async function main() {
  console.log('--- Smoke LLM Check ---');

  const ollamaModels = await listOllamaModels();
  console.log(`Ollama endpoint models found: ${ollamaModels.length}`);
  for (const m of ollamaModels) {
    console.log(`  - ${m.id}`);
  }

  const googleModels = await listGoogleModels();
  console.log(`Google Gemini models found: ${googleModels.length}`);
  for (const m of googleModels) {
    console.log(`  - ${m.id}`);
  }

  if (process.env.SMOKE_TEST_CALL === '1') {
    console.log('Executing test call via callModel...');
    const db = openDbConnection();
    try {
      const res = await callModel(
        db,
        'task-intake-officer',
        [{ role: 'user', content: 'Say hello in 5 words or less.' }]
      );
      console.log('Response:', res.text);
      console.log(`Tokens in: ${res.tokensIn}, Tokens out: ${res.tokensOut}, Latency: ${res.latencyMs}ms`);
    } catch (err: any) {
      console.error('Test call error:', err.message);
    } finally {
      db.close();
    }
  }
}

void main();
