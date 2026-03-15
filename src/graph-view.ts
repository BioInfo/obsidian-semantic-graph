import { ItemView, WorkspaceLeaf } from "obsidian";
import { cosineSimilarity, kMeansClusters } from "./embedder";
import { IndexStore } from "./index-store";
import { SemanticGraphSettings } from "./settings";

export const SEMANTIC_GRAPH_VIEW = "semantic-graph-view";

const CLUSTER_COLORS = [
  "#76b900", "#4a9eff", "#ff6b6b", "#ffd93d",
  "#6bcb77", "#c77dff", "#ff9f43", "#48cae4",
  "#f72585", "#b5e48c",
];

interface GraphNode {
  id: string;       // note path
  label: string;    // note basename
  cluster: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export class SemanticGraphView extends ItemView {
  private store: IndexStore;
  private settings: SemanticGraphSettings;
  private svg: SVGSVGElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    store: IndexStore,
    settings: SemanticGraphSettings
  ) {
    super(leaf);
    this.store = store;
    this.settings = settings;
  }

  getViewType(): string { return SEMANTIC_GRAPH_VIEW; }
  getDisplayText(): string { return "Semantic Graph"; }
  getIcon(): string { return "git-fork"; }

  async onOpen() {
    this.render();
  }

  async onClose() {}

  updateSettings(settings: SemanticGraphSettings) {
    this.settings = settings;
    this.render();
  }

  render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.style.background = "#0d0d0d";
    container.style.position = "relative";

    const entries = this.store.entries();
    if (entries.length === 0) {
      container.createEl("div", {
        text: "No notes indexed yet. Run 'Semantic Graph: Index vault' from the command palette.",
        cls: "semantic-graph-empty",
      });
      container.style.display = "flex";
      container.style.alignItems = "center";
      container.style.justifyContent = "center";
      container.style.color = "#888";
      container.style.padding = "2rem";
      return;
    }

    const { nodes, edges } = this.buildGraph(entries);

    // Status bar
    const status = container.createEl("div");
    status.style.cssText = "position:absolute;top:8px;left:12px;font-size:11px;color:#888;z-index:10;pointer-events:none;";
    status.textContent = `${nodes.length} notes · ${edges.length} connections · ${this.settings.clusterCount} clusters`;

    // SVG canvas
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.style.cssText = "width:100%;height:100%;display:block;";
    container.appendChild(svgEl);
    this.svg = svgEl;

    // Simple force-directed layout (pure TS, no D3 dependency at runtime)
    this.runForceLayout(nodes, edges, svgEl, container);
  }

  private buildGraph(entries: [string, { vector: number[]; indexedAt: number }][]) {
    const capped = entries.slice(0, this.settings.maxNotes);
    const paths = capped.map(([p]) => p);
    const vectors = capped.map(([, e]) => e.vector);

    const clusterAssignments = kMeansClusters(vectors, this.settings.clusterCount);

    const nodes: GraphNode[] = paths.map((path, i) => ({
      id: path,
      label: path.split("/").pop()?.replace(".md", "") ?? path,
      cluster: clusterAssignments[i],
    }));

    const edges: GraphEdge[] = [];
    const threshold = this.settings.similarityThreshold;
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim >= threshold) {
          edges.push({ source: paths[i], target: paths[j], weight: sim });
        }
      }
    }

    return { nodes, edges };
  }

  private runForceLayout(
    nodes: GraphNode[],
    edges: GraphEdge[],
    svgEl: SVGSVGElement,
    container: HTMLElement
  ) {
    const W = container.clientWidth || 800;
    const H = container.clientHeight || 600;
    const cx = W / 2, cy = H / 2;

    // Initialize positions in a circle
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length;
      const r = Math.min(W, H) * 0.35;
      n.x = cx + r * Math.cos(angle);
      n.y = cy + r * Math.sin(angle);
      n.vx = 0; n.vy = 0;
    });

    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const edgeSet = new Map<string, number>();
    edges.forEach(e => {
      edgeSet.set(`${e.source}||${e.target}`, e.weight);
    });

    // Simple force simulation (100 iterations)
    const k = Math.sqrt((W * H) / nodes.length);
    for (let iter = 0; iter < 100; iter++) {
      // Repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x! - nodes[i].x!;
          const dy = nodes[j].y! - nodes[i].y!;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
          const f = (k * k) / d;
          nodes[i].vx! -= (dx / d) * f;
          nodes[i].vy! -= (dy / d) * f;
          nodes[j].vx! += (dx / d) * f;
          nodes[j].vy! += (dy / d) * f;
        }
      }
      // Attraction along edges
      edges.forEach(e => {
        const a = nodeMap.get(e.source)!;
        const b = nodeMap.get(e.target)!;
        if (!a || !b) return;
        const dx = b.x! - a.x!;
        const dy = b.y! - a.y!;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const f = (d * d) / k;
        a.vx! += (dx / d) * f;
        a.vy! += (dy / d) * f;
        b.vx! -= (dx / d) * f;
        b.vy! -= (dy / d) * f;
      });
      // Update positions with damping
      const temp = 1 - iter / 100;
      nodes.forEach(n => {
        const mag = Math.sqrt(n.vx! * n.vx! + n.vy! * n.vy!) + 0.01;
        const step = Math.min(mag, 10 * temp);
        n.x = Math.max(20, Math.min(W - 20, n.x! + (n.vx! / mag) * step));
        n.y = Math.max(20, Math.min(H - 20, n.y! + (n.vy! / mag) * step));
        n.vx = 0; n.vy = 0;
      });
    }

    // Render edges
    const edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    edges.forEach(e => {
      const a = nodeMap.get(e.source)!;
      const b = nodeMap.get(e.target)!;
      if (!a || !b) return;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", "#333");
      line.setAttribute("stroke-width", String(0.5 + (e.weight - this.settings.similarityThreshold) * 3));
      line.setAttribute("stroke-opacity", "0.6");
      edgeGroup.appendChild(line);
    });
    svgEl.appendChild(edgeGroup);

    // Render nodes
    const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    nodes.forEach(n => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.style.cursor = "pointer";

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(n.x));
      circle.setAttribute("cy", String(n.y));
      circle.setAttribute("r", "5");
      circle.setAttribute("fill", CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length]);
      circle.setAttribute("opacity", "0.85");

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(n.x! + 7));
      label.setAttribute("y", String(n.y! + 4));
      label.setAttribute("font-size", "9");
      label.setAttribute("fill", "#aaa");
      label.setAttribute("pointer-events", "none");
      label.textContent = n.label.length > 20 ? n.label.slice(0, 20) + "…" : n.label;

      g.appendChild(circle);
      g.appendChild(label);

      // Click to open note
      g.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(n.id);
        if (file) this.app.workspace.getLeaf().openFile(file as any);
      });

      // Hover highlight
      g.addEventListener("mouseenter", () => circle.setAttribute("r", "7"));
      g.addEventListener("mouseleave", () => circle.setAttribute("r", "5"));

      nodeGroup.appendChild(g);
    });
    svgEl.appendChild(nodeGroup);
  }
}
