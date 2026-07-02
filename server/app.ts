/**
 * Akasha HTTP app factory, shared by the CLI server (server/index.ts) and
 * the Electron desktop app (desktop/main.ts).
 *
 * Public API routes (all localhost-only):
 *   GET /api/graph        - Returns the scanned graph.json metadata + topology
 *   GET /api/layout       - Cached node positions from previous session (optional)
 *   POST /api/layout      - Persist settled node positions for fast boot
 *   GET /api/note?id=...  - Reads raw markdown of one note from vault
 *   GET /api/search?q=... - Full-text search with fuzzy matching
 *   POST /api/rescan      - Trigger incremental rescan (hot-swap graph + reload frontend)
 *
 * Security:
 *   - All routes listen on 127.0.0.1 only (not exposed to network)
 *   - Note reads are confined to vault root (no directory traversal)
 *   - Vault data is never copied or uploaded; reads are live
 */

import express from "express";
import MiniSearch from "minisearch";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { scanVault } from "../scanner/scan.js";
import {
  loadConfig,
  updateConfig,
  defaultConfigPath,
} from "./integrations/config.js";
import {
  detectAll,
  realRunner,
  type DetectDeps,
  type ToolName,
  type ToolStatus,
} from "./integrations/detect.js";
import {
  coveringCollections,
  createQmdSetup,
  hitsToNodes,
  listCollections,
  vsearch,
  type QmdCollection,
} from "./integrations/qmd.js";
import {
  createExaAdapter,
  type ExaAdapterOptions,
} from "./integrations/exa.js";
import {
  createSessionToken,
  localOnly,
  requireToken,
} from "./integrations/security.js";
import { computeGaps } from "./integrations/topology.js";

interface GraphFile {
  meta: {
    vaultName: string;
    vaultPath: string;
    notes: number;
    excludes: string[];
  };
  nodes: Array<{
    id: string;
    title: string;
    phantom?: boolean;
    pillar?: string;
    words?: number;
    in: number;
    out: number;
  }>;
  links: Array<{ source: string; target: string; weight?: number }>;
}

export interface AkashaApp {
  app: express.Express;
  /** Re-read graph.json (after a rescan / vault switch). */
  reload(): void;
  meta(): GraphFile["meta"];
}

export interface IntegrationsOptions {
  /** Override ~/.solaris/config.json (tests). */
  configPath?: string;
  /** Inject detection deps so tests never probe real binaries. */
  detectDeps?: Partial<DetectDeps>;
  /** Inject a fake Exa client / fast retry backoff (tests). */
  exa?: ExaAdapterOptions;
}

