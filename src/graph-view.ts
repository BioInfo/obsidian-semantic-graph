import { ItemView, WorkspaceLeaf } from "obsidian";
import { cosineSimilarity, kMeansClusters } from "./embedder";
import { IndexStore } from "./index-store";
import { SemanticGraphSettings } from "./settings";

export const SEMANTIC_GRAPH_VIEW = "semantic-graph-view";

const CLUSTER_COLORS: [number, number, number][] = [
  [118, 185,   0],  // 0 NVIDIA green
  [ 74, 158, 255],  // 1 blue
  [255, 107, 107],  // 2 red
  [255, 217,  61],  // 3 yellow
  [107, 203, 119],  // 4 green
  [199, 125, 255],  // 5 purple
  [255, 159,  67],  // 6 orange
  [ 72, 202, 228],  // 7 cyan
  [247,  37, 133],  // 8 pink
  [181, 228, 140],  // 9 lime
];

function isJunkFilename(name: string): boolean {
  if (name.length > 60) return true;
  if (/^AA[A-Z]{2,4}[A-Za-z0-9+/]{16,}/.test(name)) return true;
  if (name.length > 32 && /^[A-Za-z0-9_\-+=]{32,}$/.test(name)) return true;
  return false;
}

interface Node {
  id: string; label: string; folder: string; cluster: number;
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
  private dragMoved = false;
  private dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

  // Marquee zoom (Shift+drag)
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private marqueeActive = false;

  // Canvas
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private W = 900; private H = 700;
  private dpr = 1;

  // Hover / tooltip
  private hoveredIdx = -1;
  private mouseX = 0; private mouseY = 0;
  private tooltipEl: HTMLElement | null = null;

