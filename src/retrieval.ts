import type { TreeNode, IndexedDoc } from './types';
import type { PageIndexSettings } from './settings';
import type { LLMMessage } from './providers';
import { makeChatCompleter } from './providers';
import { structureToText, flattenTree } from './workspace';

// ── Section selection ──────────────────────────────────────────────────────────

async function selectRelevantNodes(
  question: string,
  structure: TreeNode[],
  complete: (msgs: LLMMessage[]) => Promise<string>,
): Promise<string[]> {
  const structText = structureToText(structure);

  const prompt = `You are a document retrieval assistant. Given a document structure and a user question, identify which sections (by node_id) are most relevant to answer the question.

Document structure:
${structText}

User question: ${question}

Return a JSON array of node_id strings for the 3-5 most relevant sections. Example: ["0001", "0003", "0007"]
Return only the JSON array, no other text.`;

  const raw = await complete([{ role: 'user', content: prompt }]);

  try {
    const cleaned = raw.replace(/```(?:json)?|```/g, '').trim();
    const ids = JSON.parse(cleaned);
    if (Array.isArray(ids)) return ids.map(String);
  } catch { /* fall through */ }

  // Fallback: return root node ids
  return structure.slice(0, 3).map(n => n.node_id ?? '').filter(Boolean);
}

function getNodeText(node: TreeNode): string {
  if (node.text) return node.text;
  if (node.summary) return node.summary;
  if (node.prefix_summary) return node.prefix_summary;
  return node.title;
}

function findNodeById(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of flattenTree(nodes)) {
    if (n.node_id === id) return n;
  }
  return undefined;
}

function extractContext(doc: IndexedDoc, nodeIds: string[]): string {
  const parts: string[] = [];

  for (const id of nodeIds) {
    const node = findNodeById(doc.structure, id);
    if (!node) continue;

    const text = getNodeText(node);
    parts.push(`### ${node.title}\n${text}`);
  }

  return parts.join('\n\n');
}

// ── PDF page retrieval ─────────────────────────────────────────────────────────

function getPdfContext(doc: IndexedDoc, nodeIds: string[]): string {
  const parts: string[] = [];

  for (const id of nodeIds) {
    const node = findNodeById(doc.structure, id);
    if (!node) continue;

    // Use summary/prefix_summary if available
    const summary = node.summary ?? node.prefix_summary;
    if (summary) {
      parts.push(`### ${node.title}\n${summary}`);
      continue;
    }

    // Fall back to page content if available
    if (doc.pages && node.start_index != null && node.end_index != null) {
      const pages = doc.pages.filter(
        p => p.page >= node.start_index! && p.page <= node.end_index!,
      );
      const text = pages.map(p => p.content).join('\n');
      if (text) parts.push(`### ${node.title}\n${text}`);
    } else {
      parts.push(`### ${node.title}`);
    }
  }

  return parts.join('\n\n');
}

// ── Main RAG answer ────────────────────────────────────────────────────────────

export async function answerQuestion(
  question: string,
  doc: IndexedDoc,
  history: LLMMessage[],
  settings: PageIndexSettings,
  onStatus?: (msg: string) => void,
): Promise<string> {
  const complete = makeChatCompleter(settings);

  onStatus?.('Finding relevant sections...');
  const nodeIds = await selectRelevantNodes(question, doc.structure, complete);

  const context = doc.type === 'md'
    ? extractContext(doc, nodeIds)
    : getPdfContext(doc, nodeIds);

  onStatus?.('Generating answer...');

  const systemPrompt = `You are a helpful assistant that answers questions about documents. Use the provided document context to answer accurately. If the answer is not in the context, say so.

Document: ${doc.doc_name}${doc.doc_description ? `\nDescription: ${doc.doc_description}` : ''}

Relevant sections:
${context}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: question },
  ];

  return complete(messages);
}
