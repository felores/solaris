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
import type { Server } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { scanVault } from "../scanner/scan.js";
import {
  defaultPrompts,
  effectivePrompts,
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
  hitsToPassages,
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
  createArticleFetcher,
  type ExaAdapterOptions,
} from "./integrations/exa.js";
import {
  convertBytes,
  convertDocument,
  ingestBytes,
  ingestDocument,
  ingestText,
  isYoutubeUrl,
  resolveIngestDestination,
  type ConvertedDocument,
} from "./integrations/ingest.js";
import {
  gitFileAtCommit,
  gitFileHistory,
  gitTopLevel,
} from "./integrations/git.js";
import {
  clearEntries,
  deleteEntry,
  listEntries,
  saveEntry,
  upsertEntry,
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
  openQmdVectors,
  type QmdVectorsHandle,
} from "./integrations/qmd-vectors.js";
import {
  DEFAULT_K,
  DEFAULT_THRESHOLD,
  mutualKnnEdges,
  type SemanticEdge,
} from "./integrations/semantic.js";
import {
  guardedAppendLink,
  guardedCreate,
  guardedEdit,
  WriteError,
} from "./integrations/write.js";
import { confineNoteId, noteFileOrFail } from "./integrations/paths.js";
import {
  requireExaKey,
  requireMarkitdown,
  requireOpenRouterKey,
  requireOpenRouterKeyOrThrow,
  requireWebConsent,
  type ToolCacheRef,
} from "./integrations/gates.js";
import { attachVoiceRelay } from "./integrations/voice.js";
import { discoverAndMerge } from "./integrations/wiki.js";
import {
  applyWikiIngestOperations,
  buildRawOperation,
  buildWikiIngestProposal,
  readWikiContracts,
  resolveWikiTarget,
} from "./integrations/wiki-ingest.js";
import { excerptFor } from "./integrations/excerpt.js";

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
  /** Attach the voice WebSocket relay to the http.Server from app.listen(). */
  attachVoice(server: Server): void;
}

