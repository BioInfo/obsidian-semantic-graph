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

interface Node {
  id: string; label: string; cluster: number;
  x: number; y: number; vx: number; vy: number;
  degree: number;
}
interface Edge { source: string; target: string; weight: number; }

// Filter garbage filenames: Exchange IDs, UUID-like, very long base64 tokens
function isJunkFilename(name: string): boolean {
  if (name.length > 60) return true;
  // Exchange items: start with AAMk, AAQAA, etc.
  if (/^AA[A-Z]{2,4}[A-Za-z0-9+/]{20,}/.test(name)) return true;
  // Pure hex/base64 strings with no spaces or readable words
  if (name.length > 30 && /^[A-Za-z0-9_\-+=]{30,}$/.test(name) && !/\s/.test(name)) return true;
  return false;
}

export class SemanticGraphView extends ItemView {
  private store: IndexStore;
  settings: SemanticGraphSettings;

  // Simulation state
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private rafId: number | null = null;
  private simRunning = false;
  private alpha = 1.0;

  // Pan/zoom
  private tx = 0; private ty = 0; private scale = 1;
  private dragging = false;
  private dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

  // SVG elements
  private svgEl: SVGSVGElement | null = null;
  private gMain: SVGGElement | null = null;
  private gEdges: SVGGElement | null = null;
  private gNodes: SVGGElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, store: IndexStore, settings: SemanticGraphSettings) {
    super(leaf); this.store = store; this.settings = settings;
  }

  getViewType() { return SEMANTIC_GRAPH_VIEW; }
  getDisplayText() { return "Semantic Graph"; }
  getIcon() { return "git-fork"; }

  async onOpen() { this.render(); }
  async onClose() { this.stopSim(); }

  updateSettings(s: SemanticGraphSettings) { this.settings = s; }

  render() {
    this.stopSim();
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    Object.assign(container.style, {
      background: "#0d0d0d", position: "relative",
      overflow: "hidden", userSelect: "none",
    });

    const entries = this.store.entries().filter(([p]) => {
      const base = p.split("/").pop()?.replace(".md", "") ?? "";
      return !isJunkFilename(base);
    });

    if (entries.length === 0) {
      const msg = container.createEl("div", { text: "No notes indexed yet. Run 'Semantic Graph: Index vault' from the command palette." });
      Object.assign(msg.style, { color: "#666", margin: "auto", padding: "2rem", textAlign: "center", marginTop: "40vh" });
      return;
    }

    // Status bar
    this.statusEl = container.createEl("div");
    Object.assign(this.statusEl.style, {
      position: "absolute", top: "10px", left: "14px",
      fontSize: "11px", color: "#555", zIndex: "10", pointerEvents: "none",
    });

    // Controls
    const controls = container.createEl("div");
    Object.assign(controls.style, {
      position: "absolute", top: "8px", right: "12px",
      zIndex: "10", display: "flex", gap: "6px",
    });
    const btnStyle = "background:#1a1a1a;border:1px solid #333;color:#888;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;";
    const resetBtn = controls.createEl("button", { text: "Reset view" });
    resetBtn.style.cssText = btnStyle;
    resetBtn.addEventListener("click", () => this.resetView());
    const rerunBtn = controls.createEl("button", { text: "Re-layout" });
    rerunBtn.style.cssText = btnStyle;
    rerunBtn.addEventListener("click", () => this.reLayout());

    // SVG
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.style.cssText = "width:100%;height:100%;display:block;cursor:grab;";
    container.appendChild(svgEl);
    this.svgEl = svgEl;

    // Defs: glow filter
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>`;
    svgEl.appendChild(defs);

    // Main transform group
    this.gMain = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svgEl.appendChild(this.gMain);
    this.gEdges = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.gNodes = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.gMain.appendChild(this.gEdges);
    this.gMain.appendChild(this.gNodes);

    // Pan/zoom events
    svgEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svgEl.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.85 : 1.18;
      const newScale = Math.max(0.05, Math.min(8, this.scale * delta));
      this.tx = mx - (mx - this.tx) * (newScale / this.scale);
      this.ty = my - (my - this.ty) * (newScale / this.scale);
      this.scale = newScale;
      this.applyTransform();
    }, { passive: false });

    svgEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      svgEl.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      this.tx = this.dragStart.tx + (e.clientX - this.dragStart.x);
      this.ty = this.dragStart.ty + (e.clientY - this.dragStart.y);
      this.applyTransform();
    });
    window.addEventListener("mouseup", () => {
      this.dragging = false;
      if (this.svgEl) this.svgEl.style.cursor = "grab";
    });

    // Build graph data
    this.buildGraph(entries);
    this.initLayout(container.clientWidth || 900, container.clientHeight || 700);
    this.buildDOM();
    this.startSim();
  }

  private buildGraph(entries: [string, { vector: number[]; indexedAt: number }][]) {
    const capped = entries.slice(0, this.settings.maxNotes);
    const paths = capped.map(([p]) => p);
    const vectors = capped.map(([, e]) => e.vector);
    const clusters = kMeansClusters(vectors, this.settings.clusterCount);

    const degreeMap = new Map<string, number>();
    this.edges = [];
    const t = this.settings.similarityThreshold;
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim >= t) {
          this.edges.push({ source: paths[i], target: paths[j], weight: sim });
          degreeMap.set(paths[i], (degreeMap.get(paths[i]) ?? 0) + 1);
          degreeMap.set(paths[j], (degreeMap.get(paths[j]) ?? 0) + 1);
        }
      }
    }
    this.nodes = paths.map((path, i) => ({
      id: path,
      label: path.split("/").pop()?.replace(".md", "") ?? path,
      cluster: clusters[i],
      x: 0, y: 0, vx: 0, vy: 0,
      degree: degreeMap.get(path) ?? 0,
    }));
  }

  private initLayout(W: number, H: number) {
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.38;
    this.nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / this.nodes.length;
      // Spread by cluster to help separation
      const clusterOffset = (n.cluster / this.settings.clusterCount) * Math.PI * 0.5;
      n.x = cx + r * Math.cos(angle + clusterOffset) + (Math.random() - 0.5) * 40;
      n.y = cy + r * Math.sin(angle + clusterOffset) + (Math.random() - 0.5) * 40;
      n.vx = 0; n.vy = 0;
    });
    // Center transform
    this.tx = 0; this.ty = 0; this.scale = 1;
  }

  private buildDOM() {
    if (!this.gEdges || !this.gNodes) return;
    this.gEdges.innerHTML = "";
    this.gNodes.innerHTML = "";

    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));
    const t = this.settings.similarityThreshold;

    // Edges
    this.edges.forEach(e => {
      const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
      if (!a || !b) return;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.dataset.src = e.source; line.dataset.tgt = e.target;
      line.setAttribute("stroke", "#1e1e1e");
      const w = 0.4 + (e.weight - t) * 2;
      line.setAttribute("stroke-width", String(w));
      line.setAttribute("stroke-opacity", String(0.3 + (e.weight - t) * 1.5));
      this.gEdges!.appendChild(line);
    });

    // Nodes
    this.nodes.forEach(n => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.dataset.id = n.id;
      g.style.cursor = "pointer";

      const color = CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length];
      const baseR = Math.max(3, Math.min(7, 3 + Math.log1p(n.degree) * 0.8));

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", String(baseR));
      circle.setAttribute("fill", color);
      circle.setAttribute("opacity", "0.8");
      circle.setAttribute("filter", "url(#glow)");

      // Label — hidden until hover
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("font-size", "9");
      label.setAttribute("fill", "#ccc");
      label.setAttribute("x", String(baseR + 3));
      label.setAttribute("y", "3");
      label.setAttribute("pointer-events", "none");
      label.style.display = "none";
      const ltext = n.label.length > 28 ? n.label.slice(0, 28) + "…" : n.label;
      label.textContent = ltext;

      g.appendChild(circle);
      g.appendChild(label);

      g.addEventListener("mouseenter", () => {
        circle.setAttribute("r", String(baseR + 3));
        circle.setAttribute("opacity", "1");
        label.style.display = "";
        // Highlight connected edges
        this.highlightEdges(n.id, true);
      });
      g.addEventListener("mouseleave", () => {
        circle.setAttribute("r", String(baseR));
        circle.setAttribute("opacity", "0.8");
        label.style.display = "none";
        this.highlightEdges(n.id, false);
      });
      g.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(n.id);
        if (file) this.app.workspace.getLeaf().openFile(file as any);
      });

      this.gNodes!.appendChild(g);
    });

    this.updatePositions();
  }

  private highlightEdges(nodeId: string, on: boolean) {
    if (!this.gEdges) return;
    Array.from(this.gEdges.children).forEach(el => {
      const line = el as SVGLineElement;
      if (line.dataset.src === nodeId || line.dataset.tgt === nodeId) {
        line.setAttribute("stroke", on ? "#76b900" : "#1e1e1e");
        line.setAttribute("stroke-opacity", on ? "0.9" : "0.3");
      }
    });
  }

  private startSim() {
    this.simRunning = true;
    this.alpha = 1.0;
    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));
    const W = (this.svgEl?.clientWidth ?? 900);
    const H = (this.svgEl?.clientHeight ?? 700);
    const k = Math.sqrt((W * H) / Math.max(1, this.nodes.length));

    const tick = () => {
      if (!this.simRunning || this.alpha < 0.003) {
        this.simRunning = false;
        if (this.statusEl) this.statusEl.textContent =
          `${this.nodes.length} notes · ${this.edges.length} connections · ${this.settings.clusterCount} clusters`;
        return;
      }

      const alphaDecay = 0.0228;
      const velocityDecay = 0.4;
      this.alpha = this.alpha * (1 - alphaDecay);

      if (this.statusEl) this.statusEl.textContent =
        `Laying out… α=${this.alpha.toFixed(3)}`;

      // Repulsion (Barnes-Hut approximation skipped for simplicity, sample repulsion)
      const sampleStep = Math.max(1, Math.floor(this.nodes.length / 200));
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + sampleStep; j < this.nodes.length; j += sampleStep) {
          const ni = this.nodes[i], nj = this.nodes[j];
          const dx = nj.x - ni.x, dy = nj.y - ni.y;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
          const f = (k * k) / d * this.alpha * 2;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          ni.vx -= fx; ni.vy -= fy;
          nj.vx += fx; nj.vy += fy;
        }
      }

      // Attraction (edges)
      this.edges.forEach(e => {
        const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const strength = e.weight * this.alpha;
        const f = d / k * strength;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });

      // Centering
      let cx = 0, cy = 0;
      this.nodes.forEach(n => { cx += n.x; cy += n.y; });
      cx /= this.nodes.length; cy /= this.nodes.length;
      const tcx = W / 2, tcy = H / 2;
      this.nodes.forEach(n => {
        n.vx += (tcx - cx) * 0.01;
        n.vy += (tcy - cy) * 0.01;
      });

      // Update positions
      this.nodes.forEach(n => {
        n.vx *= velocityDecay;
        n.vy *= velocityDecay;
        n.x += n.vx;
        n.y += n.vy;
      });

      this.updatePositions();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopSim() {
    this.simRunning = false;
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  private updatePositions() {
    if (!this.gEdges || !this.gNodes) return;
    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));

    // Update edges
    Array.from(this.gEdges.children).forEach(el => {
      const line = el as SVGLineElement;
      const a = nodeMap.get(line.dataset.src ?? "");
      const b = nodeMap.get(line.dataset.tgt ?? "");
      if (a && b) {
        line.setAttribute("x1", String(a.x));
        line.setAttribute("y1", String(a.y));
        line.setAttribute("x2", String(b.x));
        line.setAttribute("y2", String(b.y));
      }
    });

    // Update nodes
    Array.from(this.gNodes.children).forEach(el => {
      const g = el as SVGGElement;
      const n = nodeMap.get(g.dataset.id ?? "");
      if (n) g.setAttribute("transform", `translate(${n.x},${n.y})`);
    });
  }

  private applyTransform() {
    if (this.gMain) this.gMain.setAttribute("transform", `translate(${this.tx},${this.ty}) scale(${this.scale})`);
  }

  private resetView() {
    this.tx = 0; this.ty = 0; this.scale = 1;
    this.applyTransform();
  }

  reLayout() {
    if (!this.svgEl) return;
    const W = this.svgEl.clientWidth || 900, H = this.svgEl.clientHeight || 700;
    this.initLayout(W, H);
    this.updatePositions();
    this.startSim();
  }
}
