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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  type QmdHit,
} from "./integrations/qmd.js";
import {
  createQmdMaintenance,
  qmdIndexStatus,
  type QmdIndexStatus,
} from "./integrations/qmd-maintenance.js";
import { createQmdMcp, type QmdMcpDeps } from "./integrations/qmd-mcp.js";
import {
  createExaAdapter,
  type ExaAdapterOptions,
} from "./integrations/exa.js";
import { ingestBytes, ingestDocument } from "./integrations/ingest.js";
import {
  clearEntries,
  deleteEntry,
  listEntries,
  saveEntry,
} from "./integrations/research-history.js";
import {
  clearReaderHistory,
  listReaderOpens,
  logReaderOpen,
} from "./integrations/reader-history.js";
import { installAddons, type InstallableTool } from "./integrations/install.js";
import {
  chatCompletion,
  DEFAULT_MODEL,
  listModels,
  OpenRouterError,
  validateKey,
  type OpenRouterOptions,
} from "./integrations/openrouter.js";
import {
  createSessionToken,
  localOnly,
  requireToken,
} from "./integrations/security.js";
import { computeGaps, noteQuestions } from "./integrations/topology.js";
import {
  guardedCreate,
  guardedEdit,
  WriteError,
} from "./integrations/write.js";

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
  /** Inject a fake fetch for the OpenRouter adapter (tests). */
  openrouter?: OpenRouterOptions;
  /** Inject a fake stdio child for the warm qmd client (tests). */
  qmdMcp?: Partial<QmdMcpDeps>;
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
  const dataDir = dirname(graphPath); // data/ — runtime store (history, journal)

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
          markitdown: toolCache.markitdown,
          exa: { configured: !!cfg.exaKey },
          openrouter: { configured: !!cfg.openrouterKey },
        },
        consents: cfg.consents,
        defaultModel: cfg.defaultModel,
        embedModel: cfg.embedModel,
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
        defaultModel: cfg.defaultModel,
        embedModel: cfg.embedModel,
        writeDestination: cfg.writeDestination,
        exaConfigured: !!cfg.exaKey,
      });
    } catch (e) {
      console.error("Config update failed:", e);
      res.status(500).json({ error: "config update failed" });
    }
  });

  // POST /api/integrations/install: the addons flavor (U12). Checks
  // existing installs first and never touches them (R16/AE7). Token-guarded
  // (installs software). Detection cache is invalidated afterwards.
  app.post(
    "/api/integrations/install",
    guarded,
    express.json(),
    async (req, res) => {
      try {
        const b = (req.body ?? {}) as { tools?: unknown };
        const tools = Array.isArray(b.tools)
          ? (b.tools.filter(
              (t) => t === "qmd" || t === "markitdown",
            ) as InstallableTool[])
          : undefined;
        const results = await installAddons(detectDeps ?? {}, tools);
        toolCache = null; // re-probe on next status call
        res.json({ results });
      } catch (e) {
        console.error("addons install failed:", e);
        res.status(500).json({ error: "install failed" });
      }
    },
  );

  // POST /api/ingest: convert a document or URL to a Markdown note via
  // markitdown (F023). Reads may come from anywhere (importing is the
  // point); the write goes through the guarded path into the vault.
  app.post("/api/ingest", guarded, express.json(), async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.source !== "string" || !b.source.trim()) {
        res.status(400).json({ error: "source (file path or URL) required" });
        return;
      }
      if (!toolCache) toolCache = await detectAll(detectDeps);
      if (!toolCache.markitdown.installed || !toolCache.markitdown.path) {
        res.status(503).json({
          error: "markitdown-missing",
          message:
            "markitdown is not installed — Tools → Integrations offers the install.",
        });
        return;
      }
      const cfg = loadConfig(configPath);
      const r = await ingestDocument(
        integrations?.detectDeps?.run ?? realRunner,
        toolCache.markitdown.path,
        { vaultRoot, dataDir: dirname(graphPath) },
        {
          source: b.source,
          title: typeof b.title === "string" ? b.title : undefined,
          destination: cfg.writeDestination,
        },
      );
      res.json({ ok: true, id: r.id });
    } catch (e) {
      writeFail(res, e, "ingest");
    }
  });

  // POST /api/ingest-upload: convert an uploaded file to a Markdown note via
  // markitdown (F023). Browsers can't expose real file paths, so the bytes
  // ride in the body and the filename comes from ?name=. Token-guarded.
  app.post(
    "/api/ingest-upload",
    guarded,
    express.raw({ type: "*/*", limit: "50mb" }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
          res.status(400).json({ error: "file body required" });
          return;
        }
        if (!toolCache) toolCache = await detectAll(detectDeps);
        if (!toolCache.markitdown.installed || !toolCache.markitdown.path) {
          res.status(503).json({
            error: "markitdown-missing",
            message:
              "markitdown is not installed — Tools → Integrations offers the install.",
          });
          return;
        }
        const name =
          typeof req.query.name === "string" ? req.query.name : "upload";
        const cfg = loadConfig(configPath);
        const r = await ingestBytes(
          integrations?.detectDeps?.run ?? realRunner,
          toolCache.markitdown.path,
          { vaultRoot, dataDir: dirname(graphPath) },
          { name, bytes: req.body },
        );
        res.json({ ok: true, id: r.id });
      } catch (e) {
        writeFail(res, e, "ingest-upload");
      }
    },
  );

  // ---- Semantic mode: qmd bridge (U3) ----
  const qmdRun = integrations?.detectDeps?.run ?? realRunner;
  const qmdSetup = createQmdSetup(qmdRun);
  const qmdMaint = createQmdMaintenance(qmdRun);
  // Short cache so rapid progress polls don't spawn a `qmd status` each time.
  let maintIdxCache: { at: number; index: QmdIndexStatus | null } | null = null;

  // qmd binary path via the detection cache (GUI launches lack ~/.bun/bin on PATH).
  async function qmdBin(): Promise<string | null> {
    if (!toolCache) toolCache = await detectAll(detectDeps);
    return toolCache.qmd.installed ? toolCache.qmd.path : null;
  }

  // Collection list spawns one qmd process per collection; cache briefly.
  let colCache: { at: number; cols: QmdCollection[] } | null = null;
  // Per-note related-notes cache (F015); invalidated by reload().
  const relatedCache = new Map<string, object>();
  async function collections(bin: string): Promise<QmdCollection[]> {
    if (!colCache || Date.now() - colCache.at > 60_000) {
      colCache = { at: Date.now(), cols: await listCollections(qmdRun, bin) };
    }
    return colCache.cols;
  }

  // Warm qmd child (F015): model + index load once; per-query cost ~0.2s.
  // Any failure falls back to the per-spawn CLI path transparently.
  const qmdMcp = createQmdMcp(integrations?.qmdMcp);

  async function qmdSearch(
    bin: string,
    queryText: string,
    limit: number,
    scopeNames: string[] | undefined,
  ): Promise<QmdHit[]> {
    try {
      return await qmdMcp.vquery(bin, queryText, limit, scopeNames);
    } catch (e) {
      console.warn(
        "qmd mcp unavailable, falling back to CLI spawn:",
        e instanceof Error ? e.message : e,
      );
      return vsearch(qmdRun, bin, queryText, limit);
    }
  }

  // Shared by /api/related and /api/semantic-search: run the warm vector
  // query, keep only in-graph nodes (R5), honor the collections filter (R8).
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
    // Narrow at the source: only covering (and enabled) collections.
    const scopeNames = covering
      .map((c) => c.name)
      .filter((n) => !enabled || enabled.has(n));
    const hits = await qmdSearch(bin, queryText, 20, scopeNames);
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

  // GET /api/qmd/maintenance: index freshness + whether an update/embed job runs.
  // The client polls this to drive the progress bar (Pending shrinks as embed runs).
  app.get("/api/qmd/maintenance", async (_req, res) => {
    const bin = await qmdBin();
    if (!bin) {
      res.json({ available: false });
      return;
    }
    if (!maintIdxCache || Date.now() - maintIdxCache.at > 1000) {
      maintIdxCache = {
        at: Date.now(),
        index: await qmdIndexStatus(qmdRun, bin),
      };
    }
    res.json({
      available: true,
      running: qmdMaint.running(),
      op: qmdMaint.op(),
      error: qmdMaint.error() || undefined,
      index: maintIdxCache.index,
    });
  });

  // POST /api/qmd/maintenance?update=1&embed=1: start a background update/embed
  // (A) — user-controlled index refresh. Token-guarded (CPU-spending). 409 if
  // one is already running.
  app.post("/api/qmd/maintenance", guarded, async (req, res) => {
    const bin = await qmdBin();
    if (!bin) {
      res.status(503).json({ error: "qmd not installed" });
      return;
    }
    const flag = (v: unknown) => v === "1" || v === "true";
    // embed uses the configured model; force (-f) rebuilds all vectors after a
    // model switch so dimensions don't get mixed.
    const started = qmdMaint.start(
      bin,
      { update: flag(req.query.update), embed: flag(req.query.embed) },
      {
        embedModel: loadConfig(configPath).embedModel,
        force: flag(req.query.force),
      },
    );
    if (!started) {
      res.status(qmdMaint.running() ? 409 : 400).json({
        error: qmdMaint.running() ? "already running" : "nothing to do",
      });
      return;
    }
    maintIdxCache = null; // reflect the fresh job on the next poll
    res.json({ ok: true, running: true });
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
      // Per-note cache (F015): keyed by content mtime + collections filter;
      // cleared on reload()/rescan. Repeat opens of a note are instant.
      const colParam =
        typeof req.query.collections === "string" ? req.query.collections : "";
      const cacheKey = `${id}|${statSync(full).mtimeMs}|${colParam}`;
      const cached = relatedCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }
      const text = readFileSync(full, "utf-8");
      const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
      const title = graph.nodes.find((n) => n.id === id)?.title ?? "";
      const r = await semanticQuery(
        `${title}\n${body.slice(0, 600)}`,
        req.query.collections,
      );
      const b = r.body as { state?: string; results?: Array<{ id: string }> };
      if (b.results)
        b.results = b.results.filter((n) => n.id !== id).slice(0, 8);
      if (r.status === 200 && b.state === "ready") {
        if (relatedCache.size > 500) relatedCache.clear(); // ponytail: crude cap; LRU if it matters
        relatedCache.set(cacheKey, r.body);
      }
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
      const results = (r.body as { results?: unknown[] }).results;
      const historyId =
        r.status === 200 && Array.isArray(results) && results.length
          ? saveEntry(dataDir, { mode: "semantic", query: q, results }).id
          : undefined;
      res.status(r.status).json({ ...r.body, historyId });
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
          message: "Add your Exa API key in Tools → Integrations.",
        });
        return;
      }
      const query = String(req.body?.query ?? "").trim();
      if (!query) {
        res.status(400).json({
          error: "empty-query",
          message: "Type or pick a query first.",
        });
        return;
      }
      const r = await exaResearch(cfg.exaKey, query, {
        deep: !!req.body?.deep,
      });
      const historyId =
        r.results.length || r.answer
          ? saveEntry(dataDir, {
              mode: "web",
              query,
              answer: r.answer,
              results: r.results,
            }).id
          : undefined;
      res.json({ results: r.results, answer: r.answer, historyId });
    } catch (e) {
      console.error("research failed:", e instanceof Error ? e.message : e);
      res.status(502).json({
        error: "research-failed",
        message:
          "Exa request failed after retries. Check your key and try again.",
      });
    }
  });

  // ---- Research history (app-local, data/research/): page past results,
  // curate into the vault, trash one, or clear all. Never in the vault/graph. ----
  app.get("/api/research/history", (_req, res) => {
    res.json({ entries: listEntries(dataDir) });
  });
  app.delete("/api/research/history", guarded, (_req, res) => {
    res.json({ cleared: clearEntries(dataDir) });
  });
  app.delete("/api/research/history/:id", guarded, (req, res) => {
    const ok = deleteEntry(dataDir, String(req.params.id));
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Reader (content-panel) history: ordered log of opened notes, app-local.
  app.get("/api/reader-history", (_req, res) => {
    res.json({ entries: listReaderOpens(dataDir) });
  });
  app.delete("/api/reader-history", guarded, (_req, res) => {
    clearReaderHistory(dataDir);
    res.json({ ok: true });
  });

  // ---- Guarded vault writes (U7): the single sanctioned write path ----
  const writeDeps = () => ({ vaultRoot, dataDir: dirname(graphPath) });
  const writeFail = (res: express.Response, e: unknown, what: string) => {
    if (e instanceof WriteError) {
      res.status(e.status).json({ error: e.message });
    } else {
      console.error(`${what} failed:`, e);
      res.status(500).json({ error: `${what} failed` });
    }
  };

  // POST /api/notes: create a note (save-as-note, approved agent creates).
  // Defaults to the configured destination (inbox/); never overwrites.
  app.post(
    "/api/notes",
    guarded,
    express.json({ limit: "5mb" }),
    (req, res) => {
      try {
        const { title, path, content, destination } = (req.body ??
          {}) as Record<string, unknown>;
        if (
          typeof content !== "string" ||
          (typeof title !== "string" && typeof path !== "string")
        ) {
          res
            .status(400)
            .json({ error: "content plus title or path required" });
          return;
        }
        const cfg = loadConfig(configPath);
        const r = guardedCreate(writeDeps(), {
          content,
          path: typeof path === "string" ? path : undefined,
          title: typeof title === "string" ? title : undefined,
          destination:
            typeof destination === "string"
              ? destination
              : cfg.writeDestination,
          actor: "user",
        });
        res.json({ ok: true, id: r.id });
      } catch (e) {
        writeFail(res, e, "create");
      }
    },
  );

  // PUT /api/notes: full-content edit of an existing note.
  app.put("/api/notes", guarded, express.json({ limit: "5mb" }), (req, res) => {
    try {
      const { id, content } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof id !== "string" || typeof content !== "string") {
        res.status(400).json({ error: "id and content required" });
        return;
      }
      const r = guardedEdit(writeDeps(), { id, content, actor: "user" });
      res.json({ ok: true, id: r.id });
    } catch (e) {
      writeFail(res, e, "edit");
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

  // GET /api/llm/models: server-side proxy to OpenRouter's model list so
  // the key never reaches the client. A listing is a free read (no credit).
  app.get("/api/llm/models", async (_req, res) => {
    const cfg = loadConfig(configPath);
    if (!cfg.openrouterKey) {
      res.status(400).json({ error: "no-openrouter-key" });
      return;
    }
    try {
      const models = await listModels(
        cfg.openrouterKey,
        integrations?.openrouter,
      );
      res.json({ models, current: cfg.defaultModel });
    } catch (e) {
      const status = e instanceof OpenRouterError ? e.status : 502;
      res.status(status).json({ error: "models-fetch-failed" });
    }
  });

  // GET /api/integrations/test/openrouter: validate the stored key for FREE
  // (GET /key — no completion charged), returning credit usage/limit. Exa has
  // no equivalent free check, so it is deliberately not auto-tested.
  app.get("/api/integrations/test/openrouter", async (_req, res) => {
    const cfg = loadConfig(configPath);
    if (!cfg.openrouterKey) {
      res.json({ configured: false });
      return;
    }
    try {
      const status = await validateKey(
        cfg.openrouterKey,
        integrations?.openrouter,
      );
      res.json({ configured: true, ...status });
    } catch {
      res.json({ configured: true, ok: false, unreachable: true });
    }
  });

  // GET /api/note-questions?id=: 3-5 research questions derived from one
  // note. LLM-generated via OpenRouter when a key + model are configured
  // (F021); otherwise the local templates (F019). Note content leaves the
  // machine only toward the configured provider, behind the stored key.
  app.get("/api/note-questions", async (req, res) => {
    const id = String(req.query.id ?? "");
    const templates = () => noteQuestions(graph.nodes, graph.links ?? [], id);
    const cfg = loadConfig(configPath);
    // The key alone enables the LLM; the model falls back to DEFAULT_MODEL
    // when the user hasn't picked one, so it works right after key entry.
    if (!cfg.openrouterKey) {
      res.json({ questions: templates(), source: "templates" });
      return;
    }
    const full = resolve(vaultRoot, id);
    if (
      !full.startsWith(resolve(vaultRoot) + sep) ||
      !full.toLowerCase().endsWith(".md") ||
      !existsSync(full)
    ) {
      res.json({ questions: templates(), source: "templates" });
      return;
    }
    const note = graph.nodes.find((n) => n.id === id);
    const excerpt = readFileSync(full, "utf-8")
      .replace(/^---\n[\s\S]*?\n---\n?/, "")
      .slice(0, 1500);
    const phantoms = (graph.links ?? [])
      .filter((l) => l.source === id)
      .map((l) => graph.nodes.find((n) => n.id === l.target))
      .filter((n) => n?.phantom)
      .map((n) => n!.title)
      .slice(0, 8);
    const prompt = [
      "Generate 3-5 web-research questions that would close the knowledge gaps around this note from my knowledge vault.",
      "Focus on what is missing, unresolved, or worth investigating further — not on summarizing what the note already covers.",
      phantoms.length
        ? `The note references these topics that have no note of their own yet: ${phantoms.join(", ")}.`
        : "",
      `Note title: ${note?.title ?? id}`,
      `Note content (excerpt):\n${excerpt}`,
      "Write the questions in the same language as the note content.",
      'Reply with ONLY a JSON array of question strings, e.g. ["question one?", "question two?"]. No other text.',
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const text = await chatCompletion(
        cfg.openrouterKey,
        cfg.defaultModel || DEFAULT_MODEL,
        [
          {
            role: "system",
            content:
              "You generate concise web-research questions. Reply with ONLY a JSON array of strings.",
          },
          { role: "user", content: prompt },
        ],
        integrations?.openrouter,
      );
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start < 0 || end <= start) throw new Error("no JSON array in reply");
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      const questions = (Array.isArray(parsed) ? parsed : [])
        .filter(
          (q): q is string => typeof q === "string" && q.trim().length > 0,
        )
        .slice(0, 5);
      if (!questions.length) throw new Error("empty question list");
      res.json({ questions, source: "llm" });
    } catch (e) {
      console.warn(
        "llm questions fell back to templates:",
        e instanceof Error ? e.message : e,
      );
      res.json({ questions: templates(), source: "templates" });
    }
  });

  // GET /api/gaps/enrich?q=: qmd context for one gap suggestion (F016) —
  // the nearest existing in-graph note to the gap query. Best-effort: any
  // unavailable state returns snippet:null and the template stands alone.
  app.get("/api/gaps/enrich", async (req, res) => {
    try {
      const q = String(req.query.q ?? "").trim();
      if (!q) {
        res.status(400).json({ error: "q required" });
        return;
      }
      const bin = await qmdBin();
      if (!bin || qmdSetup.state() === "indexing") {
        res.json({ snippet: null });
        return;
      }
      const covering = coveringCollections(await collections(bin), vaultRoot);
      if (!covering.length) {
        res.json({ snippet: null });
        return;
      }
      const hits = await qmdSearch(
        bin,
        q,
        3,
        covering.map((c) => c.name),
      );
      const nodeTitles = new Map(
        graph.nodes.filter((n) => !n.phantom).map((n) => [n.id, n.title]),
      );
      const top = hitsToNodes(hits, covering, vaultRoot, nodeTitles)[0];
      res.json(
        top
          ? { snippet: top.snippet, from: top.title, id: top.id }
          : { snippet: null },
      );
    } catch (e) {
      console.error("gap enrich failed:", e);
      res.status(500).json({ error: "gap enrich failed" });
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
      const markdown = readFileSync(full, "utf-8");
      // Log the open for the reader history, unless this is a history-nav
      // re-open (?nolog=1) which must not reorder the log.
      if (req.query.nolog !== "1") logReaderOpen(dataDir, id);
      res.json({ id, markdown });
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
    relatedCache.clear(); // related notes may change with the graph (F015)
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
