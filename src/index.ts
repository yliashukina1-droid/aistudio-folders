// The ==UserScript== banner is prepended at build time by build.ts, which reads
// the name/version/description from package.json. Do not add one here: the
// minifier strips comments, so an inline banner is silently dropped and only
// drifts out of sync with the one that actually ships.

declare global {
  interface Window {
    /** Set once below so a double injection is a no-op. */
    __aisFoldersLoaded?: boolean;
  }
}

/** A node in the folder tree. `parentId: null` means a root folder. */
interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
}

/** Per-chat record. Only *filed* chats get one -- see `setFolder`. */
interface Item {
  f: string | null;
}

/** The persisted shape, stored under `KEY` in localStorage. */
interface Db {
  v: number;
  folders: Folder[];
  items: Record<string, Item>;
  ui: {
    active: string;
    collapsed: Record<string, boolean>;
    /** Tree sort order. Absent means "name". */
    sort?: SortMode;
    /** Set once the creation-order -> name-derived colour migration has run. */
    derivedColors?: boolean;
    /** Set once the drag-to-file hint has been dismissed. */
    hintDismissed?: boolean;
  };
}

/** How the sidebar orders sibling folders. */
type SortMode = "name" | "count";

/** A row in a popup menu. `sep: true` renders a divider and ignores the rest. */
interface MenuEntry {
  label?: string;
  icon?: string;
  color?: string;
  checked?: boolean;
  danger?: boolean;
  sep?: boolean;
  onClick?: () => void;
}

/** Options accepted by `renderTreeItem`. */
interface TreeItemOpts {
  icon?: string;
  title?: string;
  droppable?: boolean;
  customMenu?: boolean;
  hasChildren?: boolean;
  /** Render the count as "N+" -- see `historyFullyLoaded`. */
  partial?: boolean;
  /** Draw the chevron open regardless of stored collapse state. */
  forceOpen?: boolean;
}

/** Circle shorthand accepted by `icon()` alongside plain path strings. */
interface CircleShape {
  c: [number, number, number];
}

