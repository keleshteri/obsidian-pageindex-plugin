import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TreeNode } from './types';
import type { PageIndexSettings } from './settings';

export interface PdfIndexResult {
  doc_name: string;
  doc_description?: string;
  structure: TreeNode[];
  page_count?: number;
  pages?: Array<{ page: number; content: string }>;
}

// ── Model name mapping ─────────────────────────────────────────────────────────
// Translates plugin provider+model to the model string pageindex-rag understands.

function resolveModel(settings: PageIndexSettings): { model: string; extraEnv: Record<string, string> } {
  const p = settings.indexingProvider;
  const m = settings.indexingModel;

  if (p === 'anthropic') return { model: m, extraEnv: {} };
  if (p === 'openai') return { model: m, extraEnv: {} };
  if (p === 'ollama') return { model: `ollama/${m}`, extraEnv: { OLLAMA_BASE_URL: `${settings.ollamaBaseUrl}/v1` } };
  if (p === 'lm-studio') return { model: m, extraEnv: { OPENAI_BASE_URL: `${settings.lmStudioBaseUrl}/v1`, OPENAI_API_KEY: 'lm-studio' } };
  if (p === 'claude-cli') return { model: 'claude-code', extraEnv: {} };
  // codex-cli not supported for PDF indexing; fall back to openai
  return { model: m, extraEnv: {} };
}

// ── Worker script (written to temp file, executed via Node.js) ─────────────────

const WORKER_SCRIPT = `
'use strict';
const path = require('path');
const cfg = JSON.parse(process.argv[2]);

// Inject env vars before loading the library (singletons read env at init time)
if (cfg.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.ANTHROPIC_API_KEY;
if (cfg.OPENAI_API_KEY) process.env.OPENAI_API_KEY = cfg.OPENAI_API_KEY;
if (cfg.OLLAMA_BASE_URL) process.env.OLLAMA_BASE_URL = cfg.OLLAMA_BASE_URL;
if (cfg.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = cfg.OPENAI_BASE_URL;
Object.assign(process.env, cfg.extraEnv || {});

const { pageIndex } = require(path.join(cfg.ragPath, 'dist', 'index.js'));

pageIndex(cfg.pdfPath, {
  model: cfg.model,
  if_add_node_summary: cfg.addSummary ? 'yes' : 'no',
  if_add_doc_description: cfg.addDescription ? 'yes' : 'no',
  if_add_node_text: cfg.addText ? 'yes' : 'no',
  if_add_node_id: 'yes',
}).then(result => {
  process.stdout.write(JSON.stringify(result));
}).catch(err => {
  process.stderr.write(err.message || String(err));
  process.exit(1);
});
`;

function runWorker(workerPath: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath || 'node', [workerPath, args]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `Worker exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function indexPdf(
  absolutePdfPath: string,
  docName: string,
  settings: PageIndexSettings,
  onProgress?: (msg: string) => void,
): Promise<PdfIndexResult> {
  if (!settings.pageindexRagPath) {
    throw new Error('Set the PageIndexRAG path in plugin settings (Settings → PageIndex RAG → PDF Support).');
  }

  const { model, extraEnv } = resolveModel(settings);

  const workerFile = join(tmpdir(), `pageindex-worker-${Date.now()}.js`);
  const argObj = {
    ragPath: settings.pageindexRagPath,
    pdfPath: absolutePdfPath,
    model,
    addSummary: settings.addSummary,
    addDescription: settings.addDescription,
    addText: settings.addText,
    ANTHROPIC_API_KEY: settings.anthropicApiKey || undefined,
    OPENAI_API_KEY: settings.openaiApiKey || undefined,
    extraEnv,
  };

  writeFileSync(workerFile, WORKER_SCRIPT, 'utf8');

  try {
    onProgress?.('Running PDF indexer (this may take a few minutes)...');
    const raw = await runWorker(workerFile, JSON.stringify(argObj));
    const result = JSON.parse(raw) as { doc_name: string; doc_description?: string; structure: TreeNode[]; page_count?: number; pages?: Array<{ page: number; content: string }> };
    return {
      doc_name: result.doc_name ?? docName,
      doc_description: result.doc_description,
      structure: result.structure ?? [],
      page_count: result.page_count,
      pages: result.pages,
    };
  } finally {
    try { unlinkSync(workerFile); } catch { /* ignore */ }
  }
}
