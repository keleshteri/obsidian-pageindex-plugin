import { App } from 'obsidian';
import type { PageIndexSettings } from './settings';
import { loadRegistry, loadDocument, flattenTree, structureToText } from './workspace';
import { makeChatCompleter } from './providers';
import type { IndexedDoc, TreeNode } from './types';

export interface QueryResult {
  answer: string;
  sources: Array<{ docName: string; docId: string; path: string }>;
}

export class VaultQueryEngine {
  constructor(
    private app: App,
    private settings: PageIndexSettings,
  ) {}

  async query(question: string, onStatus?: (msg: string) => void): Promise<QueryResult> {
    const complete = makeChatCompleter(this.settings);

    onStatus?.('Loading document index...');
    const registry = await loadRegistry(this.app, this.settings.workspaceFolder);

    if (registry.documents.length === 0) {
      return {
        answer: 'No documents indexed yet. Run "Index all Markdown files" from the command palette first.',
        sources: [],
      };
    }

    const docs: IndexedDoc[] = [];
    for (const meta of registry.documents) {
      const doc = await loadDocument(this.app, this.settings.workspaceFolder, meta.id);
      if (doc) docs.push(doc);
    }

    // Step 4: LLM navigates all structures to pick relevant node_ids per doc
    onStatus?.('Finding relevant sections...');
    const structuresText = docs
      .map(d => `### Doc: "${d.doc_name}" (id: ${d.id})\n${structureToText(d.structure)}`)
      .join('\n\n');

    const navRaw = await complete([{
      role: 'user',
      content: buildNavigationPrompt(question, structuresText),
    }]);

    let navResult: Array<{ docId: string; docName: string; nodeIds: string[] }> = [];
    try {
      const cleaned = navRaw.replace(/```json\n?|```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      navResult = Array.isArray(parsed) ? parsed : [];
    } catch {
      return { answer: 'Could not parse navigation response from LLM.', sources: [] };
    }

    if (navResult.length === 0) {
      return { answer: 'No relevant sections found for this question.', sources: [] };
    }

    // Step 5: Extract content for the selected node_ids
    onStatus?.('Retrieving content...');
    const contentParts: Array<{ docName: string; content: string }> = [];
    const sources: QueryResult['sources'] = [];

    for (const { docId, docName, nodeIds } of navResult) {
      const doc = docs.find(d => d.id === docId);
      if (!doc) continue;

      const content = extractNodeContent(doc, nodeIds);
      if (content) {
        contentParts.push({ docName, content });
        sources.push({ docName, docId, path: doc.path });
      }
    }

    if (contentParts.length === 0) {
      return { answer: 'Could not retrieve content for the identified sections.', sources: [] };
    }

    // Step 6: LLM generates the final answer
    onStatus?.('Generating answer...');
    const contentText = contentParts
      .map(c => `### From "${c.docName}":\n${c.content}`)
      .join('\n\n---\n\n');

    const answer = await complete([{
      role: 'user',
      content: buildAnswerPrompt(question, contentText),
    }]);

    return { answer, sources };
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────────

function buildNavigationPrompt(question: string, structuresText: string): string {
  return `You are navigating a vault of documents to find sections relevant to a query.

Documents (hierarchical outlines — each section shows [node_id] Title — summary):
${structuresText}

Query: ${question}

Rules:
- Pick the 3–7 most relevant node_ids across all documents
- Only include sections with direct relevance to the query
- Group selections by document

Return ONLY a JSON array, no other text:
[{"docId": "...", "docName": "...", "nodeIds": ["0001", "0005"]}]

If nothing is relevant return: []`;
}

function buildAnswerPrompt(question: string, contentText: string): string {
  return `Answer the following question using only the provided content.

Question: ${question}

Content:
${contentText}

Instructions:
- Answer based only on the provided content
- Cite the source document name when referencing specific information
- If the content does not fully answer the question, say so clearly
- Be concise and accurate`;
}

// ── Content extraction ─────────────────────────────────────────────────────────

function extractNodeContent(doc: IndexedDoc, nodeIds: string[]): string {
  const idSet = new Set(nodeIds);
  const parts: string[] = [];

  for (const node of flattenTree(doc.structure)) {
    if (!node.node_id || !idSet.has(node.node_id)) continue;
    const text = getNodeText(node, doc);
    if (text) parts.push(`**${node.title}**\n${text}`);
  }

  return parts.join('\n\n');
}

function getNodeText(node: TreeNode, doc: IndexedDoc): string {
  if (node.text) return node.text as string;
  if (node.summary) return node.summary as string;

  if (doc.type === 'pdf' && doc.pages && node.start_index != null && node.end_index != null) {
    const pages = doc.pages.filter(
      p => p.page >= node.start_index! && p.page <= node.end_index!,
    );
    if (pages.length > 0) return pages.map(p => p.content).join('\n');
  }

  return (node.prefix_summary as string | undefined) ?? node.title;
}
