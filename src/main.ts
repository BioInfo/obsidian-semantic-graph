import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { DEFAULT_SETTINGS, SemanticGraphSettings } from "./settings";
import { embedTexts } from "./embedder";
import { IndexStore } from "./index-store";
import { SemanticGraphView, SEMANTIC_GRAPH_VIEW } from "./graph-view";

export default class SemanticGraphPlugin extends Plugin {
  settings: SemanticGraphSettings;
  store: IndexStore;

  async onload() {
    await this.loadSettings();
    this.store = new IndexStore();
    this.store.load(localStorage);

    // Register the graph view
    this.registerView(
      SEMANTIC_GRAPH_VIEW,
      (leaf) => new SemanticGraphView(leaf, this.store, this.settings)
    );

    // Ribbon icon
    this.addRibbonIcon("git-fork", "Semantic Graph", () => {
      this.activateView();
    });

    // Commands
    this.addCommand({
      id: "open-semantic-graph",
      name: "Open semantic graph",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "index-vault",
      name: "Index vault (embed all notes)",
      callback: () => this.indexVault(),
    });

    this.addCommand({
      id: "clear-index",
      name: "Clear index",
      callback: () => {
        this.store.clear();
        this.store.save(localStorage);
        new Notice("Semantic Graph: Index cleared.");
      },
    });

    // Auto-index on save
    if (this.settings.autoIndexOnSave) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.indexFile(file);
          }
        })
      );
    }

    // Settings tab
    this.addSettingTab(new SemanticGraphSettingTab(this.app, this));

    console.log("Semantic Graph plugin loaded.");
  }

  onunload() {
    this.store.save(localStorage);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SEMANTIC_GRAPH_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: SEMANTIC_GRAPH_VIEW, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async indexFile(file: TFile) {
    try {
      const content = await this.app.vault.cachedRead(file);
      const text = content.slice(0, 2000); // First 2K chars is enough for embedding
      const [vector] = await embedTexts([text], this.settings);
      this.store.set(file.path, { vector, indexedAt: Date.now() });
      this.store.save(localStorage);
    } catch (e) {
      console.warn(`Semantic Graph: failed to embed ${file.path}:`, e);
    }
  }

  async indexVault() {
    const files = this.app.vault
      .getMarkdownFiles()
      .slice(0, this.settings.maxNotes);

    new Notice(`Semantic Graph: Indexing ${files.length} notes…`);

    // Process in batches of 16
    const batchSize = 16;
    let done = 0;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      try {
        const texts = await Promise.all(
          batch.map((f) => this.app.vault.cachedRead(f).then((c) => c.slice(0, 2000)))
        );
        const vectors = await embedTexts(texts, this.settings);
        batch.forEach((f, j) => {
          this.store.set(f.path, { vector: vectors[j], indexedAt: Date.now() });
        });
        done += batch.length;
      } catch (e) {
        new Notice(`Semantic Graph: Error in batch ${i / batchSize + 1}: ${e}`);
      }
    }

    this.store.save(localStorage);
    new Notice(`Semantic Graph: Indexed ${done} notes ✓`);

    // Refresh open view if any
    const leaf = this.app.workspace.getLeavesOfType(SEMANTIC_GRAPH_VIEW)[0];
    if (leaf) (leaf.view as SemanticGraphView).render();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SemanticGraphSettingTab extends PluginSettingTab {
  plugin: SemanticGraphPlugin;

  constructor(app: App, plugin: SemanticGraphPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Semantic Graph" });

    new Setting(containerEl)
      .setName("Embedding endpoint")
      .setDesc("OpenAI-compatible /v1/embeddings URL (local or cloud)")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:4001/v1/embeddings")
          .setValue(this.plugin.settings.embeddingEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.embeddingEndpoint = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Optional — leave blank for local endpoints without auth")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Embedding model name sent to the API")
      .addText((text) =>
        text
          .setPlaceholder("all-mpnet-base-v2")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Similarity threshold")
      .setDesc("Minimum cosine similarity to draw an edge (0–1). Lower = more edges.")
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 0.9, 0.05)
          .setValue(this.plugin.settings.similarityThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.similarityThreshold = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Cluster count")
      .setDesc("Number of topic clusters (colors) in the graph")
      .addSlider((slider) =>
        slider
          .setLimits(2, 16, 1)
          .setValue(this.plugin.settings.clusterCount)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.clusterCount = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max notes")
      .setDesc("Cap on notes rendered (for performance)")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxNotes))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxNotes = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Auto-index on save")
      .setDesc("Re-embed a note whenever you save it (requires restart to take effect)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoIndexOnSave)
          .onChange(async (value) => {
            this.plugin.settings.autoIndexOnSave = value;
            await this.plugin.saveSettings();
          })
      );

    // Test connection button
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify your embedding endpoint is reachable")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          try {
            const res = await fetch(
              this.plugin.settings.embeddingEndpoint.replace("/v1/embeddings", "/health")
            );
            const data = await res.json();
            new Notice(`✓ Connected: ${JSON.stringify(data)}`);
          } catch (e) {
            new Notice(`✗ Connection failed: ${e}`);
          }
        })
      );
  }
}
