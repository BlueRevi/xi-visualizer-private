// src/overlay/spawnAutoload.ts
import * as THREE from "three";

export type SpawnRow = {
  id: number;
  group: number;
  internal_name?: string;
  name?: string;
  family_id?: number;       // may be absent
  min_level?: number;
  max_level?: number;
  x: number; y: number; z: number;
  heading?: number;
};

type Deps = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
};

const GROUP_NAME = "__xi_spawn_markers__";
const RADIUS = 1.7; // geometry is created at this radius (used as "Large" preset)
const FLIP_Z = false; // set true only if dots look mirrored
const TIP_ID = "__spawn_tip__";

// ---- Size presets (world radius) ----
const SIZE_PRESETS = {
  small: 0.85,
  medium: 1.2,
  large: 1.7,
} as const;
type SizeKey = keyof typeof SIZE_PRESETS;

// ---- Screen-space pixel targets per preset (used when Auto-scale is ON) ----
const PRESET_PIXEL_TARGET: Record<SizeKey, number> = {
  small: 8,     // ~8px visual radius
  medium: 12,   // ~12px
  large: 16,    // ~16px
};

// ---- Outline ----
const OUTLINE_SCALE = 1.12; // outline mesh scale factor (~8% larger than the dot)

/* Derive a readable "type" (splits Yagudo by role and normalizes some families) */
function mobType(p: SpawnRow): string {
  const iname = (p.internal_name || "").trim();
  const name  = (p.name || "").trim();

  if (/^Yagudo_/i.test(iname)) {
    const role = iname.split("_").slice(1).join("_").replace(/_/g, " ");
    return ("Yagudo " + role).trim();
  }
  if (/^Yagudo\s/i.test(name)) return name;

  if (/^Yagudo'?s Elemental$/i.test(name) || /^Yagudo'?s_Elemental$/i.test(iname))
    return "Elemental (Yagudo)";

  const s = (iname || name).toLowerCase();
  if (s.includes("giant_pugil") || s.includes("giant pugil")) return "Giant Pugil";
  if (s.includes("pugil")) return "Pugil";
  if (s.includes("bee")) return "Bee";
  if (s.includes("wasp")) return "Wasp";
  if (s.includes("earth_eater") || s.includes("earth eater")) return "Earth Eater";
  if (s.includes("dirt_eater")  || s.includes("dirt eater"))  return "Dirt Eater";
  if (s.includes("elemental")) return "Elemental";

  const base = iname.split("_")[0];
  return base || name || "Unknown";
}

/**
 * Stable color per label.
 * NOTE: If colors look too dark, bump lightness from 0.10 -> ~0.60
 * e.g. c.setHSL(hue/360, 0.95, 0.60)
 */
