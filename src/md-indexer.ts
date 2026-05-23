import type { TreeNode } from './types';
import type { PageIndexSettings } from './settings';
import { makeIndexingCompleter } from './providers';

// ── Token approximation (avoids WASM dependency) ───────────────────────────────

function approxTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

// ── Markdown parsing ───────────────────────────────────────────────────────────

interface FlatNode {
  title: string;
  level: number;
  line_num: number;
  text: string;
  tokens: number;
}

function parseMd(content: string): FlatNode[] {
  const lines = content.split('\n');
  const headings: Array<{ title: string; level: number; line_num: number }> = [];
  let inCode = false;

  lines.forEach((line, i) => {
    if (/^```/.test(line.trim())) { inCode = !inCode; return; }
    if (inCode) return;
    const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), line_num: i + 1 });
  });

  return headings.map((h, i) => {
    const start = h.line_num - 1;
    const end = i + 1 < headings.length ? headings[i + 1].line_num - 1 : lines.length;
    const text = lines.slice(start, end).join('\n').trim();
    return { ...h, text, tokens: approxTokens(text) };
  });
}

function buildHierarchy(flat: FlatNode[]): TreeNode[] {
  const root: TreeNode[] = [];
  const stack: TreeNode[] = [];

  for (const f of flat) {
    const node: TreeNode = {
      title: f.title,
      line_num: f.line_num,
      level: f.level,
      text: f.text,
      tokens: f.tokens,
      nodes: [],
    };

    while (stack.length > 0 && (stack[stack.length - 1].level ?? 0) >= f.level) stack.pop();

    if (stack.length === 0) root.push(node);
    else stack[stack.length - 1].nodes!.push(node);

    stack.push(node);
  }

  function pruneEmpty(nodes: TreeNode[]): TreeNode[] {
    return nodes.map(n => {
      if (n.nodes && n.nodes.length > 0) n.nodes = pruneEmpty(n.nodes);
      else delete n.nodes;
      return n;
    });
  }

  return pruneEmpty(root);
}

// ── Node IDs (zero-padded sequential) ─────────────────────────────────────────

function writeNodeIds(nodes: TreeNode[], counter = { v: 0 }): void {
  for (const n of nodes) {
    n.node_id = String(counter.v).padStart(4, '0');
    counter.v++;
    if (n.nodes) writeNodeIds(n.nodes, counter);
  }
}

// ── Summary generation ─────────────────────────────────────────────────────────

async function summariseNode(
  node: TreeNode,
  threshold: number,
  complete: (p: string) => Promise<string>,
): Promise<string> {
  if ((node.tokens ?? 0) < threshold) return node.text ?? '';

  const prompt = `You are given a part of a document. Generate a concise description of the main points covered.

Document section: ${node.text}

Return only the description, no other text.`;

  return complete(prompt);
}

async function attachSummaries(
  nodes: TreeNode[],
  threshold: number,
  complete: (p: string) => Promise<string>,
): Promise<void> {
  const all: TreeNode[] = [];
  const flatten = (ns: TreeNode[]) => {
    for (const n of ns) { all.push(n); if (n.nodes) flatten(n.nodes); }
  };
  flatten(nodes);

  const summaries = await Promise.all(all.map(n => summariseNode(n, threshold, complete)));

  all.forEach((n, i) => {
    if (!n.nodes || n.nodes.length === 0) n.summary = summaries[i];
    else n.prefix_summary = summaries[i];
  });
}

// ── Document description ───────────────────────────────────────────────────────

async function generateDescription(
  nodes: TreeNode[],
  complete: (p: string) => Promise<string>,
): Promise<string> {
  const titles = nodes.map(n => n.title).join(', ');
  return complete(
    `Write one sentence describing a document with the following top-level sections: ${titles}. Return only the sentence.`,
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface MdIndexResult {
  doc_name: string;
  doc_description?: string;
  structure: TreeNode[];
  line_count: number;
}

export async function indexMarkdown(
  content: string,
  docName: string,
  settings: PageIndexSettings,
  onProgress?: (msg: string) => void,
): Promise<MdIndexResult> {
  const lineCount = content.split('\n').length;
  const flat = parseMd(content);

  if (flat.length === 0) {
    return { doc_name: docName, structure: [], line_count: lineCount };
  }

  const structure = buildHierarchy(flat);
  const complete = makeIndexingCompleter(settings);

  if (settings.addSummary) {
    onProgress?.('Generating section summaries...');
    await attachSummaries(structure, settings.summaryTokenThreshold, complete);
  }

  writeNodeIds(structure);

  let doc_description: string | undefined;
  if (settings.addDescription) {
    onProgress?.('Generating document description...');
    doc_description = await generateDescription(structure, complete);
  }

  if (!settings.addText) {
    const stripText = (ns: TreeNode[]) => {
      for (const n of ns) { delete n.text; delete n.tokens; if (n.nodes) stripText(n.nodes); }
    };
    stripText(structure);
  }

  return { doc_name: docName, doc_description, structure, line_count: lineCount };
}