  // Status
  private statusEl: HTMLElement | null = null;
  private container: HTMLElement | null = null;

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
    this.container = container;
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
      const msg = container.createEl("div", {
        text: "No notes indexed yet. Run 'Semantic Graph: Index vault' from the command palette.",
      });
      Object.assign(msg.style, {
        color: "#555", textAlign: "center", marginTop: "40vh",
        padding: "2rem", fontSize: "14px",
      });
      return;
    }

    // ── Status bar ─────────────────────────────────────────────────────
    this.statusEl = container.createEl("div");
    Object.assign(this.statusEl.style, {
      position: "absolute", top: "12px", left: "16px",
      fontSize: "11px", color: "#555", zIndex: "10",
      pointerEvents: "none", letterSpacing: "0.04em",
    });

    // ── Controls (top-right) ────────────────────────────────────────────
    const controls = container.createEl("div");
    Object.assign(controls.style, {
      position: "absolute", top: "10px", right: "12px",
      zIndex: "10", display: "flex", gap: "4px", alignItems: "center",
    });
    const btn = (label: string, title: string, fn: () => void) => {
      const b = controls.createEl("button", { text: label, title });
      Object.assign(b.style, {
        background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
        color: "#666", padding: "2px 9px", borderRadius: "4px", cursor: "pointer",
        fontSize: "13px", lineHeight: "20px", minWidth: "28px",
      });
      b.addEventListener("click", fn);
    };
    btn("+", "Zoom in", () => this.zoom(1.3));
    btn("−", "Zoom out", () => this.zoom(0.77));
    btn("⊡", "Fit to view", () => this.fitToView());
    btn("↺", "Re-layout", () => this.reLayout());

    // ── Tooltip ─────────────────────────────────────────────────────────
    this.tooltipEl = container.createEl("div");
    Object.assign(this.tooltipEl.style, {
      position: "absolute", pointerEvents: "none", zIndex: "20",
      background: "rgba(13,13,13,0.92)", border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: "6px", padding: "7px 11px", fontSize: "12px",
      color: "#e0e0e0", display: "none", maxWidth: "260px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.6)", lineHeight: "1.5",
    });

    // ── Legend (bottom-left) ────────────────────────────────────────────
    const legend = container.createEl("div");
    Object.assign(legend.style, {
      position: "absolute", bottom: "12px", left: "14px",
      zIndex: "10", display: "flex", flexWrap: "wrap", gap: "6px",
      maxWidth: "260px", pointerEvents: "none",
    });

    // ── Canvas ──────────────────────────────────────────────────────────
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;position:absolute;top:0;left:0;";
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    const resize = () => {
      const r = container.getBoundingClientRect();
      this.W = r.width || 900; this.H = r.height || 700;
      this.dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(this.W * this.dpr);
      canvas.height = Math.round(this.H * this.dpr);
      canvas.style.width = this.W + "px"; canvas.style.height = this.H + "px";
      this.ctx = canvas.getContext("2d");
      if (this.ctx) this.ctx.scale(this.dpr, this.dpr);
      this.draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // ── Mouse events ────────────────────────────────────────────────────
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const r = canvas.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }, { passive: false });

    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      this.dragMoved = false;

      if (e.shiftKey) {
        // Marquee zoom mode
        this.marqueeActive = true;
        this.marquee = { x0: cx, y0: cy, x1: cx, y1: cy };
        canvas.style.cursor = "crosshair";
      } else {
        // Pan mode
        this.dragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        canvas.style.cursor = "grabbing";
      }
    });

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;

      if (this.marqueeActive && this.marquee) {
        this.marquee.x1 = this.mouseX;
        this.marquee.y1 = this.mouseY;
        this.dragMoved = true;
        this.draw(); // redraw with marquee overlay
        return;
      }

      if (this.dragging) {
        const dx = e.clientX - this.dragStart.x, dy = e.clientY - this.dragStart.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
        this.tx = this.dragStart.tx + dx;
        this.ty = this.dragStart.ty + dy;
        this.draw(); // ← was missing: redraw on pan
      }

      this.updateHover();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", (e) => {
      if (this.marqueeActive && this.marquee && this.dragMoved) {
        this.zoomToMarquee(this.marquee);
      }
      this.marqueeActive = false;
      this.marquee = null;
      this.dragging = false;
      if (this.canvas) this.canvas.style.cursor = this.hoveredIdx >= 0 ? "pointer" : "default";
      this.draw();
    });

    canvas.addEventListener("dblclick", () => this.fitToView(true));

    canvas.addEventListener("click", () => {
      if (this.dragMoved) return;
      if (this.hoveredIdx >= 0) {
        const n = this.nodes[this.hoveredIdx];
        const file = this.app.vault.getAbstractFileByPath(n.id);
        if (file) this.app.workspace.getLeaf().openFile(file as any);
      }
    });

    // Build data + start
    this.buildGraph(entries);

    // Build legend after clusters are known
    const seen = new Set<number>();
    this.nodes.forEach(n => seen.add(n.cluster));
    [...seen].sort((a, b) => a - b).forEach(ci => {
      const [r, g, b] = CLUSTER_COLORS[ci % CLUSTER_COLORS.length];
      const dot = legend.createEl("div");
      Object.assign(dot.style, {
        display: "flex", alignItems: "center", gap: "4px",
        fontSize: "10px", color: "#555",
      });
      const sq = dot.createEl("span");
      Object.assign(sq.style, {
        width: "8px", height: "8px", borderRadius: "50%", flexShrink: "0",
        background: `rgb(${r},${g},${b})`,
        boxShadow: `0 0 6px rgba(${r},${g},${b},0.6)`,
      });
      dot.createEl("span", { text: `cluster ${ci + 1}` });
    });

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
      const parts = path.split("/");
      const label = parts.pop()?.replace(".md", "") ?? path;
      const folder = parts.join("/") || "/";
      const deg = degreeMap.get(i) ?? 0;
      return {
        id: path, label, folder, cluster: clusters[i],
        x: 0, y: 0, vx: 0, vy: 0,
        degree: deg,
        r: Math.max(3.5, Math.min(8, 3.5 + Math.log1p(deg) * 0.9)),
      };
    });
  }

  private initLayout() {
    const cx = this.W / 2, cy = this.H / 2;
    const r = Math.min(this.W, this.H) * 0.36;
    const k = this.settings.clusterCount;
    const centroids = Array.from({ length: k }, (_, i) => ({
      x: cx + r * 0.55 * Math.cos((2 * Math.PI * i) / k),
      y: cy + r * 0.55 * Math.sin((2 * Math.PI * i) / k),
    }));
    this.nodes.forEach((n) => {
      const c = centroids[n.cluster % k];
      n.x = c.x + (Math.random() - 0.5) * 100;
      n.y = c.y + (Math.random() - 0.5) * 100;
      n.vx = 0; n.vy = 0;
    });
    this.tx = 0; this.ty = 0; this.scale = 1;
  }

  // ── Force simulation ───────────────────────────────────────────────────
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
        this.fitToView(true);  // auto-fit when layout settles
        this.draw();
        return;
      }
      this.alpha *= (1 - alphaDecay);
      if (this.statusEl) this.statusEl.textContent =
        `Laying out… (${this.nodes.length} notes)`;

      // Repulsion
      const step = Math.max(1, Math.floor(this.nodes.length / 300));
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + step; j < this.nodes.length; j += step) {
          const a = this.nodes[i], b = this.nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
          const f = (k * k) / d * this.alpha * 1.8;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // Cluster cohesion
      const centroids = Array.from({ length: this.settings.clusterCount }, () => ({ x: 0, y: 0, n: 0 }));
      this.nodes.forEach(n => {
        const c = centroids[n.cluster % this.settings.clusterCount];
        c.x += n.x; c.y += n.y; c.n++;
      });
      centroids.forEach(c => { if (c.n) { c.x /= c.n; c.y /= c.n; } });
      this.nodes.forEach(n => {
        const c = centroids[n.cluster % this.settings.clusterCount];
        n.vx += (c.x - n.x) * 0.025 * this.alpha;
        n.vy += (c.y - n.y) * 0.025 * this.alpha;
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
      this.nodes.forEach(n => {
        n.vx += (this.W / 2 - cx) * 0.008;
        n.vy += (this.H / 2 - cy) * 0.008;
      });

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

  // ── Zoom helpers ───────────────────────────────────────────────────────
  private zoom(factor: number) {
    this.zoomAt(this.W / 2, this.H / 2, factor);
  }

  private zoomAt(screenX: number, screenY: number, factor: number) {
    const ns = Math.max(0.05, Math.min(12, this.scale * factor));
    this.tx = screenX - (screenX - this.tx) * (ns / this.scale);
    this.ty = screenY - (screenY - this.ty) * (ns / this.scale);
    this.scale = ns;
    this.updateHover();
    this.draw();
  }

  /** Fit all nodes into view with padding. animated=true for smooth transition. */
  fitToView(animated = false) {
    if (this.nodes.length === 0) return;
    const PAD = 60;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.nodes.forEach(n => {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    });
    const gW = maxX - minX, gH = maxY - minY;
    if (gW === 0 || gH === 0) return;
    const targetScale = Math.min(
      (this.W - PAD * 2) / gW,
      (this.H - PAD * 2) / gH,
      1.5  // don't over-zoom for small graphs
    );
    const targetTx = (this.W - gW * targetScale) / 2 - minX * targetScale;
    const targetTy = (this.H - gH * targetScale) / 2 - minY * targetScale;

    if (!animated) {
      this.scale = targetScale; this.tx = targetTx; this.ty = targetTy;
      this.draw();
      return;
    }

    // Smooth 400ms ease-out animation
    const startScale = this.scale, startTx = this.tx, startTy = this.ty;
    const duration = 400;
    const start = performance.now();
    const animate = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.scale = startScale + (targetScale - startScale) * ease;
      this.tx = startTx + (targetTx - startTx) * ease;
      this.ty = startTy + (targetTy - startTy) * ease;
      this.draw();
      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  reLayout() { this.initLayout(); this.startSim(); }

  private zoomToMarquee(m: { x0: number; y0: number; x1: number; y1: number }) {
    const sx = Math.min(m.x0, m.x1), sy = Math.min(m.y0, m.y1);
    const ex = Math.max(m.x0, m.x1), ey = Math.max(m.y0, m.y1);
    const sw = ex - sx, sh = ey - sy;
    if (sw < 10 || sh < 10) return; // too small
    // Convert screen rect to world rect
    const wx0 = (sx - this.tx) / this.scale, wy0 = (sy - this.ty) / this.scale;
    const wx1 = (ex - this.tx) / this.scale, wy1 = (ey - this.ty) / this.scale;
    const gW = wx1 - wx0, gH = wy1 - wy0;
    const PAD = 20;
    const targetScale = Math.min(
      (this.W - PAD * 2) / gW,
      (this.H - PAD * 2) / gH,
      12
    );
    const targetTx = (this.W - gW * targetScale) / 2 - wx0 * targetScale;
    const targetTy = (this.H - gH * targetScale) / 2 - wy0 * targetScale;

    // Animate
    const startScale = this.scale, startTx = this.tx, startTy = this.ty;
    const start = performance.now();
    const animate = (now: number) => {
      const t = Math.min(1, (now - start) / 350);
      const ease = 1 - Math.pow(1 - t, 3);
      this.scale = startScale + (targetScale - startScale) * ease;
      this.tx = startTx + (targetTx - startTx) * ease;
      this.ty = startTy + (targetTy - startTy) * ease;
      this.draw();
      if (t < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  // ── Hover ──────────────────────────────────────────────────────────────
  private updateHover() {
    if (!this.canvas) return;
    // Convert screen → world
    const wx = (this.mouseX - this.tx) / this.scale;
    const wy = (this.mouseY - this.ty) / this.scale;

    let best = -1, bestD = Infinity;
    this.nodes.forEach((n, i) => {
      const dx = n.x - wx, dy = n.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const hit = (n.r + 8) / this.scale;
      if (d < hit && d < bestD) { best = i; bestD = d; }
    });

    if (best !== this.hoveredIdx) {
      this.hoveredIdx = best;
      this.canvas.style.cursor = best >= 0 ? "pointer" : (this.dragging ? "grabbing" : "default");
    }

    // Tooltip
    if (this.tooltipEl) {
      if (best >= 0) {
        const n = this.nodes[best];
        const [cr, cg, cb] = CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length];
        this.tooltipEl.innerHTML =
          `<div style="font-weight:600;color:#f0f0f0;margin-bottom:3px">${n.label}</div>` +
          `<div style="color:#666;font-size:10px;margin-bottom:4px">${n.folder}</div>` +
          `<div style="display:flex;gap:10px;font-size:10px;color:#888">` +
          `<span style="color:rgb(${cr},${cg},${cb})">● cluster ${n.cluster + 1}</span>` +
          `<span>${n.degree} connections</span></div>`;
        // Position: follow cursor with smart edge avoidance
        const TW = 200, TH = 72;
        let lx = this.mouseX + 14, ly = this.mouseY - 10;
        if (lx + TW > this.W - 10) lx = this.mouseX - TW - 14;
        if (ly + TH > this.H - 10) ly = this.mouseY - TH - 10;
        if (ly < 10) ly = 10;
        this.tooltipEl.style.left = lx + "px";
        this.tooltipEl.style.top = ly + "px";
        this.tooltipEl.style.display = "block";
      } else {
        this.tooltipEl.style.display = "none";
      }
    }

    // Only redraw if hover changed
    if (best !== this.hoveredIdx) this.draw();
  }

  // ── Draw ───────────────────────────────────────────────────────────────
  private draw() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    ctx.clearRect(0, 0, this.W, this.H);
    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, this.W, this.H);

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const t = this.settings.similarityThreshold;
    const hi = this.hoveredIdx;
    const connSet = new Set<number>();
    if (hi >= 0) this.edges.forEach(e => {
      if (e.si === hi) connSet.add(e.ti);
      else if (e.ti === hi) connSet.add(e.si);
    });

    // ── Edges ──
    this.edges.forEach(e => {
      const a = this.nodes[e.si], b = this.nodes[e.ti];
      const isHi = hi >= 0 && (e.si === hi || e.ti === hi);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (isHi) {
        const [r, g, bl] = CLUSTER_COLORS[this.nodes[hi].cluster % CLUSTER_COLORS.length];
        ctx.strokeStyle = `rgba(${r},${g},${bl},0.85)`;
        ctx.lineWidth = 1.2;
      } else if (hi >= 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.03)";
        ctx.lineWidth = 0.3;
      } else {
        const a2 = 0.12 + (e.weight - t) * 0.5;
        ctx.strokeStyle = `rgba(200,200,200,${a2})`;
        ctx.lineWidth = 0.5 + (e.weight - t) * 0.8;
      }
      ctx.stroke();
    });

    // ── Nodes ──
    this.nodes.forEach((n, i) => {
      const [cr, cg, cb] = CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length];
      const isHov = i === hi;
      const isConn = hi >= 0 && !isHov && connSet.has(i);
      const isDim = hi >= 0 && !isHov && !isConn;

      const r = isHov ? n.r * 2.2 : n.r;

      if (!isDim) {
        // Outer glow
        const og = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 6);
        og.addColorStop(0, `rgba(${cr},${cg},${cb},${isHov ? 0.3 : 0.15})`);
        og.addColorStop(0.5, `rgba(${cr},${cg},${cb},${isHov ? 0.1 : 0.05})`);
        og.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 6, 0, Math.PI * 2);
        ctx.fillStyle = og; ctx.fill();

        // Inner bloom
        const ig = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 2.5);
        ig.addColorStop(0, `rgba(${cr},${cg},${cb},${isHov ? 0.8 : 0.55})`);
        ig.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = ig; ctx.fill();
      }

      // Core
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isDim
        ? `rgba(${cr},${cg},${cb},0.18)`
        : `rgb(${cr},${cg},${cb})`;
      ctx.fill();

      // Specular
      if (!isDim) {
        ctx.beginPath();
        ctx.arc(n.x - r * 0.25, n.y - r * 0.25, r * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${isHov ? 0.9 : 0.65})`;
        ctx.fill();
      }
    });

    ctx.restore();

    // Marquee overlay (drawn in screen space, after restore)
    if (this.marqueeActive && this.marquee) {
      const { x0, y0, x1, y1 } = this.marquee;
      const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
      ctx.save();
      ctx.strokeStyle = "rgba(118, 185, 0, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillStyle = "rgba(118, 185, 0, 0.07)";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.restore();
    }
  }
}
