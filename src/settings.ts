import { App, PluginSettingTab, Setting } from 'obsidian';
import type { ProviderType } from './types';
import type PageIndexPlugin from './main';

export interface PageIndexSettings {
  indexingProvider: ProviderType;
  indexingModel: string;
  chatProvider: ProviderType;
  chatModel: string;

  anthropicApiKey: string;
  openaiApiKey: string;

  ollamaBaseUrl: string;
  lmStudioBaseUrl: string;

  claudeCliPath: string;
  codexCliPath: string;

  addSummary: boolean;
  addDescription: boolean;
  addText: boolean;
  summaryTokenThreshold: number;

  workspaceFolder: string;
}

export const DEFAULT_SETTINGS: PageIndexSettings = {
  indexingProvider: 'anthropic',
  indexingModel: 'claude-sonnet-4-6',
  chatProvider: 'anthropic',
  chatModel: 'claude-sonnet-4-6',
  anthropicApiKey: '',
  openaiApiKey: '',
  ollamaBaseUrl: 'http://localhost:11434',
  lmStudioBaseUrl: 'http://localhost:1234',
  claudeCliPath: 'claude',
  codexCliPath: 'codex',
  addSummary: true,
  addDescription: false,
  addText: false,
  summaryTokenThreshold: 200,
  workspaceFolder: '.pageindex',
};

const PROVIDER_OPTIONS: Record<ProviderType, string> = {
  'anthropic': 'Anthropic (Claude API)',
  'openai': 'OpenAI API',
  'ollama': 'Ollama (local, free)',
  'lm-studio': 'LM Studio (local, free)',
  'claude-cli': 'Claude Code CLI (free)',
  'codex-cli': 'Codex CLI (free)',
};

const INDEXING_PROVIDER_OPTIONS = Object.fromEntries(
  Object.entries(PROVIDER_OPTIONS).filter(([k]) => k !== 'codex-cli'),
) as Record<string, string>;

const MODEL_HINTS: Record<ProviderType, string> = {
  'anthropic': 'claude-sonnet-4-6',
  'openai': 'gpt-4o',
  'ollama': 'llama3.2',
  'lm-studio': 'local-model',
  'claude-cli': '(not used — CLI handles model selection)',
  'codex-cli': '(not used — CLI handles model selection)',
};

