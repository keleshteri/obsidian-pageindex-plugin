import { pageIndex, mdToTree } from '@keleshteri/pageindex-rag';
import type { IndexResult, MdIndexResult } from '@keleshteri/pageindex-rag';
import type { PageIndexSettings } from './settings';

// ── LLM configuration ──────────────────────────────────────────────────────────
// The library resolves its LLM provider from process.env + model name prefix.
// Set env vars before every call so the lazy singletons get the right values.

function applyEnvVars(settings: PageIndexSettings): void {
  const p = settings.indexingProvider;

  if (p === 'anthropic' && settings.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
  }
  if ((p === 'openai' || p === 'codex-cli') && settings.openaiApiKey) {
    process.env.OPENAI_API_KEY = settings.openaiApiKey;
    delete process.env.OPENAI_BASE_URL;
  }
  if (p === 'ollama') {
    process.env.OLLAMA_BASE_URL = `${settings.ollamaBaseUrl}/v1`;
  }
  if (p === 'lm-studio') {
    process.env.OPENAI_API_KEY = 'lm-studio';
    process.env.OPENAI_BASE_URL = `${settings.lmStudioBaseUrl}/v1`;
  }
  // claude-cli: library uses 'claude-code' model → spawns `claude -p` internally
}

// Map plugin provider + user model → the model string the library understands:
//   claude-* / anthropic/*  → Anthropic SDK
//   ollama/*                → Ollama (OpenAI-compatible at OLLAMA_BASE_URL)
//   claude-code             → Claude Code CLI subprocess
//   anything else           → OpenAI SDK (respects OPENAI_BASE_URL for LM Studio)

function resolveModel(settings: PageIndexSettings): string {
  switch (settings.indexingProvider) {
    case 'anthropic':  return settings.indexingModel;           // e.g. claude-sonnet-4-6
    case 'openai':     return settings.indexingModel;           // e.g. gpt-4o
    case 'ollama':     return `ollama/${settings.indexingModel}`; // library requires this prefix
    case 'lm-studio':  return settings.indexingModel;           // any name; base URL set via env
    case 'claude-cli': return 'claude-code';                    // special value in llm.ts
    case 'codex-cli':  return settings.indexingModel;           // treated as OpenAI
    default:           return settings.indexingModel;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function indexMdFile(
  absolutePath: string,
  settings: PageIndexSettings,
  onProgress?: (msg: string) => void,
): Promise<MdIndexResult> {
  applyEnvVars(settings);
  const model = resolveModel(settings);

  onProgress?.('Parsing Markdown structure...');
  return mdToTree(absolutePath, {
    model,
    ifAddNodeSummary: settings.addSummary,
    ifAddDocDescription: settings.addDescription,
    ifAddNodeText: settings.addText,
    ifAddNodeId: true,
    summaryTokenThreshold: settings.summaryTokenThreshold,
  });
}

export async function indexPdfFile(
  absolutePath: string,
  settings: PageIndexSettings,
  onProgress?: (msg: string) => void,
): Promise<IndexResult> {
  applyEnvVars(settings);
  const model = resolveModel(settings);

  onProgress?.('Parsing PDF — detecting TOC and structure (may take a few minutes)...');
  return pageIndex(absolutePath, {
    model,
    ifAddNodeSummary: settings.addSummary,
    ifAddDocDescription: settings.addDescription,
    ifAddNodeText: settings.addText,
    ifAddNodeId: true,
  });
}
