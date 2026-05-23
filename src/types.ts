export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'lm-studio'
  | 'claude-cli'
  | 'codex-cli';

export interface TreeNode {
  title: string;
  node_id?: string;
  start_index?: number;
  end_index?: number;
  line_num?: number;
  level?: number;
  tokens?: number;
  summary?: string;
  prefix_summary?: string;
  text?: string;
  nodes?: TreeNode[];
  [key: string]: unknown;
}

export interface IndexedDoc {
  id: string;
  type: 'pdf' | 'md';
  path: string;
  doc_name: string;
  doc_description?: string;
  line_count?: number;
  page_count?: number;
  indexed_at: number;
  structure: TreeNode[];
  pages?: Array<{ page: number; content: string }>;
}

export interface DocsRegistry {
  documents: Omit<IndexedDoc, 'structure' | 'pages'>[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