/** Response of GET /api/semantic (F031). */
type SemanticResult =
  | {
      available: true;
      fingerprint: string;
      dim: number;
      k: number;
      threshold: number;
      built_at: string;
      count: number;
      edges: SemanticEdge[];
    }
  | { available: false; reason: string };

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
  /** Electron-only native vault picker. Browser/CLI mode leaves this undefined. */
  pickVault?: () => Promise<string | null>;
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
  // re-probe on ?refresh=1 (settings re-check). Wrapped in a ref so the
  // gates seam (U2) can populate / reuse the same cache without a second
  // closure variable.
  const toolCache: ToolCacheRef = { current: null };

  // GET /api/integrations: per-tool state + config booleans, never key material.
  app.get("/api/integrations", async (req, res) => {
    try {
      if (!toolCache.current || req.query.refresh === "1")
        toolCache.current = await detectAll(detectDeps);
      const cfg = loadConfig(configPath);
      res.json({
        tools: {
          qmd: toolCache.current.qmd,
          markitdown: toolCache.current.markitdown,
          exa: { configured: !!cfg.exaKey },
          openrouter: { configured: !!cfg.openrouterKey },
        },
        consents: cfg.consents,
        defaultModel: cfg.defaultModel,
        writeDestination: cfg.writeDestination,
        admin: {
          activeVaultPath: cfg.activeVaultPath,
          vaults: cfg.vaults,
          promptDefaults: defaultPrompts(),
          prompts: effectivePrompts(cfg),
          promptOverrides: cfg.prompts,
        },
        voice: {
          provider: cfg.voice.provider,
          voice: cfg.voice.voice,
          // key material never leaves the config file — booleans only
          keys: {
            gemini: !!cfg.voice.keys.gemini,
            openai: !!cfg.voice.keys.openai,
            xai: !!cfg.voice.keys.xai,
          },
        },
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
        writeDestination: cfg.writeDestination,
        activeVaultPath: cfg.activeVaultPath,
        vaults: cfg.vaults,
        promptDefaults: defaultPrompts(),
        prompts: effectivePrompts(cfg),
        promptOverrides: cfg.prompts,
        exaConfigured: !!cfg.exaKey,
      });
    } catch (e) {
      console.error("Config update failed:", e);
      res.status(500).json({ error: "config update failed" });
    }
  });

  // GET /api/wikis (F044): discover `wiki/` folders in the active vault,
  // respect graph excludes, detect contract files (AGENTS.md/CLAUDE.md/
  // index.md/README.md), and merge with saved manual wikis so user-disabled
  // state and custom rawDestination survive rediscovery. Read-only.
  app.get("/api/wikis", (req, res) => {
    try {
      const vaultPath = graph.meta.vaultPath;
      if (!vaultPath || !existsSync(vaultPath)) {
        res.status(503).json({ error: "vault root is missing or not reachable" });
        return;
      }
      const excludes = graph.meta.excludes ?? [];
      const cfg = loadConfig(configPath);
      const saved = cfg.vaults[vaultPath]?.wikis ?? [];
      const wikis = discoverAndMerge(vaultPath, excludes, saved);
      res.json({ wikis });
    } catch (e) {
      console.error("Wiki discovery failed:", e);
      res.status(500).json({ error: "wiki discovery failed" });
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
        toolCache.current = null; // re-probe on next status call
        res.json({ results });
      } catch (e) {
        console.error("addons install failed:", e);
        res.status(500).json({ error: "install failed" });
      }
    },
  );

  // Exa /contents fetcher, shared by /api/article and the YouTube ingest path.
  const fetchArticle = createArticleFetcher(integrations?.exa);
  const ingestTargetConfig = (cfg: ReturnType<typeof loadConfig>) => {
    const saved = cfg.vaults[vaultRoot]?.wikis ?? [];
    return {
      ...cfg,
      vaults: {
        ...cfg.vaults,
        [vaultRoot]: {
          path: vaultRoot,
          wikis: discoverAndMerge(vaultRoot, graph.meta.excludes ?? [], saved),
        },
      },
    };
  };

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
      const cfg = loadConfig(configPath);
      const destination = resolveIngestDestination(vaultRoot, ingestTargetConfig(cfg), {
        wikiId: b.wikiId,
        captureOnly: b.captureOnly,
      });
      // YouTube: markitdown only sees the SPA shell (no transcript), so fetch
      // via Exa /contents, which extracts the transcript. Egress → gated on web
      // consent + an Exa key, same as web research.
      if (isYoutubeUrl(b.source)) {
        if (
          !requireWebConsent(
            cfg,
            res,
            "Fetching a YouTube transcript goes through Exa — activate Web mode once to consent.",
          ) ||
          !requireExaKey(cfg, res, "Add your Exa API key in Tools → Integrations.")
        ) {
          return;
        }
        const art = await fetchArticle(cfg.exaKey, b.source.trim());
        if (!art.content) {
          res.status(422).json({
            error: "no-transcript",
            message: "Exa returned no transcript for this video.",
          });
          return;
        }
        const yr = await ingestText(
          { vaultRoot, dataDir: dirname(graphPath) },
          {
            source: b.source.trim(),
            title: art.title,
            content: art.content,
            via: "exa-youtube",
            destination,
          },
        );
        res.json({ ok: true, id: yr.id });
        return;
      }
      const bin = await requireMarkitdown(
        toolCache,
        () => detectAll(detectDeps),
        res,
      );
      if (!bin) return;
      const r = await ingestDocument(
        integrations?.detectDeps?.run ?? realRunner,
        bin,
        { vaultRoot, dataDir: dirname(graphPath) },
        {
          source: b.source,
          title: typeof b.title === "string" ? b.title : undefined,
          destination,
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
        const bin = await requireMarkitdown(
          toolCache,
          () => detectAll(detectDeps),
          res,
        );
        if (!bin) return;
        const name =
          typeof req.query.name === "string" ? req.query.name : "upload";
        const cfg = loadConfig(configPath);
        const destination = resolveIngestDestination(vaultRoot, ingestTargetConfig(cfg), {
          wikiId: req.query.wikiId,
          captureOnly:
            req.query.captureOnly === "1" || req.query.captureOnly === "true",
        });
        const r = await ingestBytes(
          integrations?.detectDeps?.run ?? realRunner,
          bin,
          { vaultRoot, dataDir: dirname(graphPath) },
          { name, bytes: req.body, destination },
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
    if (!toolCache.current) toolCache.current = await detectAll(detectDeps);
    return toolCache.current.qmd.installed ? toolCache.current.qmd.path : null;
  }

  // Collection list spawns one qmd process per collection; cache briefly.
  let colCache: { at: number; cols: QmdCollection[] } | null = null;
  // Per-note related-notes cache (F015); invalidated by reload().
  const relatedCache = new Map<string, object>();
  // Cached qmd vector handle for instant per-note KNN in /api/related.
  // Rebuilt on reload() (vaultRoot may change); open() never throws.
  let vectorsHandle: QmdVectorsHandle | null = null;
  function qmdVectors(): QmdVectorsHandle {
    if (!vectorsHandle) vectorsHandle = openQmdVectors({ vaultRoot });
    return vectorsHandle;
  }
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

  // Chunk-level variant of semanticQuery for /api/passages: returns the top
  // matching PASSAGES (with line positions), not one snippet per note, so a
  // caller can answer from within a long note without loading the whole file.
  // Optional `note` scopes to a single vault-relative path (over-fetch, then
  // filter, so one doc still yields several passages).
  async function passagesQuery(
    queryText: string,
    collectionsParam: unknown,
    note: string | undefined,
    limit: number,
  ): Promise<{ status: number; body: object }> {
    const bin = await qmdBin();
    if (!bin) return { status: 503, body: { error: "qmd not installed" } };
    if (qmdSetup.state() === "indexing")
      return { status: 200, body: { state: "indexing", results: [] } };
    if (qmdSetup.state() === "ready") colCache = null;
    const covering = coveringCollections(await collections(bin), vaultRoot);
    if (!covering.length)
      return { status: 200, body: { state: "uncovered", results: [] } };
    const enabled =
      typeof collectionsParam === "string" && collectionsParam
        ? new Set(collectionsParam.split(",").filter(Boolean))
        : undefined;
    const scopeNames = covering
      .map((c) => c.name)
      .filter((n) => !enabled || enabled.has(n));
    const pool = note ? Math.max(limit * 6, 30) : limit;
    const hits = await qmdSearch(bin, queryText, pool, scopeNames);
    const results = hitsToPassages(
      hits,
      covering,
      vaultRoot,
      enabled,
      note,
    ).slice(0, limit);
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
    // force (-f) rebuilds all vectors from scratch; otherwise embed is incremental.
    const started = qmdMaint.start(
      bin,
      { update: flag(req.query.update), embed: flag(req.query.embed) },
      { force: flag(req.query.force) },
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
      const full = noteFileOrFail(vaultRoot, id);
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
      // Primary (F030): instant KNN from the note's own mean-pooled doc vector.
      // Higher recall than a title+excerpt vsearch query and ~0ms after first
      // open (no process spawn). Falls back to live vsearch when the note has
      // no vector (not embedded / excluded) or the sqlite layer is unavailable.
      const qv = qmdVectors();
      if (qv.available) {
        const vec = qv.docVector(id);
        if (vec) {
          const titles = new Map(
            graph.nodes.filter((n) => !n.phantom).map((n) => [n.id, n.title]),
          );
          const results = qv
            .knn(vec, DEFAULT_K + 1) // self is usually #1, drops below
            .filter((nb) => nb.id !== id && titles.has(nb.id))
            .slice(0, 8)
            .map((nb) => ({
              id: nb.id,
              title: titles.get(nb.id)!,
              score: nb.score,
              snippet: excerptFor(vaultRoot, nb.id, titles.get(nb.id)!),
            }));
          const out = { state: "ready", results };
          if (relatedCache.size > 500) relatedCache.clear();
          relatedCache.set(cacheKey, out);
          res.json(out);
          return;
        }
      }

      // Fallback: live vsearch with title + body excerpt.
      const text = readFileSync(full, "utf-8");
      const bodyText = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
      const title = graph.nodes.find((n) => n.id === id)?.title ?? "";
      const r = await semanticQuery(
        `${title}\n${bodyText.slice(0, 600)}`,
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
      writeFail(res, e, "related");
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

  // GET /api/passages?q=&note=&collections=&limit=: chunk-level retrieval.
  // Returns the top matching passages with line positions (multiple per note
  // allowed), optionally scoped to one note so a client can answer from a
  // single doc without loading the whole file. Read-only, vault-confined.
  app.get("/api/passages", async (req, res) => {
    try {
      const q = String(req.query.q ?? "").trim();
      if (!q) {
        res.json({ state: "ready", results: [] });
        return;
      }
      const note =
        typeof req.query.note === "string" && req.query.note
          ? req.query.note
          : undefined;
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "8"), 10) || 8, 1),
        20,
      );
      const r = await passagesQuery(q, req.query.collections, note, limit);
      const results = (r.body as { results?: unknown[] }).results;
      // Cross-vault passage searches (the research panel) join the semantic
      // history; note-scoped ones (the reader's find-in-note) do not.
      const historyId =
        !note && r.status === 200 && Array.isArray(results) && results.length
          ? saveEntry(dataDir, { mode: "semantic", query: q, results }).id
          : undefined;
      res.status(r.status).json({ ...r.body, historyId });
    } catch (e) {
      console.error("passages search failed:", e);
      res.status(500).json({ error: "passages search failed" });
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
      if (
        !requireWebConsent(
          cfg,
          res,
          "Web mode needs your one-time consent first (activate Web mode to review it).",
        ) ||
        !requireExaKey(cfg, res, "Add your Exa API key in Tools → Integrations.")
      ) {
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

  // POST /api/article: fetch one web result's full text via Exa /contents.
  // Same trust model as /api/research (token-guarded + web consent + key), and
  // the fetched article is persisted as a history entry (mode "article").
  // (fetchArticle is defined once above, near /api/ingest.)
  app.post("/api/article", guarded, express.json(), async (req, res) => {
    try {
      const cfg = loadConfig(configPath);
      if (
        !requireWebConsent(
          cfg,
          res,
          "Web mode needs your one-time consent first (activate Web mode to review it).",
        ) ||
        !requireExaKey(cfg, res, "Add your Exa API key in Tools → Integrations.")
      ) {
        return;
      }
      const url = String(req.body?.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        res.status(400).json({
          error: "invalid-url",
          message: "A valid http(s) URL is required.",
        });
        return;
      }
      const art = await fetchArticle(cfg.exaKey, url);
      const historyId = art.content
        ? saveEntry(dataDir, {
            mode: "article",
            query: art.title,
            article: art,
          }).id
        : undefined;
      res.json({ ...art, historyId });
    } catch (e) {
      console.error(
        "article fetch failed:",
        e instanceof Error ? e.message : e,
      );
      res.status(502).json({
        error: "article-failed",
        message: "Exa content fetch failed. Check your key and try again.",
      });
    }
  });

  // POST /api/document: upsert the voice agent's working document (mode
  // "document"). Same id across a session's turns → the entry is edited in
  // place, not appended (no chat log). Token-guarded (mutates local history).
  app.post("/api/document", guarded, express.json(), (req, res) => {
    const id = String(req.body?.id ?? "");
    if (!/^[a-z0-9-]+$/.test(id)) {
      res.status(400).json({ error: "bad-id" });
      return;
    }
    const title = String(req.body?.title ?? "").trim() || "Untitled";
    const content = String(req.body?.content ?? "");
    try {
      const entry = upsertEntry(dataDir, {
        id,
        mode: "document",
        query: title,
        document: { title, content },
      });
      res.json({ ok: true, id: entry.id });
    } catch {
      res.status(400).json({ error: "document-save-failed" });
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

  const notePathOrFail = (id: string) => noteFileOrFail(vaultRoot, id);

  const gitContextForNote = async (id: string) => {
    const full = notePathOrFail(id);
    const repoRoot = await gitTopLevel(realRunner, vaultRoot);
    if (!repoRoot) return { available: false as const };
    return {
      available: true as const,
      repoRoot,
      repoRelativePath: relative(repoRoot, realpathSync(full)),
    };
  };

  const noteSlug = (title: string) =>
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’‘"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/g, "") || "document";

  app.get("/api/wiki-contracts", (req, res) => {
    try {
      const cfg = ingestTargetConfig(loadConfig(configPath));
      const wiki = resolveWikiTarget(vaultRoot, cfg, { wikiId: req.query.wikiId });
      res.json({
        wiki: { id: wiki.id, label: wiki.label, path: wiki.path },
        contracts: readWikiContracts(vaultRoot, wiki),
      });
    } catch (e) {
      writeFail(res, e, "wiki contracts read");
    }
  });

  app.post(
    "/api/document/:id/promote",
    guarded,
    express.json({ limit: "5mb" }),
    (req, res) => {
      try {
        const entry = listEntries(dataDir).find(
          (e) => e.id === req.params.id && e.mode === "document" && e.document,
        );
        if (!entry?.document) throw new WriteError(404, "document not found");
        const b = (req.body ?? {}) as Record<string, unknown>;
        const kind = b.kind === "raw_copy" ? "raw_copy" : "wiki_note";
        const cfg = ingestTargetConfig(loadConfig(configPath));
        const wiki = resolveWikiTarget(vaultRoot, cfg, { wikiId: b.wikiId });
        const title =
          (typeof b.title === "string" && b.title.trim()) ||
          entry.document.title ||
          entry.query ||
          "Untitled";
        const converted: ConvertedDocument = {
          source: `voice-document:${entry.id}`,
          sourceLabel: `voice working document: ${title}`,
          title,
          markdown: entry.document.content,
          via: "voice",
        };
        const op =
          kind === "raw_copy"
            ? buildRawOperation(vaultRoot, wiki, converted, new Date())
            : {
                type: "create" as const,
                path:
                  typeof b.path === "string" && b.path.trim()
                    ? b.path.trim()
                    : `${wiki.path}/${noteSlug(title)}.md`,
                title,
                content: converted.markdown,
              };
        if (!op) throw new WriteError(400, "selected wiki has no raw destination");
        const ids = applyWikiIngestOperations(
          writeDeps(),
          vaultRoot,
          wiki,
          [op],
          { actor: "agent" },
        );
        deleteEntry(dataDir, entry.id);
        res.json({ ok: true, id: ids[0], ids, removedHistory: true });
      } catch (e) {
        writeFail(res, e, "document promote");
      }
    },
  );

  async function markitdownBinOrFail(res: express.Response): Promise<string | null> {
    return requireMarkitdown(toolCache, () => detectAll(detectDeps), res);
  }

  async function wikiIngestProposal(
    converted: Awaited<ReturnType<typeof convertDocument>>,
    wikiId: unknown,
  ) {
    const cfg = loadConfig(configPath);
    requireOpenRouterKeyOrThrow(
      cfg,
      "Add an OpenRouter key before wiki ingest",
    );
    const merged = ingestTargetConfig(cfg);
    const wiki = resolveWikiTarget(vaultRoot, merged, { wikiId });
    return buildWikiIngestProposal(
      { vaultRoot },
      cfg,
      wiki,
      converted,
      (messages) =>
        chatCompletion(
          cfg.openrouterKey!,
          cfg.defaultModel || DEFAULT_MODEL,
          messages,
          integrations?.openrouter,
        ),
    );
  }

  app.post(
    "/api/wiki-ingest/propose",
    guarded,
    express.json({ limit: "5mb" }),
    async (req, res) => {
      try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (b.captureOnly === true) {
          res.status(400).json({ error: "capture-only uses /api/ingest" });
          return;
        }
        if (typeof b.source !== "string" || !b.source.trim()) {
          res.status(400).json({ error: "source (file path or URL) required" });
          return;
        }
        const cfg = loadConfig(configPath);
        if (
          !requireOpenRouterKey(
            cfg,
            res,
            "Add an OpenRouter key before wiki ingest",
          )
        ) {
          return;
        }
        const bin = await markitdownBinOrFail(res);
        if (!bin) return;
        const converted = await convertDocument(
          integrations?.detectDeps?.run ?? realRunner,
          bin,
          { source: b.source, title: typeof b.title === "string" ? b.title : undefined },
        );
        res.json(await wikiIngestProposal(converted, b.wikiId));
      } catch (e) {
        writeFail(res, e, "wiki ingest proposal");
      }
    },
  );

  app.post(
    "/api/wiki-ingest/propose-upload",
    guarded,
    express.raw({ type: "*/*", limit: "50mb" }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
          res.status(400).json({ error: "file body required" });
          return;
        }
        const cfg = loadConfig(configPath);
        if (
          !requireOpenRouterKey(
            cfg,
            res,
            "Add an OpenRouter key before wiki ingest",
          )
        ) {
          return;
        }
        const bin = await markitdownBinOrFail(res);
        if (!bin) return;
        const name = typeof req.query.name === "string" ? req.query.name : "upload";
        const converted = await convertBytes(
          integrations?.detectDeps?.run ?? realRunner,
          bin,
          { name, bytes: req.body },
        );
        res.json(await wikiIngestProposal(converted, req.query.wikiId));
      } catch (e) {
        writeFail(res, e, "wiki ingest upload proposal");
      }
    },
  );

  app.post(
    "/api/wiki-ingest/apply",
    guarded,
    express.json({ limit: "10mb" }),
    (req, res) => {
      try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const cfg = ingestTargetConfig(loadConfig(configPath));
        const wiki = resolveWikiTarget(vaultRoot, cfg, { wikiId: b.wikiId });
        const ids = applyWikiIngestOperations(
          writeDeps(),
          vaultRoot,
          wiki,
          b.operations,
        );
        res.json({ ok: true, ids });
      } catch (e) {
        writeFail(res, e, "wiki ingest apply");
      }
    },
  );

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
      const gaps = computeGaps(graph.nodes, graph.links ?? []);
      // F034: enrich orphan suggestions with their top semantic neighbor from
      // the cached edges (read-only; never triggers a build). Orphans have no
      // structural links but often DO have a semantic neighbor to link to.
      const sem = readSemanticCache();
      if (sem) {
        const best = new Map<string, { id: string; score: number }>();
        for (const e of sem.edges) {
          const cur1 = best.get(e.source);
          if (!cur1 || e.score > cur1.score)
            best.set(e.source, { id: e.target, score: e.score });
          const cur2 = best.get(e.target);
          if (!cur2 || e.score > cur2.score)
            best.set(e.target, { id: e.source, score: e.score });
        }
        const titleOf = new Map(graph.nodes.map((n) => [n.id, n.title]));
        for (const s of gaps.suggestions) {
          if (s.kind !== "orphan" || !s.nodeId) continue;
          const b = best.get(s.nodeId);
          const title = b && titleOf.get(b.id);
          if (b && title) s.suggestedLink = { id: b.id, title, score: b.score };
        }
      }
      res.json(gaps);
    } catch (e) {
      console.error("gaps failed:", e);
      res.status(500).json({ error: "gaps failed" });
    }
  });

  // POST /api/gaps/link: confirm one orphan link suggestion (F034). Appends a
  // [[target]] wikilink to the orphan note THROUGH the single guarded writer
  // (journaled). Token-guarded (mutating); nothing is written until confirmed.
  app.post("/api/gaps/link", guarded, express.json(), (req, res) => {
    const id = String(req.body?.id ?? "");
    const target = String(req.body?.target ?? "");
    if (!id || !target) {
      res.status(400).json({ error: "id and target are required" });
      return;
    }
    try {
      const r = guardedAppendLink(writeDeps(), { id, target, actor: "user" });
      res.json(r);
    } catch (e) {
      if (e instanceof WriteError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      console.error("gap link failed:", e);
      res.status(500).json({ error: "link failed" });
    }
  });

  // GET /api/llm/models: server-side proxy to OpenRouter's model list so
  // the key never reaches the client. A listing is a free read (no credit).
  app.get("/api/llm/models", async (_req, res) => {
    const cfg = loadConfig(configPath);
    if (!requireOpenRouterKey(cfg, res, "no-openrouter-key")) return;
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
    const full = confineNoteId(vaultRoot, id);
    if (!full || !existsSync(full)) {
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

  // Layout cache lives beside graph.json, one file per arrangement (F032):
  // the default "links" arrangement stays layout.json for backward compat.
  const layoutFile = (arrangement?: unknown): string => {
    const a = String(arrangement ?? "links").replace(/[^a-z]/g, "");
    return resolve(
      dirname(graphPath),
      a && a !== "links" ? `layout-${a}.json` : "layout.json",
    );
  };

  // GET /api/layout[?arrangement=]: Retrieve cached node positions for an
  // arrangement. Keyed by graph fingerprint (checked client-side); fast boot.
  app.get("/api/layout", (req, res) => {
    const p = layoutFile(req.query.arrangement);
    if (!existsSync(p)) {
      res.status(404).json({ error: "no cached layout" });
      return;
    }
    res.sendFile(p, { dotfiles: "allow" });
  });

  // POST /api/layout: Persist settled node positions for an arrangement (from
  // the request body's `arrangement`) after the physics simulation stabilizes.
  app.post("/api/layout", express.json({ limit: "20mb" }), (req, res) => {
    try {
      writeFileSync(
        layoutFile(req.body?.arrangement),
        JSON.stringify(req.body),
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("Failed to save layout:", e);
      res.status(500).json({ error: "save failed" });
    }
  });

  // Semantic edges (F031): mutual-KNN over qmd vectors, cached beside
  // graph.json by graph fingerprint. Built on demand (first Semantic/Hybrid
  // arrangement) and reused until the vault changes. Absent qmd / vectors ->
  // { available: false }, so the core UI keeps working without a semantic layer.
  const semanticPath = resolve(dirname(graphPath), "semantic.json");
  let semanticBuild: Promise<SemanticResult> | null = null;

  const graphFingerprint = (): string => {
    const m = graph.meta as unknown as { fingerprint?: string };
    return String(m.fingerprint ?? graph.meta.notes);
  };

  // Read the cached semantic edges WITHOUT triggering a build (used by
  // /api/gaps so surfacing suggestions never blocks on a 10s+ rebuild).
  type SemanticReady = Extract<SemanticResult, { available: true }>;
  const readSemanticCache = (): SemanticReady | null => {
    if (!existsSync(semanticPath)) return null;
    try {
      const c = JSON.parse(
        readFileSync(semanticPath, "utf-8"),
      ) as SemanticResult;
      if (c.available && c.fingerprint === graphFingerprint()) return c;
    } catch {
      /* stale/corrupt cache */
    }
    return null;
  };

  const ensureSemantic = async (): Promise<SemanticResult> => {
    const fingerprint = graphFingerprint();
    const cachedHit = readSemanticCache();
    if (cachedHit) return cachedHit;
    if (semanticBuild) return semanticBuild;
    semanticBuild = (async (): Promise<SemanticResult> => {
      const qv = openQmdVectors({ vaultRoot });
      if (!qv.available) return { available: false, reason: qv.reason };
      try {
        const nodeIds = new Set(
          graph.nodes
            .filter((n) => !n.id.startsWith("phantom:"))
            .map((n) => n.id),
        );
        const edges = await mutualKnnEdges(
          qv.allDocVectors(),
          nodeIds,
          DEFAULT_K,
          DEFAULT_THRESHOLD,
        );
        const result: SemanticResult = {
          available: true,
          fingerprint,
          dim: qv.dim,
          k: DEFAULT_K,
          threshold: DEFAULT_THRESHOLD,
          built_at: new Date().toISOString(),
          count: edges.length,
          edges,
        };
        try {
          writeFileSync(semanticPath, JSON.stringify(result));
        } catch (e) {
          console.error("Failed to cache semantic edges:", e);
        }
        return result;
      } finally {
        qv.close();
      }
    })();
    try {
      return await semanticBuild;
    } finally {
      semanticBuild = null;
    }
  };

  // GET /api/semantic: the cached (or freshly built) semantic edge set.
  app.get("/api/semantic", async (_req, res) => {
    try {
      res.json(await ensureSemantic());
    } catch (e) {
      console.error("semantic build failed:", e);
      res.status(500).json({ error: "semantic build failed" });
    }
  });

  app.get("/api/note-versions", async (req, res) => {
    try {
      const id = String(req.query.id ?? "");
      const ctx = await gitContextForNote(id);
      if (!ctx.available) {
        res.json({ available: false, versions: [] });
        return;
      }
      const versions = await gitFileHistory(
        realRunner,
        ctx.repoRoot,
        ctx.repoRelativePath,
      );
      res.json({ available: true, versions });
    } catch (e) {
      writeFail(res, e, "note versions");
    }
  });

  app.get("/api/note-version", async (req, res) => {
    try {
      const id = String(req.query.id ?? "");
      const commit = String(req.query.commit ?? "");
      const ctx = await gitContextForNote(id);
      if (!ctx.available) {
        res.status(404).json({ error: "git history unavailable" });
        return;
      }
      const markdown = await gitFileAtCommit(
        realRunner,
        ctx.repoRoot,
        commit,
        ctx.repoRelativePath,
      );
      if (markdown === null) {
        res.status(404).json({ error: "version not found" });
        return;
      }
      res.json({ id, commit, markdown });
    } catch (e) {
      writeFail(res, e, "note version");
    }
  });

  app.post(
    "/api/note-version/restore",
    guarded,
    express.json({ limit: "1mb" }),
    async (req, res) => {
      try {
        const { id, commit } = (req.body ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || typeof commit !== "string") {
          res.status(400).json({ error: "id and commit required" });
          return;
        }
        const ctx = await gitContextForNote(id);
        if (!ctx.available) {
          res.status(404).json({ error: "git history unavailable" });
          return;
        }
        const content = await gitFileAtCommit(
          realRunner,
          ctx.repoRoot,
          commit,
          ctx.repoRelativePath,
        );
        if (content === null) {
          res.status(404).json({ error: "version not found" });
          return;
        }
        const r = guardedEdit(writeDeps(), {
          id,
          content,
          actor: "user",
          mode: "full",
        });
        res.json({ ok: true, id: r.id });
      } catch (e) {
        writeFail(res, e, "note version restore");
      }
    },
  );

  // GET /api/note?id=...: Retrieve raw markdown of a single note
  // id should be a vault-relative path (e.g., "folder/file" or "file.md")
  // Security: Validates that the path stays within vault root (no traversal)
  app.get("/api/note", (req, res) => {
    const id = String(req.query.id ?? "");
    let full: string;
    try {
      full = noteFileOrFail(vaultRoot, id);
    } catch (e) {
      writeFail(res, e, "note");
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

  // GET /api/note-lines?id=&from=&count=: read a line-range slice of a note so
  // a client can expand around a passage without loading the whole file. Same
  // path-traversal guard as /api/note; read-only. `count` capped at 400 lines.
  app.get("/api/note-lines", (req, res) => {
    const id = String(req.query.id ?? "");
    let full: string;
    try {
      full = noteFileOrFail(vaultRoot, id);
    } catch (e) {
      writeFail(res, e, "note-lines");
      return;
    }
    const from = Math.max(parseInt(String(req.query.from ?? "1"), 10) || 1, 1);
    const count = Math.min(
      Math.max(parseInt(String(req.query.count ?? "60"), 10) || 60, 1),
      400,
    );
    try {
      const lines = readFileSync(full, "utf-8").split("\n");
      const total = lines.length;
      const start = Math.min(from - 1, total);
      const slice = lines.slice(start, start + count);
      res.json({
        id,
        from: start + 1,
        to: start + slice.length,
        total,
        text: slice.join("\n"),
      });
    } catch (e) {
      console.error(`Failed to read note lines ${id}:`, e);
      res.status(500).json({ error: "read failed" });
    }
  });

  // GET /api/note-grep?id=&q=&context=&ignore_case=&limit=: exhaustive literal
  // keyword scan within ONE note — every match, with line numbers + a small
  // context window — so a client can find exact terms/names/quotes that
  // semantic search would miss. Same path guard as /api/note; literal
  // substring match (no regex, so no ReDoS); read-only. context 0-10 (def 2),
  // limit 1-100 (def 30).
  app.get("/api/note-grep", (req, res) => {
    const id = String(req.query.id ?? "");
    let full: string;
    try {
      full = noteFileOrFail(vaultRoot, id);
    } catch (e) {
      writeFail(res, e, "note-grep");
      return;
    }
    const q = String(req.query.q ?? "");
    if (!q) {
      res.json({ id, q, count: 0, matches: [] });
      return;
    }
    const ignoreCase = req.query.ignore_case === "1";
    const ctx = Math.min(
      Math.max(parseInt(String(req.query.context ?? "2"), 10) || 2, 0),
      10,
    );
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "30"), 10) || 30, 1),
      100,
    );
    try {
      const lines = readFileSync(full, "utf-8").split("\n");
      const needle = ignoreCase ? q.toLowerCase() : q;
      const matches: { line: number; text: string; snippet: string }[] = [];
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
        if (!hay.includes(needle)) continue;
        const from = Math.max(i - ctx, 0);
        matches.push({
          line: i + 1,
          text: lines[i],
          snippet: lines.slice(from, i + ctx + 1).join("\n"),
        });
      }
      res.json({ id, q, count: matches.length, matches });
    } catch (e) {
      console.error(`Failed to grep note ${id}:`, e);
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

  // GET /api/tree?path=: the vault's folder organization (whole graph, not just
  // qmd collections). Returns the direct subfolders (with note counts) and
  // notes inside `path` (root if omitted). Pure string work over node ids
  // (vault-relative paths), so no file access / traversal surface.
  app.get("/api/tree", (req, res) => {
    const raw = String(req.query.path ?? "").replace(/^\/+|\/+$/g, "");
    const prefix = raw ? raw + "/" : "";
    const subfolders = new Map<string, number>();
    const notes: Array<{ id: string; title: string }> = [];
    for (const n of graph.nodes) {
      if (n.phantom || !n.id.startsWith(prefix)) continue;
      const rest = n.id.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) notes.push({ id: n.id, title: n.title });
      else {
        const sub = rest.slice(0, slash);
        subfolders.set(sub, (subfolders.get(sub) ?? 0) + 1);
      }
    }
    res.json({
      path: raw,
      subfolders: [...subfolders.entries()]
        .map(([name, count]) => ({ path: prefix + name, count }))
        .sort((a, b) => b.count - a.count),
      noteCount: notes.length,
      notes: notes.slice(0, 40),
    });
  });

  const reload = () => {
    graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    vaultRoot = graph.meta.vaultPath;
    index = null; // rebuilt lazily against the new scan
    contents.clear();
    colCache = null;
    maintIdxCache = null;
    relatedCache.clear(); // related notes may change with the graph (F015)
    vectorsHandle = null; // vectors reconcile against vaultRoot, rebuilt lazily
    semanticBuild = null;
  };

  const scanAndReload = (vault: string, full = false) => {
    const g = scanVault({
      vault,
      out: graphPath,
      exclude: graph.meta.excludes ?? [],
      full,
    });
    reload();
    updateConfig({ activeVaultPath: g.meta.vaultPath }, configPath);
    return g;
  };

  // POST /api/rescan: Trigger incremental rescan of the vault
  // Re-parses files that have changed (by mtime+size), hot-swaps the graph,
  // and sends stats back to frontend for UI update.
  // Query param ?full=true forces a cold scan (ignores cache)
  app.post("/api/rescan", (req, res) => {
    try {
      const g = scanAndReload(graph.meta.vaultPath, req.query.full === "true");
      res.json({
        ok: true,
        notes: g.meta.notes,
        links: g.meta.links,
        stats: g.meta.scanStats,
        // Full graph so the client can diff + hot-swap in place instead of a
        // full page reload (applyGraphUpdate).
        graph: g,
      });
    } catch (e) {
      console.error("Rescan failed:", e);
      res.status(500).json({
        error: "rescan failed",
        details: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.post("/api/vault", guarded, express.json(), async (req, res) => {
    try {
      let target: unknown = req.body?.path;
      if (req.body?.browse === true) {
        if (!integrations?.pickVault) {
          res.status(501).json({ error: "desktop browse unavailable" });
          return;
        }
        target = await integrations.pickVault();
        if (!target) {
          res.json({ ok: false, cancelled: true });
          return;
        }
      }

      if (typeof target !== "string" || !target.trim()) {
        res.status(400).json({ error: "vault path required" });
        return;
      }
      const vault = resolve(target);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(vault);
      } catch {
        res.status(404).json({ error: "vault not found" });
        return;
      }
      if (!st.isDirectory()) {
        res.status(400).json({ error: "vault path must be a directory" });
        return;
      }

      const g = scanAndReload(vault);
      res.json({ ok: true, graph: g });
    } catch (e) {
      console.error("Vault switch failed:", e);
      res.status(500).json({ error: "vault switch failed" });
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

  const attachVoice = (server: Server) =>
    attachVoiceRelay(server, { sessionToken, configPath });
  return { app, reload, meta: () => graph.meta, attachVoice };
}