(() => {
  if (window.__aisFoldersLoaded) return;
  window.__aisFoldersLoaded = true;

  /* ------------------------------------------------------------------ Setup */
  const KEY = "aisf.v2";
  const ROW_SEL = "table.library-table tbody tr.mat-mdc-row";
  // Mapped to standard AI Studio accent colors if available, falling back to nice hexes
  const PALETTE = [
    "#8ab4f8",
    "#81c995",
    "#fdd663",
    "#f28b82",
    "#c58af9",
    "#78d9ec",
    "#ffa46b",
    "#b0b8c4",
  ];
  /** Palette lookup that always yields a colour, so `Folder.color` stays a
   *  plain string rather than `string | undefined`. */
  const paletteColor = (i: number): string =>
    PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? "#8ab4f8";
  /** hsl -> #rrggbb, so the value still fits the Manager's colour input. */
  function hslHex(h: number, sat: number, light: number): string {
    const a = (sat / 100) * Math.min(light / 100, 1 - light / 100);
    const ch = (n: number) => {
      const k = (n + h / 30) % 12;
      const v = light / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * v)
        .toString(16)
        .padStart(2, "0");
    };
    return `#${ch(0)}${ch(8)}${ch(4)}`;
  }

  /**
   * Stable colour for a folder name.
   *
   * Colours used to be handed out by creation index against an eight-entry
   * palette, so twenty-five folders wrapped it three times and the dot
   * identified nothing. Hashing the name instead makes a folder's colour
   * stable and reproducible, and the golden-angle stride keeps neighbouring
   * hashes far apart on the wheel rather than adjacent.
   */
  function colorForName(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
    return hslHex((h * 137.508) % 360, 62, 70);
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const $$ = <T extends Element = Element>(sel: string, root: ParentNode = document): T[] =>
    Array.from(root.querySelectorAll(sel));

  /** Anything `el()` accepts as a child. `false`/nullish are skipped, so
   *  callers can inline `cond && node` and `cond ? node : null`. */
  type ElChild = Node | string | number | false | null | undefined;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props?: Record<string, unknown> | null,
    ...kids: (ElChild | ElChild[])[]
  ): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined) continue;
      if (k === "class") n.className = String(v);
      else if (k === "text") n.textContent = String(v);
      else if (k === "style") n.style.cssText = String(v);
      else if (k.startsWith("on") && typeof v === "function")
        n.addEventListener(k.slice(2), v as EventListener);
      else n.setAttribute(k, String(v));
    }
    kids.flat().forEach((k) => {
      if (k === null || k === undefined || k === false) return;
      n.append(typeof k === "object" ? k : document.createTextNode(String(k)));
    });
    return n;
  }

  /* ------------------------------------------------------------------ Icons */
  const NS = "http://www.w3.org/2000/svg";
  const FOLDER_D =
    "M3.5 7.3c0-.9.7-1.6 1.6-1.6h3.6l1.7 2.2h8.5c.9 0 1.6.7 1.6 1.6v7.6c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V7.3z";
  const ICONS: Record<string, (string | CircleShape)[]> = {
    all: [
      "M4.5 4.5h5.2v5.2H4.5z",
      "M14.3 4.5h5.2v5.2h-5.2z",
      "M4.5 14.3h5.2v5.2H4.5z",
      "M14.3 14.3h5.2v5.2h-5.2z",
    ],
    folder: [FOLDER_D],
    unfiled: [FOLDER_D, "M4 4l16 16"],
    plus: ["M12 5v14", "M5 12h14"],
    select: ["M3.5 7l2 2 3.5-3.5", "M3.5 16l2 2 3.5-3.5", "M13 6.5h7.5", "M13 17h7.5"],
    loadall: ["M8 9.5l4-4 4 4", "M8 14.5l4 4 4-4"],
    manage: [
      "M4 8.5h8",
      "M17 8.5h3",
      { c: [14.5, 8.5, 2.2] },
      "M4 15.5h3",
      "M12 15.5h8",
      { c: [9.5, 15.5, 2.2] },
    ],
    check: ["M5 12.5l4.5 4.5L19 7.5"],
    close: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
    trash: ["M4.5 7h15", "M9.5 7V4.8h5V7", "M6.8 7l1 12.2h8.4l1-12.2"],
    download: ["M12 4v10.5", "M8 11l4 4 4-4", "M5 19.5h14"],
    upload: ["M12 20V9.5", "M8 13l4-4 4 4", "M5 4.5h14"],
    edit: ["M4 20h4L19.2 8.8l-4-4L4 16v4z", "M14.6 5.4l4 4"],
    palette: [{ c: [12, 12, 7.8] }, { c: [12, 12, 2.6] }],
    dots: [{ c: [12, 6, 1.3] }, { c: [12, 12, 1.3] }, { c: [12, 18, 1.3] }],
    corner: ["M7 4v9h11", "M14 9l4 4-4 4"],
    search: [{ c: [10.5, 10.5, 6] }, "M15 15l4.5 4.5"],
    sort: ["M4 7h12", "M4 12h8", "M4 17h4"],
    chevron: ["M9 18l6-6-6-6"],
  };

  function icon(name: string, size = 15): SVGSVGElement {
    const shapes = ICONS[name] ?? ICONS.folder ?? [];
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", String(size));
    s.setAttribute("height", String(size));
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.7");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "aisf-ico");
    shapes.forEach((sh) => {
      if (typeof sh === "string") {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", sh);
        s.append(p);
      } else {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", String(sh.c[0]));
        c.setAttribute("cy", String(sh.c[1]));
        c.setAttribute("r", String(sh.c[2]));
        s.append(c);
      }
    });
    return s;
  }

  /* ------------------------------------------------------------------ Store */
  let db = load();

  /**
   * Migration for stores written before unfiled items stopped being persisted.
   * Drops records that carry no folder, and the per-chat `t` (title) field,
   * which was written on every decorate pass but never read back -- on an
   * account with a long history that was the bulk of the saved payload, and it
   * kept a copy of every chat title in localStorage for no reason.
   */
  function pruneItems(store: Db) {
    for (const [id, it] of Object.entries(store.items)) {
      if (!it?.f) delete store.items[id];
      else if ("t" in it) store.items[id] = { f: it.f };
    }
  }

  function load(): Db {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(KEY) || localStorage.getItem("aisf.v1") || "null",
      );
      if (parsed && Array.isArray(parsed.folders) && parsed.items) {
        parsed.folders.forEach((f: Folder) => {
          if (f.parentId === undefined) f.parentId = null;
        });
        parsed.ui = parsed.ui || { active: "all", collapsed: {} };
        parsed.ui.collapsed = parsed.ui.collapsed || {};
        pruneItems(parsed);
        // One-time: replace creation-order colours with name-derived ones.
        // Flagged so it never fights a colour set by hand afterwards.
        if (!parsed.ui.derivedColors) {
          parsed.folders.forEach((f: Folder) => {
            f.color = colorForName(f.name);
          });
          parsed.ui.derivedColors = true;
        }
        return parsed;
      }
    } catch (e) {
      console.warn("[AIS Folders] Reset needed", e);
    }
    return {
      v: 2,
      folders: [],
      items: {},
      ui: { active: "all", collapsed: {} },
    };
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(db));
      } catch (e) {
        console.warn("[AIS Folders] Save error", e);
      }
    }, 150);
  }

  const folderById = (id: string | null): Folder | null =>
    db.folders.find((f) => f.id === id) || null;

  /** Shared stand-in for "not filed anywhere". Never written to. */
  const UNFILED = Object.freeze({ f: null });

  /**
   * Read-only view of an item. Deliberately does NOT materialize a record:
   * decorate() calls this for every visible row, so materializing here meant
   * localStorage grew a `{f:null}` entry for every chat the user ever scrolled
   * past -- and "Scan all history" made that thousands at once.
   */
  const itemOf = (id: string): Item => db.items[id] || UNFILED;

  /**
   * The only writer of db.items. Unfiling deletes the record rather than
   * storing `f:null`, because absent and unfiled mean the same thing and only
   * one of them costs quota.
   */
  function setFolder(id: string, folderId: string | null) {
    if (folderId) db.items[id] = { f: folderId };
    else delete db.items[id];
  }

  /**
   * Orders siblings for display. Folders arrive in creation order, which stops
   * being navigable somewhere around a dozen of them.
   *
   * `counts` is only available while rendering the tree, so callers without it
   * (the folder picker, the manager) always get name order -- which is what
   * you want when hunting for a specific folder by name anyway.
   */
  function sortFolders(list: Folder[], counts?: Map<string, number>): Folder[] {
    const byName = (a: Folder, b: Folder) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    if (db.ui.sort === "count" && counts) {
      return [...list].sort(
        (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || byName(a, b),
      );
    }
    return [...list].sort(byName);
  }

  function getSubfolders(parentId: string | null = null, counts?: Map<string, number>): Folder[] {
    return sortFolders(
      db.folders.filter((f) => (f.parentId || null) === (parentId || null)),
      counts,
    );
  }

  function getDescendantFolderIds(folderId: string): Set<string> {
    const ids = new Set([folderId]);
    const queue = [folderId];
    while (queue.length > 0) {
      const cur = queue.shift();
      db.folders.forEach((f) => {
        if (f.parentId === cur && !ids.has(f.id)) {
          ids.add(f.id);
          queue.push(f.id);
        }
      });
    }
    return ids;
  }

  function isDescendant(candidateChildId: string, targetParentId: string): boolean {
    let cur = folderById(candidateChildId);
    const seen = new Set();
    while (cur?.parentId && !seen.has(cur.id)) {
      if (cur.parentId === targetParentId) return true;
      seen.add(cur.id);
      cur = folderById(cur.parentId);
    }
    return false;
  }

  /**
   * Inclusive chat count for every folder, in a single pass.
   *
   * Replaces per-folder `countOf(id)` calls during render: that did a
   * descendant BFS *and* a full scan of db.items once per folder, so drawing
   * the tree was O(folders^2 + folders x items). This is O(items + folders x
   * depth) for the whole tree.
   */
  function computeCounts(): Map<string, number> {
    const direct = new Map();
    for (const it of Object.values(db.items)) {
      if (it.f) direct.set(it.f, (direct.get(it.f) || 0) + 1);
    }

    const total = new Map();
    for (const f of db.folders) total.set(f.id, direct.get(f.id) || 0);

    // Roll each folder's own count up through its ancestors. `seen` stops a
    // parentId cycle in a hand-edited or imported store from hanging the page.
    for (const f of db.folders) {
      const own = direct.get(f.id) || 0;
      if (!own) continue;
      const seen = new Set([f.id]);
      let p = f.parentId;
      while (p && !seen.has(p)) {
        seen.add(p);
        total.set(p, (total.get(p) || 0) + own);
        p = folderById(p)?.parentId || null;
      }
    }
    return total;
  }

  /**
   * Inclusive count for a single folder. Use computeCounts() when drawing the
   * whole tree -- this walks descendants and scans every item on each call.
   */
  function countOf(fid: string): number {
    const family = getDescendantFolderIds(fid);
    return Object.values(db.items).filter((it) => it.f && family.has(it.f)).length;
  }

  function getFolderPath(fid: string): string {
    const names = [];
    let cur = folderById(fid);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parentId ? folderById(cur.parentId) : null;
    }
    return names.join(" / ");
  }

  function addFolder(name: string, parentId: string | null = null): Folder | null {
    const clean = (name || "").trim().slice(0, 30);
    if (!clean) return null;
    const parent = parentId ? folderById(parentId) : null;
    const f: Folder = {
      id: uid(),
      name: clean,
      parentId: parent ? parent.id : null,
      color: colorForName(clean),
    };
    db.folders.push(f);

    // Auto-expand parent upon creating a child
    if (parent && db.ui.collapsed[parent.id]) {
      db.ui.collapsed[parent.id] = false;
    }

    save();
    return f;
  }

  function deleteFolder(id: string) {
    const target = folderById(id);
    if (!target) return;
    const fallbackParentId = target.parentId || null;
    db.folders.forEach((f) => {
      if (f.parentId === id) f.parentId = fallbackParentId;
    });
    db.folders = db.folders.filter((f) => f.id !== id);
    // Drop the records rather than blanking them to `f:null` -- an unfiled
    // item is represented by the absence of a record.
    for (const [chatId, it] of Object.entries(db.items)) {
      if (it.f === id) delete db.items[chatId];
    }
    if (active === id) setActive(fallbackParentId || "all");
    save();
  }

  function assign(ids: string[], folderId: string | null) {
    ids.forEach((id) => {
      setFolder(id, folderId);
    });
    save();
    render();
    decorate();
  }

  /* --------------------------------------------------------------- UI State */
  /** Selected tree key: a folder id, or the pseudo-keys "all" / "unfiled". */
  let active: string = db.ui?.active || "all";
  let selectMode = false;
  let bypassFilter = false;
  /** Live folder-name filter from the sidebar box, lowercased. */
  let folderFilter = "";
  /**
   * True once "Scan all history" has walked the entire list this session.
   *
   * Until then the only chats we can see are the ones the SPA has rendered, so
   * the "All chats" and "Unfiled" totals are lower bounds and are shown as
   * "N+". Folder counts come from storage and are always exact.
   */
  let historyFullyLoaded = false;
  /**
   * Tri-state, and the distinction matters: `undefined` means no inline
   * create is open, `null` means one is open at the root, and a string means
   * one is open under that folder.
   */
  let inlineParentTarget: string | null | undefined;
  const selected = new Set<string>();
  let dragIds: string[] | null = null;
  /** Index into the last `visibleRows()` list, for shift-range selection. */
  let lastClicked: number | null = null;
  let dragExpandTimeout: ReturnType<typeof setTimeout> | null = null;

  function setActive(key: string) {
    active = key;
    db.ui.active = key;
    save();
    render();
    applyFilter();
  }

  /* ------------------------------------------------------------------ Style */
  function injectStyle() {
    if (document.getElementById("aisf-style")) return;
    document.head.append(
      el("style", {
        id: "aisf-style",
        text: `
/* Native matching Grid Layout */
ms-history-view, ms-library-table {
  max-width: 100% !important;
  width: 100% !important;
}

/* The folder rail is mirrored by an empty column of the same width on the
   right. That is what lets the history column sit on the true horizontal
   centre of the window while the folder panel stays pinned to the left edge --
   centring the whole grid instead (margin: 0 auto) is what used to push the
   rail inward and leave a dead gutter on the right. */
/* AI Studio centres the page inside a max-width box on these two wrappers
   (the rule lives in its external stylesheet). That box is what held the
   folder rail ~330px in from the window edge, and it is why a mirrored column
   had no room to exist. Release it and take over the centring here. */
ms-library .page-content-wrapper,
ms-library .page-content-inner-wrapper {
  max-width: none !important;
  width: 100% !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}

ms-library-table section.lib-view {
  --aisf-rail: 280px;
  display: grid !important;
  grid-template-columns: var(--aisf-rail) minmax(0, 1fr) var(--aisf-rail) !important;
  grid-template-rows: auto 1fr !important;
  column-gap: 32px !important;
  padding: 32px 24px 16px !important;
  align-items: start !important;
  box-sizing: border-box !important;
}

/* Children only need telling which column they belong to. Do not touch their
   width or margins: .lib-table-wrapper carries native -16px side margins to
   bleed the table, and overriding those is what crushed the columns. */
ms-library-table section.lib-view > *:not(#aisf-sidebar) {
  grid-column: 2 !important;
  min-width: 0 !important;
}


/* Narrow enough that a mirrored column costs more room than the centring is
   worth -- drop it and let the history fill what is left. */
@media (max-width: 1280px) {
  ms-library-table section.lib-view {
    --aisf-rail: 260px;
    grid-template-columns: var(--aisf-rail) minmax(0, 1fr) !important;
  }
}

/* No room for a side-by-side rail: stack the panel above the history. */
@media (max-width: 860px) {
  ms-library-table section.lib-view {
    grid-template-columns: minmax(0, 1fr) !important;
  }
  ms-library-table section.lib-view > *:not(#aisf-sidebar) {
    grid-column: 1 !important;
  }
  #aisf-sidebar {
    grid-column: 1 !important;
    grid-row: auto !important;
    position: static !important;
    max-height: 320px !important;
    margin-bottom: 16px !important;
  }
}

/* Base Sidebar */
/* Tabs, not a panel: no card fill, border or radius. The rail should read as
   part of the page rather than a widget bolted onto it. */
#aisf-sidebar {
  grid-column: 1 !important;
  grid-row: 1 / span 30 !important;
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: none;
  border: none;
  padding: 0 4px 0 0;
  user-select: none;
  box-sizing: border-box;
  /* Never fake a weight the loaded font lacks. If a rule asks for one that is
     not available, it renders at the nearest real weight instead of being
     smeared into a halo. */
  font-synthesis-weight: none;
}

/* Header & Controls */
.aisf-sb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  margin-bottom: 8px;
}
.aisf-sb-title {
  font-family: 'Inter Tight', sans-serif;
  font-weight: 600;
  font-size: 15px;
  color: var(--color-v3-text);
  padding-left: 8px;
}
.aisf-sb-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}
.aisf-tool {
  background: transparent;
  border: none;
  padding: 6px;
  border-radius: 8px;
  color: var(--color-v3-text-var);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.aisf-tool:hover { background: var(--color-v3-hover); color: var(--color-v3-text); }
.aisf-tool.on { background: var(--color-v3-button-container-accent); color: var(--color-v3-text-on-button); }

/* Filter + sort */
/* Same shape as AI Studio's own search field: pill, container fill, hairline
   outline that picks up the accent on focus. */
.aisf-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  margin: 0 0 12px;
  padding: 0 6px 0 12px;
  border-radius: 9999px;
  background: var(--color-v3-surface-container);
  border: 1px solid var(--color-v3-outline-var);
  color: var(--color-v3-text-var);
  transition: border-color 0.2s ease;
}
.aisf-filter-row:focus-within { border-color: var(--color-v3-outline-accent); }
.aisf-filter-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-v3-text);
  font-family: Inter, sans-serif;
  font-size: 13px;
}
.aisf-filter-input::placeholder { color: var(--color-v3-text-disable); }
.aisf-filter-input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
.aisf-sort { padding: 4px; }

/* Separates the two pinned views from the user's own folders. */
.aisf-divider {
  height: 1px;
  margin: 8px 4px 10px;
  background: var(--color-v3-outline-var);
}

.aisf-bulk-sep {
  width: 1px;
  align-self: stretch;
  margin: 4px 2px;
  background: var(--color-v3-outline-var);
}
#aisf-bulk .aisf-tool[disabled] { opacity: 0.4; pointer-events: none; }

.aisf-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 4px 2px 8px;
  padding: 10px 8px 10px 10px;
  border-radius: 8px;
  background: var(--color-v3-surface-container-high);
  font-family: Inter, sans-serif;
  font-size: 12px;
  line-height: 16px;
  color: var(--color-v3-text-var);
}
.aisf-hint-x {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 2px;
  border-radius: 4px;
  color: var(--color-v3-text-disable);
  cursor: pointer;
}
.aisf-hint-x:hover { background: var(--color-v3-hover); color: var(--color-v3-text); }

.aisf-tree-empty {
  padding: 16px 8px;
  font-family: Inter, sans-serif;
  font-size: 12px;
  color: var(--color-v3-text-disable);
}

/* Tree Scroll Area */
.aisf-tree-scroll {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  padding-right: 2px;
}

/* Standard Item */
.aisf-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px 0 6px;
  border-radius: 8px;
  cursor: pointer;
  font-family: Inter, sans-serif;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-v3-text-var);
  border: 1px solid transparent;
  transition: background 0.1s;
  white-space: nowrap;
}
.aisf-item:hover {
  background: var(--color-v3-surface-container-high);
  color: var(--color-v3-text);
}
/* No font-weight bump here. AI Studio loads Inter at 400 and 500 only, so
   asking for 600 made the browser synthesise the bold by smearing the glyphs
   -- which read as a glow around the selected row. The fill, the brighter
   text and the edge marker below already carry the state. */
.aisf-item.on {
  background: var(--color-v3-surface-container-highest);
  color: var(--color-v3-text);
}
/* A selected row needs to survive being one of thirty near-identical rows,
   so it gets an edge marker as well as a fill. */
.aisf-item.on::before {
  content: "";
  position: absolute;
  left: -6px;
  top: 50%;
  width: 3px;
  height: 16px;
  transform: translateY(-50%);
  border-radius: 0 2px 2px 0;
  background: var(--color-v3-outline-accent, currentColor);
}
.aisf-item:focus-visible,
.aisf-tool:focus-visible,
.aisf-btn-tiny:focus-visible {
  outline: 2px solid var(--color-v3-outline-accent);
  outline-offset: 1px;
}
/* The pill already reports focus via :focus-within. A second ring on the
   input drew a rectangle inside the rounded field. */
.aisf-filter-input:focus,
.aisf-filter-input:focus-visible { outline: none; box-shadow: none; }
.aisf-item.drop {
  background: var(--color-v3-button-container) !important;
  color: var(--color-v3-text-on-button) !important;
  border-color: var(--color-v3-outline-accent) !important;
}

/* Accordion Chevron */
.aisf-chevron {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  color: var(--color-v3-text-disable);
  transition: transform 0.15s ease, background 0.15s ease;
}
.aisf-chevron:hover { background: var(--color-v3-hover); color: var(--color-v3-text); }
.aisf-chevron.open { transform: rotate(90deg); }
.aisf-chevron.hidden { visibility: hidden; pointer-events: none; }

/* Item anatomy */
.aisf-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin: 0 3px; }
.aisf-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.aisf-count { font-size: 11px; color: var(--color-v3-text-disable); margin-left: auto; font-weight: 400;}

/* Subgroups */
.aisf-subgroup {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 18px;
  margin-left: 13px;
  border-left: 1px solid var(--color-v3-outline-var);
  transition: height 0.2s ease, opacity 0.2s ease;
}

/* Micro Actions */
/* Taken out of flow on purpose. Toggling display here made the row reflow
   under the cursor -- the count jumped left as the buttons claimed width. */
.aisf-item-actions {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
}
.aisf-item:hover .aisf-item-actions,
.aisf-item:focus-within .aisf-item-actions { opacity: 1; pointer-events: auto; }
/* Must match the states above exactly. The actions sit on top of the count,
   so any state that reveals them has to hide it -- focus latches once a row
   is clicked or arrowed onto, which left the count under the dots button. */
.aisf-item:hover .aisf-count,
.aisf-item:focus-within .aisf-count { opacity: 0; }
.aisf-btn-tiny {
  background: transparent;
  border: none;
  padding: 4px;
  border-radius: 6px;
  color: var(--color-v3-text-var);
  cursor: pointer;
}
.aisf-btn-tiny:hover { background: var(--color-v3-hover); color: var(--color-v3-text); }

/* Inline Inputs */
.aisf-inline-box {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--color-v3-surface-container-highest);
  border: 1px solid var(--color-v3-outline-accent);
  border-radius: 8px;
  padding: 0 8px;
  height: 34px;
  margin: 2px 0;
}
.aisf-inline-input {
  background: transparent;
  border: none;
  color: var(--color-v3-text);
  font-family: Inter, sans-serif;
  font-size: 13px;
  font-weight: 500;
  outline: none;
  width: 100%;
}

/* Table Row Modifications */
/* AI Studio draws this cell's icon as a Material Symbols *ligature*: the
   span's text content is literally "chat_bubble", shaped into a glyph by the
   icon font. Whenever that font has not painted, the raw text shows through
   and gets clipped to a stray ".." on every row. Hiding the span is not
   enough on its own, so the cell's font-size is zeroed too -- no text node in
   here can render at all -- and restored on our own control. */
table.library-table td.icon-cell { font-size: 0 !important; }
table.library-table td.icon-cell .prompt-icon { display: none !important; }
table.library-table td.icon-cell .aisf-rowbtn { font-size: 13px !important; }
.aisf-rowbtn {
  background: none;
  border: 0;
  padding: 6px;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-v3-text-var);
  transition: background 0.15s;
}
.aisf-rowbtn:hover { background: var(--color-v3-hover); color: var(--color-v3-text); }
/* The chat title is the thing people scan for. An unfiled row's folder button
   recedes until you reach for it; a filed row keeps its colour dot visible
   because that dot is information. */
/* Fixed square box. The dot inside carries margin: 0 3px, which made the
   button's content box 12x6 -- so padding gave a 24x18 button and a 50%
   radius drew an ellipse. Size it explicitly and drop the dot's margin here. */
.aisf-rowbtn {
  opacity: 0.3;
  width: 26px;
  height: 26px;
  padding: 0;
  flex: 0 0 26px;
  box-sizing: border-box;
  transition: opacity 0.15s, background 0.15s;
}
.aisf-rowbtn .aisf-dot { margin: 0; }
tr:hover .aisf-rowbtn,
.aisf-rowbtn:focus-visible,
.aisf-rowbtn[data-aisf-state^="f-"] { opacity: 1; }
.aisf-check { width: 16px; height: 16px; margin: 0 8px 0 4px; accent-color: var(--color-v3-accent-4); cursor: pointer; }
/* Context Menus mapped to App Themes */
.aisf-menu {
  position: fixed;
  z-index: 2147483000;
  min-width: 240px;
  max-width: 320px;
  /* A small window, not a column the length of the folder list. */
  max-height: min(340px, calc(100vh - 32px));
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 8px;
  border-radius: 12px;
  background: var(--color-v3-surface-container-high);
  border: 1px solid var(--color-v3-outline-var);
  box-shadow: var(--v3-shadow-lg);
}
/* When a pinned footer exists the inner list scrolls instead of the menu. */
.aisf-menu:has(.aisf-menu-scroll) { overflow: hidden; }
.aisf-menu-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.aisf-menu-foot {
  flex: 0 0 auto;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-v3-outline-var);
}
.aisf-mi {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-family: Inter, sans-serif;
  font-size: 13px;
  color: var(--color-v3-text);
  text-align: left;
}
.aisf-mi:hover { background: var(--color-v3-hover); }
.aisf-mi.danger { color: var(--color-v3-accent-3); }
.aisf-mi.danger:hover { background: color-mix(in srgb, var(--color-v3-accent-3) 15%, transparent); }
.aisf-sep { height: 1px; margin: 6px 0; background: var(--color-v3-outline-var); }

/* Bulk Floating Island */
#aisf-bulk {
  position: fixed;
  left: 50%;
  bottom: 32px;
  transform: translateX(-50%);
  z-index: 2147482000;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-radius: 24px;
  background: var(--color-v3-surface-container-highest);
  border: 1px solid var(--color-v3-outline);
  box-shadow: var(--v3-shadow-lg);
  color: var(--color-v3-text);
  font-family: Inter, sans-serif;
  font-weight: 500;
  font-size: 14px;
}

/* Manager Dialog */
.aisf-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-overlay-background, rgba(0, 0, 0, 0.5));
  backdrop-filter: blur(4px);
  padding: 20px;
}
.aisf-dialog {
  width: min(560px, 100%);
  max-height: 85vh;
  overflow: auto;
  padding: 24px;
  border-radius: 24px;
  background: var(--color-v3-surface-container-high);
  border: 1px solid var(--color-v3-outline);
  box-shadow: var(--v3-shadow-lg);
  color: var(--color-v3-text);
}
.aisf-dialog h2 { margin: 0 0 8px; font-family: 'Inter Tight', sans-serif; font-weight: 600; font-size: 20px; }
.aisf-dialog p.aisf-sub { margin: 0 0 20px; font-size: 13px; color: var(--color-v3-text-var); }
.aisf-frow { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--color-v3-outline-var); }
.aisf-frow:last-of-type { border-bottom: none; }
.aisf-frow input[type=text] {
  flex: 1; height: 36px; padding: 0 12px; border-radius: 8px;
  background: var(--color-v3-surface-container); border: 1px solid var(--color-v3-outline-var);
  color: var(--color-v3-text); font-family: Inter, sans-serif; font-size: 13px;
  outline: none; transition: border-color 0.2s;
}
.aisf-frow input[type=text]:focus { border-color: var(--color-v3-outline-accent); }
/* flex: 0 0 32px, not width alone. As a flex item this defaulted to
   flex-shrink: 1, so a crowded row squeezed it horizontally while the height
   held -- and border-radius: 50% on a 26x32 box is an ellipse, not a circle.
   aspect-ratio keeps it honest if the metrics are ever touched again. */
.aisf-frow input[type=color] {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  aspect-ratio: 1;
  box-sizing: border-box;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
}
/* Same reasoning: neither of these should absorb the row's overflow. */
.aisf-frow .aisf-tool { flex: 0 0 auto; }
.aisf-frow input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
.aisf-frow input[type="color"]::-webkit-color-swatch { border: none; border-radius: 50%; }

.aisf-actions { display: flex; gap: 12px; margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--color-v3-outline-var); }

@media (prefers-reduced-motion: reduce) {
  #aisf-sidebar *, #aisf-bulk *, .aisf-menu *, .aisf-overlay * {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
            `,
      }),
    );
  }

  /* ----------------------------------------------------------------- Rows */
  function rowId(tr: Element): string | null {
    const a = tr.querySelector('a.name-link[href*="/prompts/"]');
    if (!a) return null;
    // Guard the split rather than trusting the attribute selector: decorate()
    // runs inside a try/catch, so one malformed href here would abort the
    // whole pass and leave the remaining rows undecorated.
    const tail = (a.getAttribute("href") || "").split("/prompts/")[1];
    return tail ? tail.split(/[?#]/)[0] || null : null;
  }
  const rows = () => $$<HTMLTableRowElement>(ROW_SEL);
  const visibleRows = () => rows().filter((r) => r.style.display !== "none");

  /* ---------------------------------------------------------------- Menus */
  function closeMenus() {
    $$(".aisf-menu").forEach((m) => {
      m.remove();
    });
  }

  /**
   * @param pinned Entries kept out of the scrolling area, so actions stay
   *   reachable without scrolling past every folder.
   */
  function menu(anchor: Element, items: MenuEntry[], pinned: MenuEntry[] = []) {
    closeMenus();
    const m = el("div", { class: "aisf-menu", role: "menu" });

    const build = (list: MenuEntry[], into: HTMLElement) => {
      list.forEach((it) => {
        if (it.sep) {
          into.append(el("div", { class: "aisf-sep" }));
          return;
        }
        const itemEl = el(
          "button",
          {
            class: `aisf-mi${it.danger ? " danger" : ""}`,
            role: "menuitem",
            onclick: () => {
              closeMenus();
              it.onClick?.();
            },
          },
          it.color
            ? el("span", { class: "aisf-dot", style: `background:${it.color}` })
            : icon(it.icon || "folder", 16),
          el("span", { style: "flex:1;", text: it.label }),
          it.checked ? icon("check", 16) : null,
        );
        into.append(itemEl);
      });
    };

    if (pinned.length) {
      const scroller = el("div", { class: "aisf-menu-scroll" });
      build(items, scroller);
      m.append(scroller);
      const foot = el("div", { class: "aisf-menu-foot" });
      build(pinned, foot);
      m.append(foot);
    } else {
      build(items, m);
    }

    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = `${Math.max(16, Math.min(window.innerWidth - m.offsetWidth - 16, r.left))}px`;
    m.style.top = `${r.bottom + m.offsetHeight + 16 > window.innerHeight ? Math.max(16, r.top - m.offsetHeight - 8) : r.bottom + 8}px`;
    return m;
  }

  function folderPicker(anchor: Element, ids: string[]) {
    const first = ids.length === 1 ? ids[0] : undefined;
    const current = first ? itemOf(first).f : null;
    const items: MenuEntry[] = [];

    function buildTree(parentId: string | null = null, depth = 0) {
      const list = getSubfolders(parentId);
      list.forEach((f) => {
        const prefix = depth > 0 ? "↳ ".padStart(depth * 3, "\u00A0") : "";
        items.push({
          label: `${prefix}${f.name}`,
          color: f.color,
          checked: f.id === current,
          onClick: () => assign(ids, f.id),
        });
        buildTree(f.id, depth + 1);
      });
    }
    buildTree();

    // The folder list scrolls; these two stay pinned beneath it.
    menu(anchor, items, [
      {
        label: "Remove from folder",
        icon: "unfiled",
        onClick: () => assign(ids, null),
      },
      {
        label: "New folder",
        icon: "plus",
        onClick: () => startInlineCreate(null),
      },
    ]);
  }

  function folderOptionsMenu(anchor: Element, fid: string) {
    const f = folderById(fid);
    if (!f) return;

    const items: MenuEntry[] = [
      {
        label: "Add subfolder…",
        icon: "plus",
        onClick: () => startInlineCreate(fid),
      },
      {
        label: "Rename",
        icon: "edit",
        onClick: () => {
          const next = window.prompt("Rename folder", f.name);
          if (next?.trim()) {
            f.name = next.trim().slice(0, 30);
            save();
            render();
            decorate();
          }
        },
      },
      {
        label: "Change color",
        icon: "palette",
        onClick: () => {
          f.color = paletteColor(PALETTE.indexOf(f.color) + 1);
          save();
          render();
          decorate();
        },
      },
    ];

    const validParents = db.folders.filter(
      (candidate) => candidate.id !== fid && !isDescendant(candidate.id, fid),
    );
    if (validParents.length > 0 || f.parentId) {
      items.push({
        label: f.parentId ? "Move to root level" : "Move into another folder…",
        icon: "corner",
        onClick: () => {
          if (f.parentId) {
            f.parentId = null;
            save();
            render();
            decorate();
          } else {
            const moveItems = validParents.map((p) => ({
              label: getFolderPath(p.id),
              color: p.color,
              onClick: () => {
                f.parentId = p.id;
                save();
                render();
                decorate();
              },
            }));
            menu(anchor, moveItems);
          }
        },
      });
    }

    items.push({ sep: true });
    items.push({
      label: `Delete folder (${countOf(fid)} chats unfiled)`,
      icon: "trash",
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            `Are you sure you want to delete "${f.name}"? Chats inside will be unfiled.`,
          )
        ) {
          deleteFolder(fid);
          render();
          decorate();
        }
      },
    });

    menu(anchor, items);
  }

  /* --------------------------------------------------------------- Sidebar UI */
  function ensureSidebar() {
    const host = document.querySelector("ms-library-table section.lib-view");
    if (!host) {
      document.getElementById("aisf-sidebar")?.remove();
      document.getElementById("aisf-bulk")?.remove();
      return null;
    }

    let sb = document.getElementById("aisf-sidebar");
    if (sb?.isConnected && host.contains(sb)) return sb;

    sb = el(
      "div",
      { id: "aisf-sidebar" },
      el(
        "div",
        { class: "aisf-sb-header" },
        el("span", { class: "aisf-sb-title", text: "Folders" }),
        el(
          "div",
          { class: "aisf-sb-tools" },
          el(
            "button",
            {
              class: "aisf-tool",
              title: "New folder",
              onclick: () => startInlineCreate(null),
            },
            icon("plus", 16),
          ),
          el(
            "button",
            {
              class: "aisf-tool",
              id: "aisf-select",
              title: "Select multiple chats to file or unfile",
              onclick: toggleSelectMode,
            },
            icon("select", 16),
          ),
          el(
            "button",
            {
              class: "aisf-tool",
              id: "aisf-loadall",
              title: "Scan all history so the counts are exact",
              onclick: (e: Event) => loadAll(e.currentTarget as Element | null),
            },
            icon("loadall", 16),
          ),
          el(
            "button",
            {
              class: "aisf-tool",
              title: "Manage folders: rename, recolour, import and export",
              onclick: openManager,
            },
            icon("manage", 16),
          ),
        ),
      ),
      el(
        "div",
        { class: "aisf-filter-row" },
        icon("search", 14),
        el("input", {
          class: "aisf-filter-input",
          id: "aisf-filter",
          type: "search",
          placeholder: "Filter folders",
          "aria-label": "Filter folders by name",
          value: folderFilter,
          oninput: (e: Event) => {
            folderFilter = (e.currentTarget as HTMLInputElement).value.trim().toLowerCase();
            render();
          },
        }),
        el(
          "button",
          {
            class: "aisf-tool aisf-sort",
            id: "aisf-sort",
            title: sortTitle(),
            "aria-label": sortTitle(),
            onclick: toggleSort,
          },
          icon("sort", 14),
        ),
      ),
      el("div", { class: "aisf-tree-scroll" }),
    );

    host.prepend(sb);
    render();
    return sb;
  }

  /** Names the current order and what a click will do, not just one of them. */
  const sortTitle = () =>
    db.ui.sort === "count"
      ? "Sorted by chat count - click to sort A-Z"
      : "Sorted A-Z - click to sort by chat count";

  function toggleSort() {
    db.ui.sort = db.ui.sort === "count" ? "name" : "count";
    save();
    render();
    const btn = document.getElementById("aisf-sort");
    if (btn) {
      btn.title = sortTitle();
      btn.setAttribute("aria-label", sortTitle());
      btn.classList.toggle("on", db.ui.sort === "count");
    }
  }

  function startInlineCreate(parentId: string | null = null) {
    inlineParentTarget = parentId;
    // Auto-expand parent to show the input field
    if (parentId && db.ui.collapsed[parentId]) {
      db.ui.collapsed[parentId] = false;
    }
    render();

    const input = document.querySelector<HTMLInputElement>(".aisf-inline-input");
    if (!input) return;
    input.focus();

    const commit = () => {
      if (inlineParentTarget === undefined) return;
      const targetParent = inlineParentTarget;
      inlineParentTarget = undefined;
      const val = input.value.trim();
      if (val) {
        const newF = addFolder(val, targetParent);
        if (newF) setActive(newF.id);
      } else {
        render();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        inlineParentTarget = undefined;
        render();
      }
    });
    // Blur auto-commits if there's text, otherwise discards without side effects
    input.addEventListener("blur", () => commit());
  }

  function renderTreeItem(
    key: string,
    label: string,
    color: string | null,
    count: number | null,
    opts: TreeItemOpts = {},
  ) {
    const isCurrent = active === key;
    const hasChildren = opts.hasChildren;
    const isCollapsed = db.ui.collapsed[key];

    const chevron = el(
      "div",
      {
        class: `aisf-chevron${hasChildren ? "" : " hidden"}${isCollapsed && !opts.forceOpen ? "" : " open"}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          db.ui.collapsed[key] = !isCollapsed;
          save();
          render();
        },
      },
      icon("chevron", 14),
    );

    const item = el(
      "div",
      {
        class: `aisf-item${isCurrent ? " on" : ""}`,
        "data-key": key,
        title: opts.title || label,
        onclick: () => setActive(key),
        oncontextmenu: (e: Event) => {
          if (folderById(key)) {
            e.preventDefault();
            folderOptionsMenu(item, key);
          }
        },
      },
      chevron,
      color
        ? el("span", { class: "aisf-dot", style: `background:${color}` })
        : icon(opts.icon || "folder", 14),
      el("span", { class: "aisf-name", text: label }),
      count !== null && count !== undefined
        ? el("span", {
            class: "aisf-count",
            text: opts.partial ? `${count}+` : String(count),
          })
        : null,
    );

    if (opts.customMenu) {
      const actions = el(
        "div",
        { class: "aisf-item-actions" },
        el(
          "button",
          {
            class: "aisf-btn-tiny",
            title: "Add subfolder",
            onclick: (e: Event) => {
              e.stopPropagation();
              startInlineCreate(key);
            },
          },
          icon("plus", 14),
        ),
        el(
          "button",
          {
            class: "aisf-btn-tiny",
            title: "Folder options",
            onclick: (e: Event) => {
              e.stopPropagation();
              folderOptionsMenu(item, key);
            },
          },
          icon("dots", 14),
        ),
      );
      item.append(actions);
    }

    if (opts.droppable) {
      item.addEventListener("dragover", (e) => {
        if (!dragIds) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        item.classList.add("drop");

        // Auto-expand logic on dragover
        if (hasChildren && isCollapsed) {
          if (!dragExpandTimeout) {
            dragExpandTimeout = setTimeout(() => {
              db.ui.collapsed[key] = false;
              save();
              render();
              dragExpandTimeout = null;
            }, 700);
          }
        }
      });
      item.addEventListener("dragleave", () => {
        item.classList.remove("drop");
        if (dragExpandTimeout) {
          clearTimeout(dragExpandTimeout);
          dragExpandTimeout = null;
        }
      });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("drop");
        if (dragExpandTimeout) {
          clearTimeout(dragExpandTimeout);
          dragExpandTimeout = null;
        }
        if (dragIds) assign(dragIds, key === "unfiled" ? null : key);
        dragIds = null;
      });
    }

    return item;
  }

  function render() {
    const sb = document.getElementById("aisf-sidebar");
    if (!sb) return;

    const scroll = sb.querySelector(".aisf-tree-scroll");
    if (!scroll) return;
    scroll.textContent = "";

    // One pass for the whole tree, rather than a BFS per folder.
    const counts = computeCounts();
    const loaded = rows().length;
    const unfiled = unfiledLoadedCount();
    const partial = !historyFullyLoaded;
    const scanHint = partial ? " Scan all history for the full count." : "";

    // Pinned. These two are views, not folders: they are appended before the
    // tree is built, so neither sortFolders() nor the filter box can reorder
    // or hide them. Their counts describe rows AI Studio has actually
    // rendered, hence the "+" until a full scan runs -- folder counts come
    // from storage and never carry it.
    scroll.append(
      renderTreeItem("all", "All chats", null, loaded, {
        icon: "all",
        partial,
        title: `${loaded} chats loaded.${scanHint}`,
      }),
    );
    scroll.append(
      renderTreeItem("unfiled", "Unfiled", null, unfiled, {
        icon: "unfiled",
        droppable: true,
        partial,
        title: `${unfiled} chats not in a folder, of ${loaded} loaded.${scanHint}`,
      }),
    );

    scroll.append(el("div", { class: "aisf-divider" }));

    // Shown until dismissed, and only while nothing has ever been filed --
    // drag-to-file is the primary gesture and nothing else advertises it.
    if (!db.ui.hintDismissed && Object.keys(db.items).length === 0) {
      scroll.append(
        el(
          "div",
          { class: "aisf-hint" },
          el("span", { text: "Drag any chat onto a folder to file it." }),
          el(
            "button",
            {
              class: "aisf-hint-x",
              title: "Dismiss",
              onclick: () => {
                db.ui.hintDismissed = true;
                save();
                render();
              },
            },
            icon("close", 12),
          ),
        ),
      );
    }

    if (inlineParentTarget === null) {
      const input = el("input", {
        class: "aisf-inline-input",
        placeholder: "Root folder name…",
      });
      scroll.append(el("div", { class: "aisf-inline-box" }, icon("folder", 14), input));
    }

    // Recursive tree rendering
    function buildTreeDOM(parentId: string | null, container: Element) {
      const list = getSubfolders(parentId, counts).filter(matchesFilter);
      list.forEach((f) => {
        const children = getSubfolders(f.id, counts).filter(matchesFilter);
        // While filtering, force every surviving branch open: a match buried
        // in a collapsed folder that you cannot see is the same as no match.
        const hasChildren = children.length > 0 || inlineParentTarget === f.id;
        const expanded = folderFilter ? true : !db.ui.collapsed[f.id];

        container.append(
          renderTreeItem(f.id, f.name, f.color, counts.get(f.id) || 0, {
            droppable: true,
            customMenu: true,
            hasChildren: hasChildren,
            forceOpen: !!folderFilter && hasChildren,
          }),
        );

        if (hasChildren && expanded) {
          const subGroup = el("div", { class: "aisf-subgroup" });
          buildTreeDOM(f.id, subGroup);

          if (inlineParentTarget === f.id) {
            const subInput = el("input", {
              class: "aisf-inline-input",
              placeholder: "Subfolder name…",
            });
            subGroup.append(el("div", { class: "aisf-inline-box" }, icon("corner", 14), subInput));
          }
          container.append(subGroup);
        }
      });
    }

    buildTreeDOM(null, scroll);

    if (
      folderFilter &&
      !scroll.querySelector(".aisf-item[data-key]:not([data-key='all']):not([data-key='unfiled'])")
    ) {
      scroll.append(
        el("div", { class: "aisf-tree-empty", text: `No folder matches "${folderFilter}".` }),
      );
    }

    sb.querySelector("#aisf-select")?.classList.toggle("on", selectMode);
  }

  /**
   * A folder survives the filter if it matches, or if any descendant does --
   * otherwise filtering would hide the only path to a match.
   */
  function matchesFilter(f: Folder): boolean {
    if (!folderFilter) return true;
    if (f.name.toLowerCase().includes(folderFilter)) return true;
    return db.folders.some((c) => c.parentId === f.id && matchesFilter(c));
  }

  /**
   * Repoints just the two pinned counts after a decorate pass, instead of
   * re-rendering the whole tree on every tick.
   */
  function refreshGlobalCounts() {
    const suffix = historyFullyLoaded ? "" : "+";
    const set = (key: string, n: number) => {
      const cell = document.querySelector(`.aisf-item[data-key="${key}"] .aisf-count`);
      if (cell) cell.textContent = `${n}${suffix}`;
    };
    set("all", rows().length);
    set("unfiled", unfiledLoadedCount());
  }

  const unfiledLoadedCount = () =>
    rows().filter((tr) => {
      const id = tr.dataset.aisfId;
      return !!id && !itemOf(id).f;
    }).length;

  /* -------------------------------------------------------------- Decorate */
  function decorate() {
    const table = document.querySelector("table.library-table");
    if (table) table.classList.add("aisf-on");
    const list = rows();
    if (!list.length) return;

    list.forEach((tr) => {
      const id = rowId(tr);
      if (!id) return;
      tr.dataset.aisfId = id;
      const rec = itemOf(id);

      const cell = tr.querySelector("td.icon-cell");
      if (cell) {
        if (selectMode) {
          cell.querySelector(".aisf-rowbtn")?.remove();
          let box = cell.querySelector<HTMLInputElement>(".aisf-check");
          if (!box) {
            const created = el("input", { type: "checkbox", class: "aisf-check" });
            created.addEventListener("click", (e) => {
              e.stopPropagation();
              // Resolve the row id at click time. AI Studio recycles <tr>
              // nodes as the list scrolls, so a captured id can outlive the
              // chat the checkbox was built for.
              const currentId = tr.dataset.aisfId;
              if (currentId) pick(tr, currentId, e.shiftKey, created.checked);
            });
            cell.prepend(created);
            box = created;
          }
          box.checked = selected.has(id);
        } else {
          cell.querySelector(".aisf-check")?.remove();
          let btn = cell.querySelector<HTMLButtonElement>(".aisf-rowbtn");
          if (!btn) {
            const created = el("button", {
              class: "aisf-rowbtn",
              title: "File in folder",
            });
            created.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              const currentId = tr.dataset.aisfId;
              if (currentId) folderPicker(created, [currentId]);
            });
            cell.prepend(created);
            btn = created;
          }
          const f = folderById(rec.f);
          const stateKey = f ? `f-${f.id}-${f.color}` : "unfiled";
          if (btn.dataset.aisfState !== stateKey) {
            btn.dataset.aisfState = stateKey;
            btn.textContent = "";
            btn.append(
              f
                ? el("span", {
                    class: "aisf-dot",
                    style: `background:${f.color}`,
                  })
                : icon("folder", 16),
            );
          }
        }
      }

      // No folder pill. Viewing a folder made every row repeat the same name,
      // and the rail already says which folder you are in. Any pill left over
      // from a previous version is cleared here.
      tr.querySelector(".aisf-pill")?.remove();

      // Drag mechanics
      if (!tr.dataset.aisfDrag) {
        tr.dataset.aisfDrag = "1";
        tr.setAttribute("draggable", "true");
        tr.addEventListener("dragstart", (e) => {
          const me = tr.dataset.aisfId;
          if (!me) return;
          const ids = selectMode && selected.has(me) ? Array.from(selected) : [me];
          dragIds = ids;
          // Explicit null check rather than the previous try/catch: the only
          // thing that threw here was a null dataTransfer.
          if (e.dataTransfer) {
            e.dataTransfer.setData("text/plain", ids.join(","));
            e.dataTransfer.effectAllowed = "move";
          }
          document.body.classList.add("aisf-dragging");
        });
        tr.addEventListener("dragend", () => {
          dragIds = null;
          document.body.classList.remove("aisf-dragging");
        });
        tr.querySelector("a.name-link")?.setAttribute("draggable", "false");
      }
    });

    applyFilter();

    refreshGlobalCounts();
  }

  /* ---------------------------------------------------------------- Filter */
  function applyFilter() {
    const showEverything = active === "all" || bypassFilter;
    const targetFamily =
      active !== "all" && active !== "unfiled" ? getDescendantFolderIds(active) : null;
    let matchCount = 0;

    rows().forEach((tr) => {
      const id = tr.dataset.aisfId;
      let show = true;
      if (!showEverything) {
        const f = id ? itemOf(id).f : null;
        if (active === "unfiled") {
          show = !f;
        } else {
          show = !!f && !!targetFamily && targetFamily.has(f);
        }
      }
      // Only write when it actually changes. tick() runs this every 1.5s over
      // every row, and an unconditional style write invalidates layout each
      // time even when nothing moved.
      const next = show ? "" : "none";
      if (tr.style.display !== next) tr.style.display = next;
      if (show) matchCount++;
    });

    handleEmptyState(matchCount);
  }

  function handleEmptyState(visibleCount: number) {
    const tbody = document.querySelector("table.library-table tbody");
    if (!tbody) return;

    let emptyRow = tbody.querySelector(".aisf-empty-row");
    if (visibleCount === 0 && active !== "all") {
      const f = folderById(active);
      const folderName = f ? getFolderPath(f.id) : "Unfiled";
      if (!emptyRow) {
        emptyRow = el(
          "tr",
          { class: "mat-mdc-row aisf-empty-row" },
          el(
            "td",
            { colspan: "10" },
            el(
              "div",
              {
                style: "text-align: center; padding: 64px 16px; color: var(--color-v3-text-var);",
              },
              el("p", { text: `No chats found in "${folderName}".` }),
              el(
                "button",
                {
                  class: "aisf-tool",
                  style:
                    "margin-top: 12px; border: 1px solid var(--color-v3-outline-var); padding: 8px 16px; border-radius: 8px; font-weight: 500;",
                  onclick: (e: Event) => loadAll(e.currentTarget as Element | null),
                },
                icon("loadall", 16),
                el("span", {
                  class: "aisf-lbl",
                  style: "margin-left: 8px;",
                  text: "Scan all history",
                }),
              ),
            ),
          ),
        );
        tbody.append(emptyRow);
      }
    } else {
      emptyRow?.remove();
    }
  }

  /* -------------------------------------------------------------- Loader */
  function findScroller(): HTMLElement {
    let node: HTMLElement | null = document.querySelector<HTMLElement>("table.library-table");
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 20)
        return node;
      node = node.parentElement;
    }
    return (document.scrollingElement as HTMLElement | null) || document.documentElement;
  }

  let loading = false;
  async function loadAll(btn: Element | null) {
    if (loading) return;
    loading = true;
    const label = btn?.querySelector(".aisf-lbl");
    const sc = findScroller();
    const home = sc.scrollTop;
    bypassFilter = true;
    applyFilter();

    let last = -1,
      stable = 0,
      guard = 0;
    while (stable < 4 && guard++ < 300) {
      const n = rows().length;
      if (label) label.textContent = `Scanning... (${n} found)`;
      if (n === last) stable++;
      else {
        stable = 0;
        last = n;
      }
      sc.scrollTop = sc.scrollHeight;
      await sleep(200);
    }

    sc.scrollTop = home;
    historyFullyLoaded = true;
    bypassFilter = false;
    if (label) label.textContent = "Scan all history";
    loading = false;
    decorate();
    render();
  }

  /* ---------------------------------------------------------- Multi-Select */
  function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) selected.clear();
    lastClicked = null;
    render();
    decorate();
    syncBulkBar();
  }

  function pick(tr: HTMLTableRowElement, id: string, shift: boolean, checked: boolean) {
    const list = visibleRows();
    const idx = list.indexOf(tr);
    if (shift && lastClicked !== null && lastClicked >= 0) {
      const [a, b] = [Math.min(lastClicked, idx), Math.max(lastClicked, idx)];
      list.slice(a, b + 1).forEach((r) => {
        const rid = r.dataset.aisfId;
        if (!rid) return;
        if (checked) selected.add(rid);
        else selected.delete(rid);
      });
    } else if (checked) {
      selected.add(id);
    } else {
      selected.delete(id);
    }
    lastClicked = idx;
    decorate();
    syncBulkBar();
  }

  /**
   * The floating action bar. Shown for the whole of select mode, not only once
   * something is ticked -- "Select all" has to be reachable from an empty
   * selection, which is exactly when you need it.
   */
  function syncBulkBar() {
    let bar = document.getElementById("aisf-bulk");
    if (!selectMode) {
      bar?.remove();
      return;
    }

    const visible = visibleRows();
    const has = selected.size > 0;

    if (!bar) {
      const act = (label: string, iconName: string, onclick: (e: Event) => void, cls = "") =>
        el(
          "button",
          { class: `aisf-tool${cls}`, onclick },
          icon(iconName, 16),
          el("span", { text: label, style: "margin-left:6px;" }),
        );

      bar = el(
        "div",
        { id: "aisf-bulk" },
        el("span", { class: "aisf-bulk-count" }),
        act("Select all", "check", () => {
          for (const tr of visibleRows()) {
            const id = tr.dataset.aisfId;
            if (id) selected.add(id);
          }
          decorate();
          syncBulkBar();
        }),
        act("Invert", "select", () => {
          for (const tr of visibleRows()) {
            const id = tr.dataset.aisfId;
            if (!id) continue;
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
          }
          decorate();
          syncBulkBar();
        }),
        el("span", { class: "aisf-bulk-sep" }),
        act(
          "Move to…",
          "folder",
          (e: Event) => folderPicker(e.currentTarget as Element, Array.from(selected)),
          " aisf-needs-sel",
        ),
        act("Unfile", "unfiled", () => assign(Array.from(selected), null), " aisf-needs-sel"),
        el(
          "button",
          {
            class: "aisf-tool",
            title: "Leave select mode",
            onclick: toggleSelectMode,
          },
          icon("close", 16),
        ),
      );
      document.body.append(bar);
    }

    const count = bar.querySelector(".aisf-bulk-count");
    // Say what a bulk action will actually hit: the visible rows, which the
    // active folder and filter have already narrowed.
    if (count) count.textContent = `${selected.size} of ${visible.length} selected`;

    for (const b of $$<HTMLButtonElement>(".aisf-needs-sel", bar)) {
      b.disabled = !has;
    }
  }

  /* --------------------------------------------------------------- Manager */
  function closeDialog() {
    document.querySelector(".aisf-overlay")?.remove();
  }

  function openManager() {
    closeDialog();
    const list = el("div", {});
    const paint = () => {
      list.textContent = "";
      if (!db.folders.length) {
        list.append(el("p", { class: "aisf-sub", text: "No folders yet." }));
      }
      db.folders.forEach((f) => {
        // The editable field is the only place the name belongs. A separate
        // path label repeated it verbatim for every root folder; where the
        // path does add something -- a nested folder -- it goes in the
        // tooltip instead of a second visible copy.
        const path = getFolderPath(f.id);
        const name = el("input", {
          type: "text",
          value: f.name,
          title: f.parentId ? path : "",
          "aria-label": `Folder name: ${path}`,
        });
        name.addEventListener("change", () => {
          f.name = name.value.trim().slice(0, 30) || f.name;
          save();
          render();
          decorate();
        });
        const color = el("input", { type: "color", value: f.color });
        color.addEventListener("change", () => {
          f.color = color.value;
          save();
          render();
          decorate();
        });
        list.append(
          el(
            "div",
            { class: "aisf-frow" },
            color,
            name,
            el("span", {
              style:
                "flex:0 0 65px; font-size:12px; color:var(--color-v3-text-disable); text-align:right;",
              text: `${countOf(f.id)} chats`,
            }),
            el(
              "button",
              {
                class: "aisf-tool",
                style: "color: var(--color-v3-accent-3);",
                onclick: () => {
                  if (window.confirm(`Are you sure you want to delete "${f.name}"?`)) {
                    deleteFolder(f.id);
                    paint();
                    render();
                    decorate();
                  }
                },
              },
              icon("trash", 16),
            ),
          ),
        );
      });
    };
    paint();

    const overlay = el(
      "div",
      {
        class: "aisf-overlay",
        onclick: (e: Event) => {
          if ((e.target as Element).classList.contains("aisf-overlay")) closeDialog();
        },
      },
      el(
        "div",
        { class: "aisf-dialog" },
        el("h2", { text: "Folder Manager" }),
        el("p", {
          class: "aisf-sub",
          text: "Hierarchies and assignments are stored locally in your browser.",
        }),
        list,
        el(
          "div",
          { class: "aisf-actions" },
          el(
            "button",
            { class: "aisf-tool", onclick: exportJson },
            icon("download", 16),
            el("span", { text: "Export Backup", style: "margin-left:6px;" }),
          ),
          el(
            "button",
            { class: "aisf-tool", onclick: () => importJson(paint) },
            icon("upload", 16),
            el("span", { text: "Import Backup", style: "margin-left:6px;" }),
          ),
          el(
            "button",
            {
              class: "aisf-tool",
              style: "margin-left: auto; background: var(--color-v3-surface-container-highest);",
              onclick: closeDialog,
            },
            el("span", { text: "Done" }),
          ),
        ),
      ),
    );
    document.body.append(overlay);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(db, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = el("a", {
      href: url,
      download: `ais-folders-hierarchy-${new Date().toISOString().slice(0, 10)}.json`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function importJson(after?: () => void) {
    const input = el("input", {
      type: "file",
      accept: "application/json",
      style: "display:none",
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!parsed || !Array.isArray(parsed.folders) || !parsed.items) throw new Error("Format");
          // `parsed.ui` is absent in backups taken before the tree state
          // existed; build it before touching `.collapsed`, or the throw lands
          // in the catch below and reports a valid file as corrupt.
          parsed.ui = parsed.ui || { active: "all", collapsed: {} };
          parsed.ui.collapsed = parsed.ui.collapsed || {};
          pruneItems(parsed);
          db = parsed;
          active = db.ui.active || "all";
          save();
          after?.();
          render();
          decorate();
        } catch {
          window.alert("Invalid folder backup file.");
        }
      };
      reader.readAsText(file);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  /* ------------------------------------------------------------- Lifecycle */
  function throttle(fn: () => void, ms: number) {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      const now = Date.now();
      if (now - last > ms) {
        last = now;
        fn();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn();
        }, ms);
      }
    };
  }

  let observer: MutationObserver | null = null;
  function tick() {
    // Detach before touching the DOM. injectStyle, ensureSidebar and decorate
    // all write to the page, and an attached observer turns each of those
    // writes into another tick -- a self-sustaining 5Hz churn loop (the
    // throttle paces it, it never settles). The finally guarantees we
    // re-attach on the early return and on a thrown decorate.
    observer?.disconnect();
    try {
      injectStyle();
      if (!ensureSidebar()) return;
      decorate();
    } catch (e) {
      console.warn("[AIS Folders]", e);
    } finally {
      observer?.observe(document.body, { childList: true, subtree: true });
    }
  }

  const scheduled = throttle(tick, 200);
  observer = new MutationObserver(scheduled);
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(tick, 1500);

  document.addEventListener(
    "mousedown",
    (e) => {
      const m = document.querySelector(".aisf-menu");
      if (m && !m.contains(e.target as Node | null)) closeMenus();
    },
    true,
  );

  // Escape closes whatever is open. This is the only key handling left --
  // tree navigation and the file/unfile shortcuts were removed as unused.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMenus();
      closeDialog();
    }
  });

  tick();
})();