export function createApp(
  graphPath: string,
  staticDir?: string,
  integrations?: IntegrationsOptions,
): AkashaApp {
  let graph: GraphFile;
  try {
    graph = JSON.parse(readFileSync(graphPath, "utf-8"));
  } catch (e) {
    throw new Error(
      `Failed to load graph at ${graphPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let vaultRoot: string = graph.meta.vaultPath;

  const app = express();

  // KTD12: reject foreign Host/Origin (DNS rebinding / CSRF) on every route.
  app.use(localOnly);

  // Per-session token for mutating/spending routes, fetched by the app page.
  const sessionToken = createSessionToken();
  const guarded = requireToken(sessionToken);
  app.get("/api/session", (_req, res) => {
    res.json({ token: sessionToken });
  });

  const configPath = integrations?.configPath ?? defaultConfigPath();
  const detectDeps = integrations?.detectDeps;

  // Detection is slow-ish (may spawn a login shell); cache in memory,
  // re-probe on ?refresh=1 (settings re-check).
  let toolCache: Record<ToolName, ToolStatus> | null = null;

  // GET /api/integrations: per-tool state + config booleans, never key material.
  app.get("/api/integrations", async (req, res) => {
    try {
      if (!toolCache || req.query.refresh === "1")
        toolCache = await detectAll(detectDeps);
      const cfg = loadConfig(configPath);
      res.json({
        tools: {
          qmd: toolCache.qmd,
          // connected: OpenCode account status, wired by the agent bridge (U9)
          opencode: { ...toolCache.opencode, connected: null },
          exa: { configured: !!cfg.exaKey },
        },
        consents: cfg.consents,
        agentMode: cfg.agentMode,
        defaultModel: cfg.defaultModel,
        writeDestination: cfg.writeDestination,
      });
    } catch (e) {
      console.error("Integrations status failed:", e);
      res.status(500).json({ error: "integrations status failed" });
    }
  });

  // POST /api/integrations/config: save key/consents/mode. Token-guarded.
  app.post("/api/integrations/config", guarded, express.json(), (req, res) => {
    try {
      const cfg = updateConfig(req.body ?? {}, configPath);
      res.json({
        ok: true,
        consents: cfg.consents,
        agentMode: cfg.agentMode,
        defaultModel: cfg.defaultModel,
        writeDestination: cfg.writeDestination,
        exaConfigured: !!cfg.exaKey,
      });
    } catch (e) {
      console.error("Config update failed:", e);
      res.status(500).json({ error: "config update failed" });
    }
  });

  // ---- Semantic mode: qmd bridge (U3) ----
  const qmdRun = integrations?.detectDeps?.run ?? realRunner;
  const qmdSetup = createQmdSetup(qmdRun);

  // qmd binary path via the detection cache (GUI launches lack ~/.bun/bin on PATH).
  async function qmdBin(): Promise<string | null> {
    if (!toolCache) toolCache = await detectAll(detectDeps);
    return toolCache.qmd.installed ? toolCache.qmd.path : null;
  }

  // Collection list spawns one qmd process per collection; cache briefly.
  let colCache: { at: number; cols: QmdCollection[] } | null = null;
  async function collections(bin: string): Promise<QmdCollection[]> {
    if (!colCache || Date.now() - colCache.at > 60_000) {
      colCache = { at: Date.now(), cols: await listCollections(qmdRun, bin) };
    }
    return colCache.cols;
  }

  // Shared by /api/related and /api/semantic-search: run vsearch, keep only
  // in-graph nodes (R5), honor the enabled-collections filter (R8).
  async function semanticQuery(
    queryText: string,
    collectionsParam: unknown,
  ): Promise<{ status: number; body: object }> {
    const bin = await qmdBin();
    if (!bin) return { status: 503, body: { error: "qmd not installed" } };
    if (qmdSetup.state() === "indexing")
      return { status: 200, body: { state: "indexing", results: [] } };
    if (qmdSetup.state() === "ready") colCache = null; // pick up the new collection once
    const covering = coveringCollections(await collections(bin), vaultRoot);
    if (!covering.length)
      return { status: 200, body: { state: "uncovered", results: [] } };
    const enabled =
      typeof collectionsParam === "string" && collectionsParam
        ? new Set(collectionsParam.split(",").filter(Boolean))
        : undefined;
    const hits = await vsearch(qmdRun, bin, queryText, 20);
    const nodeTitles = new Map(
      graph.nodes.filter((n) => !n.phantom).map((n) => [n.id, n.title]),
    );
    const results = hitsToNodes(hits, covering, vaultRoot, nodeTitles, enabled);
    return { status: 200, body: { state: "ready", results } };
  }

  // GET /api/qmd/status: missing | uncovered | indexing | error | ready(+collections)
  app.get("/api/qmd/status", async (_req, res) => {
    try {
      const bin = await qmdBin();
      if (!bin) {
        res.json({ state: "missing" });
        return;
      }
      if (qmdSetup.state() === "indexing") {
        res.json({ state: "indexing" });
        return;
      }
      if (qmdSetup.state() === "error") {
        res.json({ state: "error", error: qmdSetup.error() });
        return;
      }
      if (qmdSetup.state() === "ready") colCache = null;
      const covering = coveringCollections(await collections(bin), vaultRoot);
      res.json(
        covering.length
          ? { state: "ready", collections: covering.map((c) => c.name) }
          : { state: "uncovered" },
      );
    } catch (e) {
      console.error("qmd status failed:", e);
      res.status(500).json({ error: "qmd status failed" });
    }
  });

  // POST /api/qmd/setup: create + index a collection for this vault (R6),
  // reusing existing coverage instead of duplicating (R7). Token-guarded.
  app.post("/api/qmd/setup", guarded, async (_req, res) => {
    try {
      const bin = await qmdBin();
      if (!bin) {
        res.status(503).json({ error: "qmd not installed" });
        return;
      }
      const covering = coveringCollections(await collections(bin), vaultRoot);
      if (covering.length) {
        res.json({
          ok: true,
          state: "ready",
          reused: covering.map((c) => c.name),
        });
        return;
      }
      qmdSetup.start(bin, vaultRoot);
      res.json({ ok: true, state: "indexing" });
    } catch (e) {
      console.error("qmd setup failed:", e);
      res.status(500).json({ error: "qmd setup failed" });
    }
  });

  // GET /api/related?id=...: notes semantically related to one note (R4/R5),
  // queried with the note's title + an excerpt of its body.
  app.get("/api/related", async (req, res) => {
    try {
      const id = String(req.query.id ?? "");
      if (!id || id.startsWith("phantom:")) {
        res.status(404).json({ error: "note not found" });
        return;
      }
      const full = resolve(vaultRoot, id);
      if (
        !full.startsWith(resolve(vaultRoot) + sep) ||
        !full.toLowerCase().endsWith(".md")
      ) {
        res.status(400).json({ error: "invalid note id" });
        return;
      }
      if (!existsSync(full)) {
        res.status(404).json({ error: "note not found" });
        return;
      }
      const text = readFileSync(full, "utf-8");
      const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
      const title = graph.nodes.find((n) => n.id === id)?.title ?? "";
      const r = await semanticQuery(
        `${title}\n${body.slice(0, 600)}`,
        req.query.collections,
      );
      const b = r.body as { results?: Array<{ id: string }> };
      if (b.results)
        b.results = b.results.filter((n) => n.id !== id).slice(0, 8);
      res.status(r.status).json(r.body);
    } catch (e) {
      console.error("related failed:", e);
      res.status(500).json({ error: "related failed" });
    }
  });

  // GET /api/semantic-search?q=...: qmd-powered search mapped to graph nodes (R9).
  app.get("/api/semantic-search", async (req, res) => {
    try {
      const q = String(req.query.q ?? "").trim();
      if (!q) {
        res.json({ state: "ready", results: [] });
        return;
      }
      const r = await semanticQuery(q, req.query.collections);
      res.status(r.status).json(r.body);
    } catch (e) {
      console.error("semantic search failed:", e);
      res.status(500).json({ error: "semantic search failed" });
    }
  });

  // ---- Web mode: Exa research proxy (U6) ----
  const exaResearch = createExaAdapter(integrations?.exa);

  // POST /api/research: spend-bearing, so token-guarded (KTD12). Rejects
  // without stored Web-mode consent (R18) before any outbound call, and
  // without a configured key (AE5). The key never appears in any response.
  app.post("/api/research", guarded, express.json(), async (req, res) => {
    try {
      const cfg = loadConfig(configPath);
      if (!cfg.consents.web) {
        res.status(403).json({
          error: "web-consent-required",
          message:
            "Web mode needs your one-time consent first (activate Web mode to review it).",
        });
        return;
      }
      if (!cfg.exaKey) {
        res.status(400).json({
          error: "no-exa-key",
          message: "Add your Exa API key in Settings → Integrations.",
        });
        return;
      }
      const query = String(req.body?.query ?? "").trim();
      if (!query) {
        res
          .status(400)
          .json({
            error: "empty-query",
            message: "Type or pick a query first.",
          });
        return;
      }
      const results = await exaResearch(cfg.exaKey, query, {
        deep: !!req.body?.deep,
      });
      res.json({ results });
    } catch (e) {
      console.error("research failed:", e instanceof Error ? e.message : e);
      res.status(502).json({
        error: "research-failed",
        message:
          "Exa request failed after retries. Check your key and try again.",
      });
    }
  });

  // GET /api/gaps: topology-derived gap suggestions (U5) for Web-mode
  // queries (R10) and agent context (R15). Computed per request from the
  // live graph, so a rescan/reload is picked up automatically.
  app.get("/api/gaps", (_req, res) => {
    try {
      res.json(computeGaps(graph.nodes, graph.links ?? []));
    } catch (e) {
      console.error("gaps failed:", e);
      res.status(500).json({ error: "gaps failed" });
    }
  });

  // GET /api/graph: Return the complete knowledge graph (metadata + nodes + links)
  // Used by frontend to initialize the 3D visualization
  app.get("/api/graph", (_req, res) => {
    res.sendFile(graphPath, { dotfiles: "allow" });
  });

  // Layout cache lives beside graph.json
  const layoutPath = resolve(dirname(graphPath), "layout.json");

  // GET /api/layout: Retrieve cached node positions from previous session
  // Allows hot-restart without re-running physics simulation (fast boot)
  // Keyed by graph fingerprint; if vault changed, cache is invalidated
  app.get("/api/layout", (_req, res) => {
    if (!existsSync(layoutPath)) {
      res.status(404).json({ error: "no cached layout" });
      return;
    }
    res.sendFile(layoutPath, { dotfiles: "allow" });
  });

  // POST /api/layout: Persist settled node positions for fast subsequent boots
  // Frontend posts positions after physics simulation stabilizes
  app.post("/api/layout", express.json({ limit: "20mb" }), (req, res) => {
    try {
      writeFileSync(layoutPath, JSON.stringify(req.body));
      res.json({ ok: true });
    } catch (e) {
      console.error("Failed to save layout:", e);
      res.status(500).json({ error: "save failed" });
    }
  });

  // GET /api/note?id=...: Retrieve raw markdown of a single note
  // id should be a vault-relative path (e.g., "folder/file" or "file.md")
  // Security: Validates that the path stays within vault root (no traversal)
  app.get("/api/note", (req, res) => {
    const id = String(req.query.id ?? "");

    // Reject phantom nodes (unwritten link targets) and empty ids
    if (!id || id.startsWith("phantom:")) {
      res.status(404).json({ error: "note not found" });
      return;
    }

    // Construct full path and validate it stays within vault
    const full = resolve(vaultRoot, id);
    const vaultBase = resolve(vaultRoot) + sep;

    // Security check: prevent directory traversal attacks
    if (!full.startsWith(vaultBase) || !full.toLowerCase().endsWith(".md")) {
      res.status(400).json({ error: "invalid note id" });
      return;
    }

    // Check file exists
    if (!existsSync(full)) {
      res.status(404).json({ error: "note not found" });
      return;
    }

    // Return the note's raw markdown content
    try {
      res.json({ id, markdown: readFileSync(full, "utf-8") });
    } catch (e) {
      console.error(`Failed to read note ${id}:`, e);
      res.status(500).json({ error: "read failed" });
    }
  });

  // Full-text index over note content (titles boosted). Built lazily on the
  // first search (~1-2s for ~2k notes), held in memory, invalidated by
  // reload(). Contents stay in local memory for snippet extraction.
  let index: MiniSearch | null = null;
  let contents = new Map<string, string>();

  function buildIndex() {
    const ms = new MiniSearch({
      fields: ["title", "content"],
      storeFields: ["title"],
      searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.15 },
    });
    contents = new Map();
    const docs = [];
    for (const n of graph.nodes) {
      if (n.phantom) continue;
      try {
        const text = readFileSync(resolve(vaultRoot, n.id), "utf-8");
        contents.set(n.id, text);
        docs.push({ id: n.id, title: n.title, content: text });
      } catch {
        // file moved/deleted since scan; skip it
      }
    }
    ms.addAll(docs);
    return ms;
  }

  function snippet(id: string, terms: string[]): string {
    const text = contents.get(id) ?? "";
    const lower = text.toLowerCase();
    for (const t of terms) {
      const at = lower.indexOf(t.toLowerCase());
      if (at >= 0) {
        const start = Math.max(0, at - 50);
        const end = Math.min(text.length, at + t.length + 70);
        return (
          (start > 0 ? "…" : "") +
          text.slice(start, end).replace(/\s+/g, " ").trim() +
          (end < text.length ? "…" : "")
        );
      }
    }
    return "";
  }

  // GET /api/search?q=...: Full-text search over note titles and content
  // Returns top 20 matches sorted by relevance score with text snippets
  // Search is fuzzy (typo-tolerant) with title boost (3x weight)
  // Lazy-built on first search; invalidated by rescan
  app.get("/api/search", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.json([]);
      return;
    }

    try {
      // Lazily build full-text index on first search
      index ??= buildIndex();
      const hits = index
        .search(q)
        .slice(0, 20)
        .map((h) => ({
          id: h.id as string,
          title: h.title as string,
          score: h.score,
          snippet: snippet(h.id as string, h.terms),
        }));
      res.json(hits);
    } catch (e) {
      console.error("Search error:", e);
      res.status(500).json({ error: "search failed" });
    }
  });

  const reload = () => {
    graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    vaultRoot = graph.meta.vaultPath;
    index = null; // rebuilt lazily against the new scan
    contents.clear();
  };

  // POST /api/rescan: Trigger incremental rescan of the vault
  // Re-parses files that have changed (by mtime+size), hot-swaps the graph,
  // and sends stats back to frontend for UI update.
  // Query param ?full=true forces a cold scan (ignores cache)
  app.post("/api/rescan", (req, res) => {
    try {
      const g = scanVault({
        vault: graph.meta.vaultPath,
        out: graphPath,
        exclude: graph.meta.excludes ?? [],
        full: req.query.full === "true",
      });
      reload();
      res.json({
        ok: true,
        notes: g.meta.notes,
        links: g.meta.links,
        stats: g.meta.scanStats,
      });
    } catch (e) {
      console.error("Rescan failed:", e);
      res.status(500).json({
        error: "rescan failed",
        details: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // dev instrumentation: the frontend posts measured FPS here (?fpsreport=1)
  app.post("/api/fpslog", express.json(), (req, res) => {
    console.log("FPSLOG", JSON.stringify(req.body));
    res.json({ ok: true });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
  }

  return { app, reload, meta: () => graph.meta };
}
