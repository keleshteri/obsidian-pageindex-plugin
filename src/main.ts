import { Plugin, Notice, TFile } from 'obsidian';
import { PageIndexSettings, DEFAULT_SETTINGS, PageIndexSettingTab } from './settings';
import { ChatView, CHAT_VIEW_TYPE } from './views/ChatView';
import { indexMdFile, indexPdfFile, type PdfIndexResult } from './indexer';
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
    this.patchModuleResolver();

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

  // ── Module resolver patch ──────────────────────────────────────────────────
  // Electron's renderer require() resolves modules from the app directory, not
  // the plugin folder. We patch Module._resolveFilename here — after onload()
  // gives us the vault's base path — so that pdf-parse and js-tiktoken resolve
  // from this plugin's own node_modules. The library uses lazy requires for
  // both, so this patch is always in place before the first require fires.

  private patchModuleResolver(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Module = require('module') as {
        _resolveFilename: (id: string, parent: unknown, isMain: boolean, opts: unknown) => string;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodePath = require('path') as typeof import('path');

      const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
      if (!basePath) return;

      const pluginNodeModules = nodePath.join(
        basePath, '.obsidian', 'plugins', this.manifest.id, 'node_modules',
      );
      const targets: Record<string, true> = { 'pdf-parse': true, 'js-tiktoken': true };
      const orig = Module._resolveFilename;

      Module._resolveFilename = function (id, parent, isMain, opts) {
        try { return orig.call(this, id, parent, isMain, opts); }
        catch (e) {
          if (targets[id]) {
            try { return orig.call(this, nodePath.join(pluginNodeModules, id), parent, isMain, opts); }
            catch { /* fall through */ }
          }
          throw e;
        }
      };

      // Disable pdf.js web worker for Electron renderer.
      //
      // pdf.js v1.10.100 (used by pdf-parse) reads disableWorker from window.PDFJS,
      // not from its module export. require(pdfJsPath) returns the bundle's export
      // wrapper {PDFJS, getDocument, ...} — NOT window.PDFJS itself.
      //
      // Strategy:
      //   1. Set window.PDFJS.disableWorker = true BEFORE loading pdf.js —
      //      pdf.js line 14227 does `PDFJS.disableWorker = PDFJS.disableWorker === undefined ? false : PDFJS.disableWorker`
      //      so our truthy value survives (only resets when undefined).
      //   2. Pre-load pdf.js into the require cache so pdf-parse gets the same instance.
      //   3. Set window.PDFJS.disableWorker = true again after load as belt-and-suspenders.
      try {
        if (typeof window !== 'undefined') {
          (window as Window & { PDFJS?: Record<string, unknown> }).PDFJS =
            (window as any).PDFJS ?? {};
          (window as any).PDFJS.disableWorker = true;
        }
        const pdfJsPath = nodePath.join(
          pluginNodeModules, 'pdf-parse', 'lib', 'pdf.js', 'v1.10.100', 'build', 'pdf.js',
        );
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require(pdfJsPath);
        // Re-assert after load in case pdf.js reset it.
        if (typeof window !== 'undefined' && (window as any).PDFJS) {
          (window as any).PDFJS.disableWorker = true;
        }
      } catch (e) {
        console.warn('[PageIndex] pdf.js pre-load failed:', e);
      }
    } catch { /* non-fatal */ }
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
    const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
    const absolutePath = `${basePath}/${file.path}`.replace(/\\/g, '/');
    const docName = file.basename;

    const result = await indexMdFile(absolutePath, this.settings, (msg) => {
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
    const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
    const absolutePath = `${basePath}/${file.path}`.replace(/\\/g, '/');

    const result = await indexPdfFile(absolutePath, this.settings, (msg) => {
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
