import { Plugin, WorkspaceLeaf, Notice, TFile, addIcon } from 'obsidian';
import { PageIndexSettings, DEFAULT_SETTINGS, PageIndexSettingTab } from './settings';
import { ChatView, CHAT_VIEW_TYPE } from './views/ChatView';
import { indexMarkdown } from './md-indexer';
import { indexPdf } from './pdf-indexer';
import {
  loadRegistry,
  saveDocument,
  deleteDocument,
  findDocByPath,
  generateId,
} from './workspace';

export default class PageIndexPlugin extends Plugin {
  settings!: PageIndexSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon('message-circle', 'Open PageIndex Chat', () => this.openChat());

    this.addCommand({
      id: 'index-current-file',
      name: 'Index current file',
      callback: () => this.indexCurrentFile(),
    });

    this.addCommand({
      id: 'index-vault-markdown',
      name: 'Index all Markdown files in vault',
      callback: () => this.indexAllMarkdown(),
    });

    this.addCommand({
      id: 'open-chat',
      name: 'Open chat',
      callback: () => this.openChat(),
    });

    this.addCommand({
      id: 'remove-current-index',
      name: 'Remove index for current file',
      callback: () => this.removeCurrentIndex(),
    });

    this.addSettingTab(new PageIndexSettingTab(this.app, this));

    console.log('PageIndex RAG plugin loaded.');
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  async openChat() {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  async indexCurrentFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('No active file to index.'); return; }
    await this.indexFile(file);
  }

  async indexAllMarkdown() {
    const files = this.app.vault.getMarkdownFiles();
    const workFolder = this.settings.workspaceFolder;

    new Notice(`Indexing ${files.length} Markdown file(s)...`);
    let success = 0;
    let failed = 0;

    for (const file of files) {
      // Skip files inside the workspace folder itself
      if (file.path.startsWith(workFolder + '/')) continue;
      try {
        await this.indexFile(file, false);
        success++;
      } catch {
        failed++;
      }
    }

    new Notice(`Indexing complete: ${success} indexed, ${failed} failed.`);
  }

  async indexFile(file: TFile, notify = true) {
    const ext = file.extension.toLowerCase();
    if (ext !== 'md' && ext !== 'pdf') {
      if (notify) new Notice('PageIndex only supports .md and .pdf files.');
      return;
    }

    if (notify) new Notice(`Indexing ${file.name}...`);

    try {
      if (ext === 'md') {
        await this.indexMdFile(file);
      } else {
        await this.indexPdfFile(file);
      }
      if (notify) new Notice(`✓ Indexed: ${file.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to index ${file.name}: ${msg}`);
      console.error('[PageIndex] Index error:', err);
    }
  }

  private async indexMdFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const docName = file.basename;

    const result = await indexMarkdown(content, docName, this.settings, (msg) => {
      console.log(`[PageIndex] ${msg}`);
    });

    // Check if already indexed — reuse existing id
    const registry = await loadRegistry(this.app, this.settings.workspaceFolder);
    const existingId = findDocByPath(registry, file.path);

    const doc = {
      id: existingId ?? generateId(),
      type: 'md' as const,
      path: file.path,
      doc_name: result.doc_name,
      doc_description: result.doc_description,
      line_count: result.line_count,
      indexed_at: Date.now(),
      structure: result.structure,
    };

    await saveDocument(this.app, this.settings.workspaceFolder, doc);
  }

  private async indexPdfFile(file: TFile) {
    if (!this.settings.pageindexRagPath) {
      throw new Error(
        'PDF indexing requires the PageIndexRAG path to be set in plugin settings. ' +
        'Go to Settings → PageIndex RAG → PDF Support.',
      );
    }

    const absolutePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
    const fullPath = `${absolutePath}/${file.path}`.replace(/\\/g, '/');

    const result = await indexPdf(fullPath, file.basename, this.settings, (msg) => {
      console.log(`[PageIndex] ${msg}`);
    });

    const registry = await loadRegistry(this.app, this.settings.workspaceFolder);
    const existingId = findDocByPath(registry, file.path);

    const doc = {
      id: existingId ?? generateId(),
      type: 'pdf' as const,
      path: file.path,
      doc_name: result.doc_name,
      doc_description: result.doc_description,
      page_count: result.page_count,
      indexed_at: Date.now(),
      structure: result.structure,
      pages: result.pages,
    };

    await saveDocument(this.app, this.settings.workspaceFolder, doc);
  }

  async removeCurrentIndex() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('No active file.'); return; }

    const registry = await loadRegistry(this.app, this.settings.workspaceFolder);
    const id = findDocByPath(registry, file.path);

    if (!id) { new Notice(`No index found for ${file.name}.`); return; }

    await deleteDocument(this.app, this.settings.workspaceFolder, id);
    new Notice(`Removed index for ${file.name}.`);
  }
}
