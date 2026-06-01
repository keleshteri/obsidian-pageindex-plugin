import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type PageIndexPlugin from '../main';
import type { ChatMessage } from '../types';
import { loadRegistry } from '../workspace';
import { VaultQueryEngine, type QueryResult } from '../query-engine';

export const CHAT_VIEW_TYPE = 'pageindex-chat';

export class ChatView extends ItemView {
  private plugin: PageIndexPlugin;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private docCountEl!: HTMLElement;

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

    const refreshBtn = header.createEl('button', { cls: 'pageindex-icon-btn', title: 'Refresh index count' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refreshDocCount());

    // ── Index status ──────────────────────────────────────────────────────────
    this.docCountEl = root.createDiv('pageindex-doc-count');

    // ── Messages ──────────────────────────────────────────────────────────────
    this.messagesEl = root.createDiv('pageindex-messages');

    // ── Status ────────────────────────────────────────────────────────────────
    this.statusEl = root.createDiv('pageindex-status');
    this.statusEl.style.display = 'none';

    // ── Input area ────────────────────────────────────────────────────────────
    const inputArea = root.createDiv('pageindex-input-area');
    this.inputEl = inputArea.createEl('textarea', {
      cls: 'pageindex-input',
      attr: { placeholder: 'Ask anything about your vault...', rows: '3' },
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.sendBtn = inputArea.createEl('button', { text: 'Ask', cls: 'pageindex-send-btn' });
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    inputArea.createEl('div', { text: 'Ctrl+Enter to send', cls: 'pageindex-hint' });

    await this.refreshDocCount();
  }

  async onClose() { /* nothing to clean up */ }

  // ── Index status ───────────────────────────────────────────────────────────

  private async refreshDocCount() {
    const registry = await loadRegistry(this.app, this.plugin.settings.workspaceFolder);
    const count = registry.documents.length;

    if (count === 0) {
      this.docCountEl.setText('No documents indexed — run "Index all Markdown files" first.');
      this.docCountEl.addClass('pageindex-doc-count-empty');
    } else {
      this.docCountEl.setText(`Searching across ${count} indexed document${count === 1 ? '' : 's'}`);
      this.docCountEl.removeClass('pageindex-doc-count-empty');
    }
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  private async sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = '';
    this.setInputEnabled(false);
    this.appendUserMessage(text);

    try {
      const engine = new VaultQueryEngine(this.app, this.plugin.settings);
      const result = await engine.query(text, (msg) => this.setStatus(msg));
      this.appendAnswer(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendMessage({ role: 'assistant', content: `Error: ${msg}`, timestamp: Date.now() });
      new Notice(`PageIndex error: ${msg}`);
    } finally {
      this.clearStatus();
      this.setInputEnabled(true);
      this.inputEl.focus();
    }
  }

  private appendUserMessage(text: string) {
    const wrap = this.messagesEl.createDiv('pageindex-msg pageindex-msg-user');
    const avatar = wrap.createDiv('pageindex-msg-avatar');
    setIcon(avatar, 'user');
    const bubble = wrap.createDiv('pageindex-msg-bubble');
    bubble.innerHTML = this.renderContent(text);
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
  }

  private appendAnswer(result: QueryResult) {
    const wrap = this.messagesEl.createDiv('pageindex-msg pageindex-msg-assistant');
    const avatar = wrap.createDiv('pageindex-msg-avatar');
    setIcon(avatar, 'bot');

    const bubble = wrap.createDiv('pageindex-msg-bubble');
    bubble.innerHTML = this.renderContent(result.answer);

    if (result.sources.length > 0) {
      const sourcesEl = bubble.createDiv('pageindex-sources');
      sourcesEl.createEl('span', { text: 'Sources: ', cls: 'pageindex-sources-label' });

      result.sources.forEach((s, i) => {
        if (i > 0) sourcesEl.createSpan({ text: ' · ' });
        const link = sourcesEl.createEl('a', {
          text: s.docName,
          cls: 'pageindex-source-link',
          href: '#',
        });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(s.path, '', false);
        });
      });
    }

    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
  }

  private appendMessage(msg: ChatMessage) {
    const wrap = this.messagesEl.createDiv(`pageindex-msg pageindex-msg-${msg.role}`);
    const avatar = wrap.createDiv('pageindex-msg-avatar');
    setIcon(avatar, msg.role === 'user' ? 'user' : 'bot');
    const bubble = wrap.createDiv('pageindex-msg-bubble');
    bubble.innerHTML = this.renderContent(msg.content);
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
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
    this.sendBtn.setText(enabled ? 'Ask' : 'Thinking...');
  }
}
