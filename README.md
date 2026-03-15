# Obsidian Semantic Graph

**Visualize your vault as a semantic similarity graph — notes cluster by meaning, not just links.**

Instead of Obsidian's link-based graph, this plugin embeds every note using an AI model and positions them by *conceptual similarity*. Notes that discuss the same ideas naturally group into clusters, regardless of whether they're linked to each other.

---

## Features

- 🔮 **Semantic clustering** — notes group by topic, not just backlinks
- ⚡ **Any OpenAI-compatible endpoint** — works with OpenAI, local models (Ollama, LM Studio, LiteLLM), or any self-hosted embedding server
- 🎨 **Beautiful canvas renderer** — GPU-accelerated glow nodes, force-directed layout, smooth animation
- 🖱️ **Full navigation** — scroll to zoom, drag to pan, Shift+drag to marquee-zoom a region, double-click to fit all
- 💡 **Smart tooltips** — hover any node to see note name, folder, cluster, and connection count
- 🎯 **Click to open** — click any node to open the note in Obsidian
- 🌈 **Color-coded clusters** — up to 10 distinct cluster colors with legend
- 🔍 **Junk-file filtering** — automatically excludes generated IDs and non-readable filenames

---

## Quick Start

### 1. Install

Install from the Obsidian Community Plugins browser, or manually:

```bash
cd <vault>/.obsidian/plugins/
git clone https://github.com/BioInfo/obsidian-semantic-graph semantic-graph
```

### 2. Configure an embedding endpoint

Open **Settings → Semantic Graph** and set your endpoint:

| Provider | Endpoint | Model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1/embeddings` | `text-embedding-3-small` |
| Ollama (local) | `http://localhost:11434/v1/embeddings` | `nomic-embed-text` |
| LM Studio | `http://localhost:1234/v1/embeddings` | *(model loaded in LM Studio)* |
| LiteLLM proxy | `http://localhost:4000/v1/embeddings` | *(proxy-configured model)* |
| Any OpenAI-compatible | your URL | your model name |

Set your **API key** if required (leave blank for local models).

### 3. Index your vault

Open the command palette (`Cmd/Ctrl+P`) and run **Semantic Graph: Index vault**.

The plugin embeds notes in batches of 16 and caches results — subsequent opens are instant.

### 4. Open the graph

Run **Semantic Graph: Open graph** from the command palette, or use the ribbon icon.

---

## Navigation

| Action | How |
|---|---|
| Pan | Click + drag |
| Zoom | Scroll wheel |
| Zoom in/out | `+` / `−` buttons |
| Fit all nodes | `⊡` button or double-click |
| Zoom to region | **Shift + drag** to draw a box |
| Open note | Click a node |
| See note info | Hover a node |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Embedding endpoint | `https://api.openai.com/v1/embeddings` | Any OpenAI-compatible URL |
| API key | *(blank)* | Bearer token for your endpoint |
| Model | `text-embedding-3-small` | Embedding model name |
| Similarity threshold | `0.65` | Minimum cosine similarity for an edge (0–1) |
| Cluster count | `8` | Number of semantic clusters (colors) |
| Max notes | `500` | Cap on notes indexed per run |
| Auto-index on save | `off` | Re-embed a note when you save it |

---

## How It Works

1. **Embedding** — each note's text content is sent to your embedding endpoint and the resulting vector is cached locally in `.obsidian/plugins/semantic-graph/index-store.json`
2. **Similarity** — cosine similarity is computed between all note pairs; edges are drawn above the threshold
3. **Clustering** — k-means clustering assigns each note to a color group
4. **Layout** — a force-directed simulation runs until it converges, with cluster cohesion forces that pull same-cluster nodes together into visible "islands"
5. **Rendering** — HTML5 Canvas renders nodes with layered radial glow, edges, tooltips, and the marquee overlay

The index persists between sessions — only new or modified notes need re-embedding.

---

## Privacy

- All embedding requests go directly from Obsidian to your configured endpoint (cloud or local)
- The cached index (vectors + note paths) lives in your vault's `.obsidian` folder and is never sent anywhere else
- No telemetry

---

## Development

```bash
git clone https://github.com/BioInfo/obsidian-semantic-graph
cd obsidian-semantic-graph
npm install
npm run build          # production build → main.js
npm run dev            # watch mode
```

Copy `main.js`, `manifest.json`, and `styles.css` (if present) into your vault's plugin folder.

---

## Roadmap

- [ ] Search bar to find and highlight a note in the graph
- [ ] Filter by folder or tag
- [ ] Hover preview (note excerpt on hover)
- [ ] Timeline view — notes colored by last-modified date
- [ ] Export graph as SVG/PNG

---

## License

MIT — see [LICENSE](LICENSE)
