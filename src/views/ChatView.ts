import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type PageIndexPlugin from '../main';
import type { ChatMessage, IndexedDoc } from '../types';
import type { LLMMessage } from '../providers';
import { loadRegistry, loadDocument } from '../workspace';
import { answerQuestion } from '../retrieval';

export const CHAT_VIEW_TYPE = 'pageindex-chat';

export class ChatView extends ItemView {
  private plugin: PageIndexPlugin;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private docSelect!: HTMLSelectElement;
  private statusEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;

  private history: LLMMessage[] = [];
  private currentDoc: IndexedDoc | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PageIndexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return CHAT_VIEW_TYPE; }
  getDisplayText() { return 'PageIndex Chat'; }
  getIcon() { return 'message-circle'; }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('pageindex-chat-root');

    // ── Header ────────────────────────────────────────────────────────────────
    const header = root.createDiv('pageindex-chat-header');
    header.createEl('span', { text: 'PageIndex Chat', cls: 'pageindex-chat-title' });

    const clearBtn = header.createEl('button', { cls: 'pageindex-icon-btn', title: 'Clear chat' });
    setIcon(clearBtn, 'eraser');
    clearBtn.addEventListener('click', () => this.clearChat());

    const refreshBtn = header.createEl('button', { cls: 'pageindex-icon-btn', title: 'Refresh document list' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refreshDocList());

    // ── Document selector ─────────────────────────────────────────────────────
    const selectorRow = root.createDiv('pageindex-selector-row');
    selectorRow.createEl('label', { text: 'Document:', cls: 'pageindex-selector-label' });
    this.docSelect = selectorRow.createEl('select', { cls: 'pageindex-doc-select' });
    this.docSelect.addEventListener('change', () => this.onDocChange());

    // ── Messages ──────────────────────────────────────────────────────────────
    this.messagesEl = root.createDiv('pageindex-messages');

    // ── Status ────────────────────────────────────────────────────────────────
    this.statusEl = root.createDiv('pageindex-status');
    this.statusEl.style.display = 'none';

    // ── Input area ────────────────────────────────────────────────────────────
    const inputArea = root.createDiv('pageindex-input-area');
    this.inputEl = inputArea.createEl('textarea', {
      cls: 'pageindex-input',
      attr: { placeholder: 'Ask a question about this document...', rows: '3' },
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.sendBtn = inputArea.createEl('button', { text: 'Send', cls: 'pageindex-send-btn' });
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    const hint = inputArea.createEl('div', { text: 'Ctrl+Enter to send', cls: 'pageindex-hint' });

    await this.refreshDocList();
    this.addWelcomeMessage();
  }

  async onClose() { /* nothing to clean up */ }

  // ── Document list ──────────────────────────────────────────────────────────

  private async refreshDocList() {
    const registry = await loadRegistry(this.app, this.plugin.settings.workspaceFolder);
    this.docSelect.empty();

    if (registry.documents.length === 0) {
      const opt = this.docSelect.createEl('option', { text: '— No indexed documents —' });
      opt.disabled = true;
      this.currentDoc = null;
      return;
    }

    const placeholder = this.docSelect.createEl('option', { text: 'Select a document...' });
    placeholder.value = '';

    for (const doc of registry.documents) {
      const opt = this.docSelect.createEl('option', { text: doc.doc_name, value: doc.id });
    }

    // Auto-select if only one document
    if (registry.documents.length === 1) {
      this.docSelect.value = registry.documents[0].id;
      await this.onDocChange();
    }
  }

  private async onDocChange() {
    const id = this.docSelect.value;
    if (!id) { this.currentDoc = null; return; }

    this.setStatus('Loading document index...');
    this.currentDoc = await loadDocument(this.app, this.plugin.settings.workspaceFolder, id);
    this.clearStatus();
    this.clearChat();

    if (this.currentDoc) {
      this.addSystemMessage(`Loaded **${this.currentDoc.doc_name}**. Ask me anything about it.`);
    }
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  private async sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.currentDoc) {
      new Notice('Select an indexed document first.');
      return;
    }

    this.inputEl.value = '';
    this.setInputEnabled(false);

    this.appendMessage({ role: 'user', content: text, timestamp: Date.now() });

    try {
      const answer = await answerQuestion(
        text,
        this.currentDoc,
        this.history,
        this.plugin.settings,
        (msg) => this.setStatus(msg),
      );

      this.history.push({ role: 'user', content: text });
      this.history.push({ role: 'assistant', content: answer });

      // Keep last 10 turns to avoid context bloat
      if (this.history.length > 20) this.history = this.history.slice(-20);

      this.appendMessage({ role: 'assistant', content: answer, timestamp: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendMessage({
        role: 'assistant',
        content: `Error: ${msg}`,
        timestamp: Date.now(),
      });
      new Notice(`PageIndex chat error: ${msg}`);
    } finally {
      this.clearStatus();
      this.setInputEnabled(true);
      this.inputEl.focus();
    }
  }

  private appendMessage(msg: ChatMessage) {
    const wrap = this.messagesEl.createDiv(`pageindex-msg pageindex-msg-${msg.role}`);

    const avatar = wrap.createDiv('pageindex-msg-avatar');
    setIcon(avatar, msg.role === 'user' ? 'user' : 'bot');

    const bubble = wrap.createDiv('pageindex-msg-bubble');
    // Render markdown-like content (simple line breaks and bold)
    bubble.innerHTML = this.renderContent(msg.content);

    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
  }

  private addSystemMessage(text: string) {
    const wrap = this.messagesEl.createDiv('pageindex-msg pageindex-msg-system');
    wrap.createEl('em', { text });
  }

  private addWelcomeMessage() {
    this.addSystemMessage('Select an indexed document above to start chatting.');
  }

  private renderContent(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  private clearChat() {
    this.messagesEl.empty();
    this.history = [];
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  private setStatus(msg: string) {
    this.statusEl.setText(msg);
    this.statusEl.style.display = 'block';
  }

  private clearStatus() {
    this.statusEl.style.display = 'none';
    this.statusEl.setText('');
  }

  private setInputEnabled(enabled: boolean) {
    this.inputEl.disabled = !enabled;
    this.sendBtn.disabled = !enabled;
    this.sendBtn.setText(enabled ? 'Send' : 'Thinking...');
  }
}
