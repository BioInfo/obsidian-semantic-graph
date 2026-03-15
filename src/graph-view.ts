import { ItemView, WorkspaceLeaf } from "obsidian";
import { cosineSimilarity, kMeansClusters } from "./embedder";
import { IndexStore } from "./index-store";
import { SemanticGraphSettings } from "./settings";

export const SEMANTIC_GRAPH_VIEW = "semantic-graph-view";

// Cluster palette — vibrant but works on dark bg
const CLUSTER_COLORS = [
  [118, 185, 0],   // NVIDIA green
  [74, 158, 255],  // blue
  [255, 107, 107], // red
  [255, 217, 61],  // yellow
  [107, 203, 119], // green
  [199, 125, 255], // purple
  [255, 159, 67],  // orange
  [72, 202, 228],  // cyan
  [247, 37, 133],  // pink
  [181, 228, 140], // lime
] as [number, number, number][];

function isJunkFilename(name: string): boolean {
  if (name.length > 60) return true;
  if (/^AA[A-Z]{2,4}[A-Za-z0-9+/]{16,}/.test(name)) return true;
  if (name.length > 32 && /^[A-Za-z0-9_\-+=]{32,}$/.test(name)) return true;
  return false;
}

interface Node {
  id: string; label: string; cluster: number;
  x: number; y: number; vx: number; vy: number;
  degree: number; r: number;
}
interface Edge { si: number; ti: number; weight: number; }

export class SemanticGraphView extends ItemView {
  private store: IndexStore;
  settings: SemanticGraphSettings;

  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private rafId: number | null = null;
  private alpha = 1.0;

  // Pan/zoom
  private tx = 0; private ty = 0; private scale = 1;
  private dragging = false;
  private dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

  // Canvas
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private W = 900; private H = 700;

  // Hover state
  private hoveredIdx = -1;
  private mouseX = 0; private mouseY = 0;