export class PageIndexSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PageIndexPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PageIndex RAG' });

    // ── Indexing LLM ──────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Indexing LLM' });
    containerEl.createEl('p', {
      text: 'Provider used when building the document index and generating summaries.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Provider')
      .addDropdown(dd => dd
        .addOptions(INDEXING_PROVIDER_OPTIONS)
        .setValue(this.plugin.settings.indexingProvider)
        .onChange(async (v) => {
          this.plugin.settings.indexingProvider = v as ProviderType;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Model')
      .setDesc(`Hint: ${MODEL_HINTS[this.plugin.settings.indexingProvider]}`)
      .addText(t => t
        .setValue(this.plugin.settings.indexingModel)
        .onChange(async (v) => { this.plugin.settings.indexingModel = v; await this.plugin.saveSettings(); }),
      );

    // ── Chat LLM ──────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Chat LLM' });
    containerEl.createEl('p', {
      text: 'Provider used when answering questions in the chat panel.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Provider')
      .addDropdown(dd => dd
        .addOptions(PROVIDER_OPTIONS as Record<string, string>)
        .setValue(this.plugin.settings.chatProvider)
        .onChange(async (v) => {
          this.plugin.settings.chatProvider = v as ProviderType;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Model')
      .setDesc(`Hint: ${MODEL_HINTS[this.plugin.settings.chatProvider]}`)
      .addText(t => t
        .setValue(this.plugin.settings.chatModel)
        .onChange(async (v) => { this.plugin.settings.chatModel = v; await this.plugin.saveSettings(); }),
      );

    // ── API Keys ──────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'API Keys' });

    new Setting(containerEl)
      .setName('Anthropic API key')
      .setDesc('Required for Anthropic provider (starts with sk-ant-...)')
      .addText(t => {
        t.setPlaceholder('sk-ant-...')
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (v) => { this.plugin.settings.anthropicApiKey = v; await this.plugin.saveSettings(); });
        t.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('OpenAI API key')
      .setDesc('Required for OpenAI provider (starts with sk-...)')
      .addText(t => {
        t.setPlaceholder('sk-...')
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (v) => { this.plugin.settings.openaiApiKey = v; await this.plugin.saveSettings(); });
        t.inputEl.type = 'password';
      });

    // ── Local Providers ───────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Local Providers' });

    new Setting(containerEl)
      .setName('Ollama base URL')
      .setDesc('Default: http://localhost:11434')
      .addText(t => t
        .setValue(this.plugin.settings.ollamaBaseUrl)
        .onChange(async (v) => { this.plugin.settings.ollamaBaseUrl = v; await this.plugin.saveSettings(); }),
      );

    new Setting(containerEl)
      .setName('LM Studio base URL')
      .setDesc('Default: http://localhost:1234')
      .addText(t => t
        .setValue(this.plugin.settings.lmStudioBaseUrl)
        .onChange(async (v) => { this.plugin.settings.lmStudioBaseUrl = v; await this.plugin.saveSettings(); }),
      );

    // ── CLI Providers ─────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'CLI Providers' });
    containerEl.createEl('p', {
      text: 'CLI providers are free — they use your locally installed Claude Code or Codex CLI tools.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Claude Code CLI command')
      .setDesc('Usually "claude". Must be in PATH or provide full path.')
      .addText(t => t
        .setValue(this.plugin.settings.claudeCliPath)
        .onChange(async (v) => { this.plugin.settings.claudeCliPath = v; await this.plugin.saveSettings(); }),
      );

    new Setting(containerEl)
      .setName('Codex CLI command')
      .setDesc('Usually "codex". Must be in PATH or provide full path.')
      .addText(t => t
        .setValue(this.plugin.settings.codexCliPath)
        .onChange(async (v) => { this.plugin.settings.codexCliPath = v; await this.plugin.saveSettings(); }),
      );

    // ── PDF Support ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'PDF Support' });
    containerEl.createEl('p', {
      text: 'PDF indexing is built-in — no extra setup needed. Open any .pdf file in Obsidian and run "PageIndex: Index current file".',
      cls: 'setting-item-description',
    });

    // ── Indexing Options ──────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Indexing Options' });

    new Setting(containerEl)
      .setName('Generate section summaries')
      .setDesc('LLM writes a short summary for each section (recommended — improves chat quality)')
      .addToggle(t => t
        .setValue(this.plugin.settings.addSummary)
        .onChange(async (v) => { this.plugin.settings.addSummary = v; await this.plugin.saveSettings(); }),
      );

    new Setting(containerEl)
      .setName('Generate document description')
      .setDesc('One-sentence description of the whole document')
      .addToggle(t => t
        .setValue(this.plugin.settings.addDescription)
        .onChange(async (v) => { this.plugin.settings.addDescription = v; await this.plugin.saveSettings(); }),
      );

    new Setting(containerEl)
      .setName('Store raw text in index')
      .setDesc('Faster retrieval but larger index files')
      .addToggle(t => t
        .setValue(this.plugin.settings.addText)
        .onChange(async (v) => { this.plugin.settings.addText = v; await this.plugin.saveSettings(); }),
      );

    new Setting(containerEl)
      .setName('Summary token threshold')
      .setDesc('Sections shorter than this word count are used as-is instead of being summarised')
      .addText(t => t
        .setValue(String(this.plugin.settings.summaryTokenThreshold))
        .onChange(async (v) => {
          const n = parseInt(v);
          if (!isNaN(n)) { this.plugin.settings.summaryTokenThreshold = n; await this.plugin.saveSettings(); }
        }),
      );

    // ── Workspace ─────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Workspace' });

    new Setting(containerEl)
      .setName('Index folder')
      .setDesc('Folder inside vault where index files are stored (relative path)')
      .addText(t => t
        .setValue(this.plugin.settings.workspaceFolder)
        .onChange(async (v) => { this.plugin.settings.workspaceFolder = v; await this.plugin.saveSettings(); }),
      );
  }
}