function hashColor(label: string): number {
  let h = 0; for (let i = 0; i < label.length; i++) h = (h*31 + label.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  const c = new THREE.Color(); c.setHSL(hue/360, 0.95, 0.10);
  return c.getHex();
}

export class SpawnAutoload {
  private deps: Deps;
  private group?: THREE.Group;
  private rows: SpawnRow[] = [];
  private types = new Map<string, number>();        // type -> count
  private families = new Map<number, number>();     // family_id -> count
  private mats  = new Map<string, THREE.MeshBasicMaterial>();

  // ---- UI panel state ----
  private panelEl?: HTMLDivElement;
  private PANEL_ID = "__spawn_filter__panel";

  // ---- Tooltip state ----
  private tipEl?: HTMLDivElement;
  private ray = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // ---- Size + Auto-scale state ----
  private currentSize: SizeKey = "large"; // default base size preset
  private autoScaleEnabled = false;       // OFF by default (you said presets feel good)
  private rafId?: number;                 // requestAnimationFrame handle for loop

  // ---- Outline material (shared) ----
  private outlineMat?: THREE.MeshBasicMaterial;

  constructor(deps: Deps) {
    this.deps = deps;
    // Expose BASE_URL for console debugging (works in dev and on sub-path builds)
    if (!(window as any).__BASE_URL__) {
      (window as any).__BASE_URL__ = import.meta.env.BASE_URL || "/";
    }
  }

  /** Load JSON for zoneId, build markers, expose console API, build panel + tooltip. */
  async load(zoneId: number) {
    this.destroy(); // remove any previous layer

    // Build an absolute base and URL robustly (works with sub-path bases like /xi-visualizer/)
    const base = (window as any).__BASE_URL__ as string || "/";
    const absBase = new URL(base, window.location.origin).toString(); // http://host/base/
    const url = new URL(`spawns/${zoneId}.json`, absBase).toString();
    console.debug("[spawns] fetching", url);

    // 1) Network request with no-store to avoid cache confusion
    let res: Response;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (e) {
      console.error("[spawns] network error for", url, e);
      return;
    }

    // 2) If not 2xx, stop (404 typically means SPA fallback)
    if (!res.ok) {
      console.warn("[spawns] HTTP", res.status, "for", url);
      return;
    }

    // 3) Validate Content-Type (avoid '<!DOCTYPE...' parse errors)
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const sample = (await res.text()).slice(0, 200);
      console.error("[spawns] expected JSON, got", ct || "unknown", "from", url, "sample:", sample);
      return;
    }

    // 4) Parse JSON safely
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (e) {
      console.error("[spawns] json parse error for", url, e);
      return;
    }

    // 5) Accept either an array or { spawns: [...] }
    const spawns = Array.isArray(raw) ? (raw as SpawnRow[]) :
                   (raw && typeof raw === "object" && Array.isArray((raw as any).spawns))
                     ? ((raw as any).spawns as SpawnRow[]) : [];

    if (!spawns.length) {
      console.warn("[spawns] empty or incompatible JSON at", url);
      return;
    }

    // ---------- Build markers ----------
    this.rows = spawns;
    this.types.clear();
    this.families.clear();

    const geo = new THREE.SphereGeometry(RADIUS, 12, 12);
    const group = new THREE.Group(); group.name = GROUP_NAME;
    this.deps.scene.add(group);
    this.group = group;

    for (const p of spawns) {
      const t  = mobType(p);
      const m  = this.matFor(t);

      // Base dot mesh
      const s  = new THREE.Mesh(geo, m);

      // Add a thin black outline (scaled backface mesh)
      const outline = new THREE.Mesh(geo, this.getOutlineMaterial());
      outline.scale.setScalar(OUTLINE_SCALE);
      s.add(outline);

      // Position + userData
      const X  = p.x, Y = p.y, Z = FLIP_Z ? -p.z : p.z;
      s.position.set(X, Y, Z);
      (s as any).userData = { ...p, type: t };

      group.add(s);

      this.types.set(t, (this.types.get(t) || 0) + 1);
      if (typeof p.family_id === "number") {
        this.families.set(p.family_id, (this.families.get(p.family_id) || 0) + 1);
      }
    }

    // Start hidden by default (no dots until user selects types)
    this.group.visible = false;

    // ---------- Console API ----------
    (window as any).__spawns = {
      baseUrl : base,
      group   : this.group,
      rows    : this.rows,
      types   : new Map(this.types),
      families: new Map(this.families),

      // ---- filtering helpers ----
      showAll : () => this.setVisibleBy(() => true, /*forceShowGroup*/true),
      hideAll : () => { if (this.group) { this.group.visible = false; this.setVisibleBy(() => false); } },

      /** Show only these types (string or array). */
      onlyTypes: (t: string | string[]) => {
        const set = new Set(Array.isArray(t) ? t : [t]);
        this.setVisibleBy(d => set.has((d as any).type), /*forceShowGroup*/true);
      },

      /** Show only these family IDs (number or array). */
      onlyFamilies: (fam: number | number[]) => {
        const set = new Set(Array.isArray(fam) ? fam : [fam]);
        this.setVisibleBy(d => set.has((d as any).family_id), /*forceShowGroup*/true);
      },

      /** Show only mobs with min/max level overlapping [min,max]. */
      levelRange: (min: number, max: number) => {
        this.setVisibleBy(d => {
          const mn = (d as any).min_level ?? (d as any).max_level ?? -9999;
          const mx = (d as any).max_level ?? (d as any).min_level ??  9999;
          return mx >= min && mn <= max; // overlap check
        }, /*forceShowGroup*/true);
      },

      /** Name contains substring (case-insensitive). */
      nameContains: (q: string) => {
        const ql = q.toLowerCase();
        this.setVisibleBy(d => {
          const nm = ((d as any).name || (d as any).internal_name || "").toLowerCase();
          return nm.includes(ql);
        }, /*forceShowGroup*/true);
      },

      /** Combined filter in one call. All criteria are ANDed. */
      filter: (opts: {
        types?: string[];
        families?: number[];
        name?: string;
        minLevel?: number;
        maxLevel?: number;
      }) => {
        const ty = opts?.types ? new Set(opts.types) : undefined;
        const fa = opts?.families ? new Set(opts.families) : undefined;
        const ql = opts?.name ? opts.name.toLowerCase() : undefined;
        const lvMin = opts?.minLevel;
        const lvMax = opts?.maxLevel;

        this.setVisibleBy(d => {
          const dd: any = d;
          if (ty && !ty.has(dd.type)) return false;
          if (fa && !fa.has(dd.family_id)) return false;

          if (ql) {
            const nm = (dd.name || dd.internal_name || "").toLowerCase();
            if (!nm.includes(ql)) return false;
          }

          if (lvMin !== undefined || lvMax !== undefined) {
            const mn = dd.min_level ?? dd.max_level ?? -9999;
            const mx = dd.max_level ?? dd.min_level ??  9999;
            const a = lvMin ?? -9999;
            const b = lvMax ??  9999;
            if (!(mx >= a && mn <= b)) return false;
          }
          return true;
        }, /*forceShowGroup*/true);
      },

      // ---- utilities ----
      focus : () => this.focusVisible(),
      countVisible : () => this.countVisible(),
      reload : (z?: number) => this.load(z ?? zoneId),
      remove : () => this.destroy()
    };

    console.log(`[spawns] ready: zone ${zoneId}, markers: ${group.children.length}. Console API: __spawns`);

    // ---------- UI panel + tooltip ----------
    this.buildFilterPanel();   // builds panel, defaults all unchecked, calls applyPanelFilters()
    this.installTooltip();     // hover info

    // ---------- Initialize sizes / loop ----------
    if (this.autoScaleEnabled) {
      this.updateAutoScaleOnce(); // compute initial screen-space sizes
      this.startAutoScaleLoop();
    } else {
      this.applyFixedScale();     // snap to preset base
    }
  }

  destroy() {
    // cancel auto-scale loop
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }

    // remove the filter panel first
    if (this.panelEl) { this.panelEl.remove(); this.panelEl = undefined; }

    // remove tooltip + listener
    if (this.tipEl) { this.tipEl.remove(); this.tipEl = undefined; }
    this.deps.renderer.domElement.removeEventListener("mousemove", this.onMouseMove);

    const g = this.group;
    if (!g) return;
    this.deps.scene.remove(g);
    g.clear();
    this.group = undefined;
  }

  // ---- helpers ----
  private matFor(t: string) {
    if (this.mats.has(t)) return this.mats.get(t)!;
    const m = new THREE.MeshBasicMaterial({ color: hashColor(t), toneMapped: false });
    this.mats.set(t, m); return m;
  }

  private getOutlineMaterial(): THREE.MeshBasicMaterial {
    if (!this.outlineMat) {
      this.outlineMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        side: THREE.BackSide,    // backfaces form a silhouette when slightly scaled up
        transparent: true,
        opacity: 0.9,            // crisp, thin outline
        depthWrite: false,       // don't affect depth buffer
        toneMapped: false,
      });
    }
    return this.outlineMat;
  }

  private setVisibleBy(fn: (ud: unknown) => boolean, forceShowGroup?: boolean) {
    if (!this.group) return;
    let any = false;
    for (const ch of this.group.children) {
      const d = (ch as any).userData;
      const vis = !!fn(d);
      (ch as any).visible = vis;
      if (vis) any = true;
    }
    // If caller explicitly wants to surface the layer, honor it; else auto-toggle by result
    this.group.visible = !!(forceShowGroup ? true : any);

    // Keep sizes consistent when toggling visibility
    if (!this.autoScaleEnabled) {
      this.applyFixedScale();
    } else {
      this.updateAutoScaleOnce();
    }
  }

  private countVisible() {
    if (!this.group) return 0;
    return this.group.children.reduce((n, ch) => n + ((ch as any).visible ? 1 : 0), 0);
  }

  private focusVisible() {
    if (!this.group) return;
    const tmp = new THREE.Group();
    this.group.children.forEach(ch => { if ((ch as any).visible) tmp.add(ch.clone()); });
    if (tmp.children.length === 0) return;

    const box = new THREE.Box3().setFromObject(tmp);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.deps.camera.fov * (Math.PI/180);
    const dist = Math.abs(maxDim/2/Math.tan(fov/2)) * 1.2;
    const dir  = new THREE.Vector3();
    this.deps.camera.getWorldDirection(dir);
    this.deps.camera.position.copy(center).addScaledVector(dir, -dist);
    this.deps.camera.lookAt(center);
  }

  /** Build / rebuild the floating filter panel (checkbox list + search + size + autoscale). */
  private buildFilterPanel() {
    // Remove any previous panel
    const old = document.getElementById(this.PANEL_ID);
    if (old) old.remove();

    // No group = nothing to filter
    if (!this.group) return;

    // Panel container
    const panel = document.createElement("div");
    panel.id = this.PANEL_ID;
    panel.style.cssText = [
      "position:fixed",
      "left:50px",
      "top:200px",
      "z-index:999999",
      "background:rgba(0,0,0,.65)",
      "color:#fff",
      "padding:10px",
      "border-radius:8px",
      "font:12px/1.35 system-ui,Segoe UI,Roboto,Helvetica,Arial",
      "box-shadow:0 2px 8px rgba(0,0,0,.35)",
      "min-width:280px",
      "max-width:360px"
    ].join(";");
    panel.innerHTML = '<div style="font-weight:700;margin-bottom:6px">Spawn Filter</div>';

    // 1) Checkboxes (one per type)
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto;margin-bottom:8px";
    const types = [...this.types.keys()].sort((a,b)=>a.localeCompare(b));

    types.forEach(t => {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer";

      const sw = document.createElement("span");
      const colorObj = this.mats.get(t)?.color;
      const hex = (colorObj ? colorObj.getHexString() : "999999");
      sw.style.cssText = `width:14px;height:14px;border-radius:3px;border:1px solid rgba(255,255,255,.35);display:inline-block;background:#${hex}`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = false;              // default OFF (layer starts hidden)
      cb.dataset["type"] = t;          // data-type="..."
      cb.addEventListener("change", () => this.applyPanelFilters());

      const label = document.createElement("span");
      label.textContent = `${t} (${this.types.get(t) || 0})`;

      row.appendChild(sw);
      row.appendChild(cb);
      row.appendChild(label);
      list.appendChild(row);
    });

    // 2) Name search
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Name contains…";
    search.style.cssText = "width:100%;margin:6px 0;background:#111;color:#fff;border:1px solid #555;border-radius:4px;padding:4px";
    search.addEventListener("input", () => this.applyPanelFilters());

    // 2.5) Size preset radios
    const sizeWrap = document.createElement("div");
    sizeWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:6px 0 4px 0";

    const sizeTitle = document.createElement("div");
    sizeTitle.textContent = "Marker size";
    sizeTitle.style.cssText = "opacity:.9;font-weight:600";

    const sizeRow = document.createElement("div");
    sizeRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap";

    const mkSizeRadio = (key: SizeKey, label: string) => {
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "__spawn_size";
      input.value = key;
      input.checked = (this.currentSize === key);
      input.addEventListener("change", () => {
        if (input.checked) {
          this.currentSize = key as SizeKey;
          if (this.autoScaleEnabled) {
            this.updateAutoScaleOnce(); // recompute based on new pixel target
          } else {
            this.applyFixedScale();     // snap to preset base size
          }
        }
      });

      const text = document.createElement("span");
      text.textContent = label;

      wrap.appendChild(input);
      wrap.appendChild(text);
      return wrap;
    };

    sizeRow.appendChild(mkSizeRadio("small",  "Small"));
    sizeRow.appendChild(mkSizeRadio("medium", "Medium"));
    sizeRow.appendChild(mkSizeRadio("large",  "Large"));

    sizeWrap.appendChild(sizeTitle);
    sizeWrap.appendChild(sizeRow);

    // 2.6) Auto scale toggle (screen-space)
    const autoWrap = document.createElement("label");
    autoWrap.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0;cursor:pointer";

    const autoCb = document.createElement("input");
    autoCb.type = "checkbox";
    autoCb.checked = this.autoScaleEnabled;
    autoCb.addEventListener("change", () => {
      this.autoScaleEnabled = autoCb.checked;
      if (this.autoScaleEnabled) {
        this.updateAutoScaleOnce();
        this.startAutoScaleLoop();
      } else {
        this.applyFixedScale();
      }
    });

    const autoLbl = document.createElement("span");
    autoLbl.textContent = "Auto scale with zoom";

    autoWrap.appendChild(autoCb);
    autoWrap.appendChild(autoLbl);

    // 3) Buttons: All / None / Re‑frame
    const btnBar = document.createElement("div");
    btnBar.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:4px";
    const mkBtn = (text: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = "background:#2d6cdf;color:#fff;border:0;border-radius:4px;padding:4px 8px;cursor:pointer";
      b.onclick = onClick; return b;
    };

    const SEL = 'input[type="checkbox"][data-type]';

    const btnAll   = mkBtn("All",  () => {
      list.querySelectorAll<HTMLInputElement>(SEL).forEach(el => el.checked = true);
      this.applyPanelFilters();
    });
    const btnNone  = mkBtn("None", () => {
      list.querySelectorAll<HTMLInputElement>(SEL).forEach(el => el.checked = false);
      this.applyPanelFilters();
    });
    const btnFocus = mkBtn("Re‑frame", () => this.focusVisible());
    btnBar.append(btnAll, btnNone, btnFocus);

    panel.appendChild(list);
    panel.appendChild(search);
    panel.appendChild(sizeWrap);
    panel.appendChild(autoWrap);
    panel.appendChild(btnBar);
    document.body.appendChild(panel);

    this.panelEl = panel;        // keep a handle to the live panel
    this.applyPanelFilters();    // sync initial state (keeps group hidden)
  }

  /** Read panel values and apply visibility (AND with name search). */
  private applyPanelFilters() {
    if (!this.group) return;

    // Always target the current panel we created
    const panel = this.panelEl ?? (document.getElementById(this.PANEL_ID) as HTMLDivElement | null);
    if (!panel) return;

    const SEL = 'input[type="checkbox"][data-type]';

    // Gather selection
    const boxes = panel.querySelectorAll<HTMLInputElement>(SEL);
    const selected = new Set<string>();
    boxes.forEach(el => { if (el.checked) selected.add(el.dataset.type!); });

    // 0 selected ⇒ group hidden (hard off); >0 ⇒ group visible
    const allowAny = selected.size > 0;
    this.group.visible = allowAny;

    // Name query (case-insensitive)
    const qInput = panel.querySelector<HTMLInputElement>("input[type='text']");
    const q = (qInput?.value || "").trim().toLowerCase();

    // Apply to markers (only if we allow any types; otherwise all off)
    if (!allowAny) {
      for (const ch of this.group.children) (ch as any).visible = false;
      return;
    }

    for (const ch of this.group.children) {
      const d: any = (ch as any).userData || {};
      const ty = d.type as string | undefined;

      let vis = !!ty && selected.has(ty);

      if (q) {
        const nm = (d.name || d.internal_name || "").toLowerCase();
        vis = vis && nm.includes(q);
      }

      (ch as any).visible = vis;
    }

    // Keep sizes consistent as visibility changes
    if (!this.autoScaleEnabled) {
      this.applyFixedScale();
    } else {
      this.updateAutoScaleOnce();
    }
  }

  // ---------- Size logic ----------
  /** Base scale derived from preset and geometry radius (used when auto-scale is OFF). */
  private getBaseScale(): number {
    // geometry created at RADIUS; preset is desired world radius
    return SIZE_PRESETS[this.currentSize] / RADIUS;
    // e.g., Large => 1.7/1.7 = 1.0; Small => 0.85/1.7 = 0.5; Medium => 1.2/1.7 ≈ 0.706
  }

  /** When auto-scale is off, normalize all markers to base preset size. */
  private applyFixedScale() {
    if (!this.group) return;
    const base = this.getBaseScale();
    for (const ch of this.group.children) {
      (ch as THREE.Mesh).scale.setScalar(base);
    }
  }

  // ---------- Screen-space auto-scale logic ----------
  /**
   * Compute a scale factor so the sphere projects to ~targetPx radius on screen.
   * Uses perspective projection math: world_radius = px * depth * 2*tan(fov/2) / canvas_height
   */
  private scaleForScreenPixels(targetPx: number, worldPos: THREE.Vector3): number {
    const { camera, renderer } = this.deps;
    const canvas = renderer.domElement;
    const height = canvas.clientHeight || canvas.height || canvas.getBoundingClientRect().height || 1;

    // distance from camera to object in world space
    const d = camera.position.distanceTo(worldPos);

    // For PerspectiveCamera (as typed in Deps)
    const fov = camera.fov * (Math.PI / 180);
    const worldRadius = (targetPx * d * 2 * Math.tan(fov / 2)) / height;

    // geometry radius is RADIUS -> scale so mesh radius becomes worldRadius
    return Math.max(1e-4, worldRadius / RADIUS);
  }

  /** Rescales **visible** markers to target a pixel radius based on current preset. */
  private updateAutoScaleOnce() {
    if (!this.group || !this.group.visible) return;

    const targetPx = PRESET_PIXEL_TARGET[this.currentSize];
    const tmp = new THREE.Vector3();

    for (const ch of this.group.children) {
      if (!(ch as any).visible) continue;
      const worldPos = (ch as THREE.Mesh).getWorldPosition(tmp);
      const s = this.scaleForScreenPixels(targetPx, worldPos);
      (ch as THREE.Mesh).scale.setScalar(s);
    }
  }

  /** Starts a RAF loop that updates marker scales every frame (when auto-scale is ON). */
  private startAutoScaleLoop() {
    if (this.rafId !== undefined) return; // already running
    const tick = () => {
      if (this.autoScaleEnabled) this.updateAutoScaleOnce();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  // ---------- Tooltip ----------
  private onMouseMove = (e: MouseEvent) => {
    if (!this.group || !this.tipEl) return;

    const { renderer, camera } = this.deps;
    const rect = renderer.domElement.getBoundingClientRect();

    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.ray.setFromCamera(this.mouse, camera);
    const hits = this.ray.intersectObjects(this.group.children, false);

    if (!hits.length) {
      this.tipEl.style.display = "none";
      return;
    }

    const d: any = hits[0].object.userData || {};

    // position + show
    this.tipEl.style.display = "block";
    this.tipEl.style.left = (e.clientX + 12) + "px";
    this.tipEl.style.top  = (e.clientY - 12) + "px";

    // Build tooltip HTML without template strings (robust)
    const line1 = '<b style="font-weight:700">' + (d.name || d.internal_name || "Unknown") + '</b>';
    const line2 = '<div style="opacity:.85">' + (d.type || "") + '</div>';
    const famSeg = (d.family_id !== undefined && d.family_id !== null) ? (' | Family: ' + d.family_id) : '';
    const line3 = '<div>ID: ' + d.id + ' | Group: ' + d.group + famSeg + '</div>';
    const minLv = (d.min_level !== undefined ? d.min_level : "?");
    const maxLv = (d.max_level !== undefined ? d.max_level : "?");
    const line4 = '<div>Lv ' + minLv + ' – ' + maxLv + '</div>';
    const fx = Number(d.x), fy = Number(d.y), fz = Number(d.z);
    const line5 = '<div>XYZ: ' + (isFinite(fx) ? fx.toFixed(1) : '?') + ', ' +
                                 (isFinite(fy) ? fy.toFixed(1) : '?') + ', ' +
                                 (isFinite(fz) ? fz.toFixed(1) : '?') + '</div>';

    this.tipEl.innerHTML = line1 + line2 + line3 + line4 + line5;
  };

  private installTooltip() {
    // remove if any stale one exists
    const existing = document.getElementById(TIP_ID);
    if (existing) existing.remove();

    const tip = document.createElement("div");
    tip.id = TIP_ID;
    tip.style.cssText = [
      "position:fixed",
      "z-index:999998",
      "pointer-events:none",
      "display:none",
      "min-width:220px",
      "max-width:320px",
      "background:rgba(0,0,0,.78)",
      "color:#fff",
      "padding:6px 8px",
      "border-radius:6px",
      "font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "box-shadow:0 2px 8px rgba(0,0,0,.35)",
      "white-space:normal",
    ].join(";");

    document.body.appendChild(tip);
    this.tipEl = tip;

    this.deps.renderer.domElement.addEventListener("mousemove", this.onMouseMove);
  }
}