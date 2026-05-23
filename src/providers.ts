import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProviderType } from './types';
import type { PageIndexSettings } from './settings';

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function anthropicComplete(apiKey: string, model: string, messages: LLMMessage[]): Promise<string> {
  const filtered = messages.filter(m => m.role !== 'system');
  const system = messages.find(m => m.role === 'system')?.content;

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: filtered,
  };
  if (system) body.system = system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find(b => b.type === 'text')?.text ?? '';
}

async function openaiComplete(apiKey: string, model: string, baseUrl: string, messages: LLMMessage[]): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0 }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI-compatible API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? '';
}

// ── CLI helper ─────────────────────────────────────────────────────────────────

function runCli(cmd: string, args: string[], stdinContent?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let out = '';
    let err = '';

    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    if (stdinContent !== undefined) {
      child.stdin.write(stdinContent, 'utf8');
      child.stdin.end();
    }

    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `CLI exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

async function claudeCliComplete(claudeCmd: string, messages: LLMMessage[]): Promise<string> {
  const text = messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n---\n\n');
  const tmpFile = join(tmpdir(), `pageindex-${Date.now()}.txt`);
  writeFileSync(tmpFile, text, 'utf8');

  try {
    // claude -p reads the prompt from stdin; use file redirect via shell
    const result = await runCli(claudeCmd, ['--print', '--input-format', 'text', tmpFile]);
    return result;
  } catch {
    // fallback: pipe via stdin
    try {
      return await runCli(claudeCmd, ['-p'], text);
    } catch (e2) {
      throw e2;
    }
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function codexCliComplete(codexCmd: string, messages: LLMMessage[]): Promise<string> {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  return runCli(codexCmd, ['--quiet', lastUserMsg]);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function llmComplete(
  settings: PageIndexSettings,
  provider: ProviderType,
  model: string,
  messages: LLMMessage[],
): Promise<string> {
  switch (provider) {
    case 'anthropic':
      if (!settings.anthropicApiKey) throw new Error('Anthropic API key not set in PageIndex settings.');
      return anthropicComplete(settings.anthropicApiKey, model, messages);

    case 'openai':
      if (!settings.openaiApiKey) throw new Error('OpenAI API key not set in PageIndex settings.');
      return openaiComplete(settings.openaiApiKey, model, 'https://api.openai.com/v1', messages);

    case 'ollama':
      return openaiComplete('ollama', model, `${settings.ollamaBaseUrl}/v1`, messages);

    case 'lm-studio':
      return openaiComplete('lm-studio', model, `${settings.lmStudioBaseUrl}/v1`, messages);

    case 'claude-cli':
      return claudeCliComplete(settings.claudeCliPath, messages);

    case 'codex-cli':
      return codexCliComplete(settings.codexCliPath, messages);

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function makeIndexingCompleter(settings: PageIndexSettings) {
  return (prompt: string) => llmComplete(
    settings,
    settings.indexingProvider,
    settings.indexingModel,
    [{ role: 'user', content: prompt }],
  );
}

export function makeChatCompleter(settings: PageIndexSettings) {
  return (messages: LLMMessage[]) => llmComplete(
    settings,
    settings.chatProvider,
    settings.chatModel,
    messages,
  );
}
