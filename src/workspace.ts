import { App, normalizePath, TFile, TFolder, Vault } from 'obsidian';
import { v4 as uuidv4 } from './uuid-shim';
import type { IndexedDoc, DocsRegistry, TreeNode } from './types';

const REGISTRY_FILE = 'docs.json';

function docFile(folder: string, id: string) {
  return normalizePath(`${folder}/${id}.json`);
}

function registryFile(folder: string) {
  return normalizePath(`${folder}/${REGISTRY_FILE}`);
}

async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
  const normalised = normalizePath(folderPath);
  if (!vault.getAbstractFileByPath(normalised)) {
    await vault.createFolder(normalised);
  }
}

// ── Registry ───────────────────────────────────────────────────────────────────

export async function loadRegistry(app: App, folder: string): Promise<DocsRegistry> {
  const path = registryFile(folder);
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return { documents: [] };
  const raw = await app.vault.read(file);
  try { return JSON.parse(raw) as DocsRegistry; } catch { return { documents: [] }; }
}

async function saveRegistry(app: App, folder: string, registry: DocsRegistry): Promise<void> {
  await ensureFolder(app.vault, folder);
  const path = registryFile(folder);
  const content = JSON.stringify(registry, null, 2);
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) await app.vault.modify(file, content);
  else await app.vault.create(path, content);
}

// ── Document storage ───────────────────────────────────────────────────────────

export async function saveDocument(app: App, folder: string, doc: IndexedDoc): Promise<void> {
  await ensureFolder(app.vault, folder);
  const path = docFile(folder, doc.id);
  const content = JSON.stringify(doc, null, 2);
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) await app.vault.modify(file, content);
  else await app.vault.create(path, content);

  // Update registry
  const registry = await loadRegistry(app, folder);
  const { structure, pages, ...meta } = doc;
  const existing = registry.documents.findIndex(d => d.id === doc.id);
  if (existing >= 0) registry.documents[existing] = meta;
  else registry.documents.push(meta);
  await saveRegistry(app, folder, registry);
}

export async function loadDocument(app: App, folder: string, id: string): Promise<IndexedDoc | null> {
  const path = docFile(folder, id);
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !(file instanceof TFile)) return null;
  const raw = await app.vault.read(file);
  try { return JSON.parse(raw) as IndexedDoc; } catch { return null; }
}

export async function deleteDocument(app: App, folder: string, id: string): Promise<void> {
  const path = docFile(folder, id);
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) await app.vault.delete(file);

  const registry = await loadRegistry(app, folder);
  registry.documents = registry.documents.filter(d => d.id !== id);
  await saveRegistry(app, folder, registry);
}

export function findDocByPath(registry: DocsRegistry, vaultPath: string): string | undefined {
  return registry.documents.find(d => d.path === vaultPath)?.id;
}

export function generateId(): string {
  return uuidv4();
}

// ── Structure helpers ──────────────────────────────────────────────────────────

export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  const visit = (ns: TreeNode[]) => {
    for (const n of ns) { result.push(n); if (n.nodes) visit(n.nodes); }
  };
  visit(nodes);
  return result;
}

export function structureToText(nodes: TreeNode[]): string {
  const lines: string[] = [];
  const visit = (ns: TreeNode[], depth: number) => {
    for (const n of ns) {
      const indent = '  '.repeat(depth);
      const summary = n.summary ?? n.prefix_summary ?? '';
      lines.push(`${indent}[${n.node_id ?? '?'}] ${n.title}${summary ? ` — ${summary}` : ''}`);
      if (n.nodes) visit(n.nodes, depth + 1);
    }
  };
  visit(nodes, 0);
  return lines.join('\n');
}