  // Status
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
      background: "#080808", position: "relative",
      overflow: "hidden", userSelect: "none", fontFamily: "sans-serif",
    });

    const entries = this.store.entries().filter(([p]) => {
      const base = p.split("/").pop()?.replace(".md", "") ?? "";
      return !isJunkFilename(base);
    });

    if (entries.length === 0) {
      const msg = container.createEl("div", { text: "No notes indexed yet. Run 'Semantic Graph: Index vault' from the command palette." });
      Object.assign(msg.style, { color: "#444", textAlign: "center", marginTop: "40vh", padding: "2rem" });
      return;
    }

    // Status overlay
    this.statusEl = container.createEl("div");
    Object.assign(this.statusEl.style, {
      position: "absolute", top: "12px", left: "16px",
      fontSize: "11px", color: "#444", zIndex: "10", pointerEvents: "none", letterSpacing: "0.03em",
    });

    // Controls
    const controls = container.createEl("div");
    Object.assign(controls.style, {
      position: "absolute", top: "8px", right: "12px",
      zIndex: "10", display: "flex", gap: "6px",
    });
    [["Reset", () => this.resetView()], ["Re-layout", () => this.reLayout()]].forEach(([label, fn]) => {
      const b = controls.createEl("button", { text: label as string });
      Object.assign(b.style, {
        background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
        color: "#555", padding: "3px 10px", borderRadius: "4px", cursor: "pointer",
        fontSize: "11px", letterSpacing: "0.03em",
      });
      b.addEventListener("click", fn as () => void);
    });

    // Canvas
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;cursor:crosshair;";
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // Size canvas
    const resize = () => {
      const r = container.getBoundingClientRect();
      this.W = r.width || 900; this.H = r.height || 700;
      canvas.width = this.W; canvas.height = this.H;
      this.draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Pointer events
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const d = e.deltaY > 0 ? 0.85 : 1.18;
      const ns = Math.max(0.05, Math.min(10, this.scale * d));
      this.tx = mx - (mx - this.tx) * (ns / this.scale);
      this.ty = my - (my - this.ty) * (ns / this.scale);
      this.scale = ns;
    }, { passive: false });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      canvas.style.cursor = "grabbing";
    });
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
      if (this.dragging) {
        this.tx = this.dragStart.tx + (e.clientX - this.dragStart.x);
        this.ty = this.dragStart.ty + (e.clientY - this.dragStart.y);
      }
      this.updateHover();
    };
    const onUp = () => {
      if (this.dragging) canvas.style.cursor = "crosshair";
      this.dragging = false;
    };
    canvas.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    canvas.addEventListener("click", (e) => {
      if (this.hoveredIdx >= 0) {
        const n = this.nodes[this.hoveredIdx];
        const file = this.app.vault.getAbstractFileByPath(n.id);
        if (file) this.app.workspace.getLeaf().openFile(file as any);
      }
    });

    this.buildGraph(entries);
    this.initLayout();
    this.startSim();
  }

  private buildGraph(entries: [string, { vector: number[]; indexedAt: number }][]) {
    const capped = entries.slice(0, this.settings.maxNotes);
    const vectors = capped.map(([, e]) => e.vector);
    const clusters = kMeansClusters(vectors, this.settings.clusterCount);
    const t = this.settings.similarityThreshold;

    const degreeMap = new Map<number, number>();
    this.edges = [];
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim >= t) {
          this.edges.push({ si: i, ti: j, weight: sim });
          degreeMap.set(i, (degreeMap.get(i) ?? 0) + 1);
          degreeMap.set(j, (degreeMap.get(j) ?? 0) + 1);
        }
      }
    }

    this.nodes = capped.map(([path], i) => {
      const deg = degreeMap.get(i) ?? 0;
      return {
        id: path,
        label: path.split("/").pop()?.replace(".md", "") ?? path,
        cluster: clusters[i],
        x: 0, y: 0, vx: 0, vy: 0,
        degree: deg,
        r: Math.max(2.5, Math.min(6, 2.5 + Math.log1p(deg) * 0.7)),
      };
    });
  }

  private initLayout() {
    const cx = this.W / 2, cy = this.H / 2;
    const r = Math.min(this.W, this.H) * 0.36;
    const k = this.settings.clusterCount;
    // Cluster centroids spread in a ring
    const centroids = Array.from({ length: k }, (_, i) => ({
      x: cx + r * 0.55 * Math.cos((2 * Math.PI * i) / k),
      y: cy + r * 0.55 * Math.sin((2 * Math.PI * i) / k),
    }));
    this.nodes.forEach((n) => {
      const c = centroids[n.cluster % k];
      n.x = c.x + (Math.random() - 0.5) * 120;
      n.y = c.y + (Math.random() - 0.5) * 120;
      n.vx = 0; n.vy = 0;
    });
    this.tx = 0; this.ty = 0; this.scale = 1;
  }

  private startSim() {
    this.stopSim();
    this.alpha = 1.0;
    const alphaDecay = 0.018;
    const velDecay = 0.35;
    const k = Math.sqrt((this.W * this.H) / Math.max(1, this.nodes.length)) * 0.9;

    const tick = () => {
      if (this.alpha < 0.002) {
        if (this.statusEl) this.statusEl.textContent =
          `${this.nodes.length} notes · ${this.edges.length} connections · ${this.settings.clusterCount} clusters`;
        this.draw();
        return;
      }
      this.alpha *= (1 - alphaDecay);
      if (this.statusEl) this.statusEl.textContent = `Laying out… α=${this.alpha.toFixed(3)}`;

      // Repulsion (sampled)
      const step = Math.max(1, Math.floor(this.nodes.length / 300));
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + step; j < this.nodes.length; j += step) {
          const a = this.nodes[i], b = this.nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const d = Math.sqrt(d2);
          const f = (k * k) / d * this.alpha * 1.8;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // Cluster cohesion — pull same-cluster nodes toward cluster centroid
      const centroids = Array.from({ length: this.settings.clusterCount }, () => ({ x: 0, y: 0, n: 0 }));
      this.nodes.forEach(n => {
        const c = centroids[n.cluster % this.settings.clusterCount];
        c.x += n.x; c.y += n.y; c.n++;
      });
      centroids.forEach(c => { if (c.n) { c.x /= c.n; c.y /= c.n; } });
      this.nodes.forEach(n => {
        const c = centroids[n.cluster % this.settings.clusterCount];
        n.vx += (c.x - n.x) * 0.02 * this.alpha;
        n.vy += (c.y - n.y) * 0.02 * this.alpha;
      });

      // Edge attraction
      this.edges.forEach(e => {
        const a = this.nodes[e.si], b = this.nodes[e.ti];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const f = (d / k) * e.weight * this.alpha * 0.6;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });

      // Centering
      let cx = 0, cy = 0;
      this.nodes.forEach(n => { cx += n.x; cy += n.y; });
      cx /= this.nodes.length; cy /= this.nodes.length;
      const cx2 = this.W / 2, cy2 = this.H / 2;
      this.nodes.forEach(n => {
        n.vx += (cx2 - cx) * 0.008;
        n.vy += (cy2 - cy) * 0.008;
      });

      // Integrate
      this.nodes.forEach(n => {
        n.vx *= velDecay; n.vy *= velDecay;
        n.x += n.vx; n.y += n.vy;
      });

      this.updateHover();
      this.draw();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopSim() {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.alpha = 0;
  }

  private worldToScreen(wx: number, wy: number): [number, number] {
    return [wx * this.scale + this.tx, wy * this.scale + this.ty];
  }
  private screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale];
  }

  private updateHover() {
    if (!this.canvas) return;
    const [wx, wy] = this.screenToWorld(this.mouseX, this.mouseY);
    let best = -1, bestD = Infinity;
    this.nodes.forEach((n, i) => {
      const dx = n.x - wx, dy = n.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const threshold = (n.r + 6) / this.scale;
      if (d < threshold && d < bestD) { best = i; bestD = d; }
    });
    if (best !== this.hoveredIdx) {
      this.hoveredIdx = best;
      this.canvas.style.cursor = best >= 0 ? "pointer" : (this.dragging ? "grabbing" : "crosshair");
    }
  }

  private draw() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    const W = this.W, H = this.H;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#080808";
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const t = this.settings.similarityThreshold;
    const hovered = this.hoveredIdx >= 0 ? this.nodes[this.hoveredIdx] : null;

    // Find connected nodes if hovered
    const connectedSet = new Set<number>();
    if (hovered) {
      this.edges.forEach(e => {
        if (e.si === this.hoveredIdx) connectedSet.add(e.ti);
        else if (e.ti === this.hoveredIdx) connectedSet.add(e.si);
      });
    }

    // Draw edges
    this.edges.forEach(e => {
      const a = this.nodes[e.si], b = this.nodes[e.ti];
      const isHighlighted = hovered && (e.si === this.hoveredIdx || e.ti === this.hoveredIdx);
      const baseAlpha = 0.06 + (e.weight - t) * 0.3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (isHighlighted) {
        const [r, g, b2] = CLUSTER_COLORS[this.nodes[this.hoveredIdx].cluster % CLUSTER_COLORS.length];
        ctx.strokeStyle = `rgba(${r},${g},${b2},0.7)`;
        ctx.lineWidth = 0.8;
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${baseAlpha})`;
        ctx.lineWidth = 0.3 + (e.weight - t) * 0.5;
      }
      ctx.stroke();
    });

    // Draw nodes
    this.nodes.forEach((n, i) => {
      const [cr, cg, cb] = CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length];
      const isHov = i === this.hoveredIdx;
      const isConnected = hovered && !isHov && connectedSet.has(i);
      const isDimmed = hovered && !isHov && !isConnected;

      const alpha = isDimmed ? 0.2 : 1.0;
      const r = isHov ? n.r * 2.2 : n.r;

      // Outer glow (large, very soft)
      if (!isDimmed) {
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 5);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${isHov ? 0.18 : 0.06})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 5, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Inner glow (medium)
      if (!isDimmed) {
        const ig = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 2.2);
        ig.addColorStop(0, `rgba(${cr},${cg},${cb},${isHov ? 0.6 : 0.3})`);
        ig.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = ig;
        ctx.fill();
      }

      // Core dot
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha * (isHov ? 1 : 0.85)})`;
      ctx.fill();

      // Bright center highlight
      if (!isDimmed) {
        ctx.beginPath();
        ctx.arc(n.x - r * 0.2, n.y - r * 0.2, r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${isHov ? 0.9 : 0.55})`;
        ctx.fill();
      }

      // Label on hover or connected
      if (isHov || isConnected) {
        const fontSize = Math.max(10, 11 / this.scale);
        ctx.font = `${fontSize}px -apple-system, sans-serif`;
        const lbl = n.label.length > 32 ? n.label.slice(0, 32) + "…" : n.label;
        const tw = ctx.measureText(lbl).width;
        const lx = n.x + r + 5, ly = n.y + fontSize * 0.35;

        // Label bg
        ctx.fillStyle = "rgba(8,8,8,0.75)";
        ctx.fillRect(lx - 2, ly - fontSize * 0.85, tw + 6, fontSize + 3);

        ctx.fillStyle = isHov
          ? `rgb(${cr},${cg},${cb})`
          : `rgba(${cr},${cg},${cb},0.7)`;
        ctx.fillText(lbl, lx, ly);
      }
    });

    ctx.restore();
  }

  private resetView() { this.tx = 0; this.ty = 0; this.scale = 1; this.draw(); }

  reLayout() {
    this.initLayout();
    this.startSim();
  }
}
