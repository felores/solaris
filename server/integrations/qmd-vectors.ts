/**
 * Read-only vector access over qmd's sqlite-vec index (F030, plan §0.3).
 *
 * Quarantines ALL sqlite / sqlite-vec coupling behind a schema guard and a
 * graceful "unavailable" fallback: open() NEVER throws. On a missing file, a
 * missing sqlite-vec extension, or an unexpected schema it returns
 * { available: false, reason }, so the rest of Solaris keeps working without a
 * semantic layer.
 *
 * The embedding dimension is READ from the vectors_vec `float[N]` declaration,
 * never hardcoded (embeddinggemma is 768 today; a model switch changes it).
 *
 * Identity is reconciled to graph.json node ids (vault-relative paths) via
 * store_collections, so callers speak the same ids as the graph. qmd docs
 * outside the vault root (excluded / symlinked collections) are skipped.
 *
 * Read-only open, no egress, NOT a daemon. Live vsearch (qmd.ts) is unchanged.
 *
 * qmd schema (verified 2026-07): vectors_vec = vec0(hash_seq TEXT PRIMARY KEY,
 * embedding float[N] distance_metric=cosine); hash_seq = `${contentHash}_${seq}`;
 * documents(collection, path, hash, active) joins to content via hash;
 * store_collections(name, path) gives each collection's absolute root.
 */
import type BetterSqlite3 from "better-sqlite3";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

// Native deps are lazy-required so a missing / wrong-ABI binary (e.g. an
// un-rebuilt Electron shell) degrades to "semantic layer unavailable" instead
// of crashing server load. All sqlite coupling stays quarantined here.
const nativeRequire = createRequire(import.meta.url);
type DbCtor = new (
  path: string,
  opts?: BetterSqlite3.Options,
) => BetterSqlite3.Database;
interface SqliteVecModule {
  load(db: BetterSqlite3.Database): void;
}

export const DEFAULT_QMD_INDEX = join(
  homedir(),
  ".cache",
  "qmd",
  "index.sqlite",
);

export interface Neighbor {
  /** graph node id (vault-relative path) */
  id: string;
  /** cosine similarity in [0,1] = 1 - cosine_distance */
  score: number;
}

export interface QmdVectorsReady {
  available: true;
  dim: number;
  /** Mean-pooled vector for one graph node, or null if it has no vectors. */
  docVector(id: string): Float32Array | null;
  /** All in-vault active docs -> mean-pooled vectors (cached after first call). */
  allDocVectors(): Map<string, Float32Array>;
  /** Chunk-level KNN via `embedding MATCH`, deduped to the best doc per node. */
  knn(vector: Float32Array, k: number): Neighbor[];
  close(): void;
}
export interface QmdVectorsUnavailable {
  available: false;
  reason: string;
}
export type QmdVectorsHandle = QmdVectorsReady | QmdVectorsUnavailable;

export interface OpenOptions {
  /** Vault root (graph meta.vaultPath) to reconcile qmd paths -> graph ids. */
  vaultRoot: string;
  /** Override the index path (tests point at a fixture). */
  dbPath?: string;
}

type Db = BetterSqlite3.Database;

const REQUIRED_TABLES = [
  "documents",
  "content_vectors",
  "store_collections",
  "vectors_vec",
] as const;

function hashOf(hashSeq: string): string {
  const i = hashSeq.lastIndexOf("_");
  return i >= 0 ? hashSeq.slice(0, i) : hashSeq;
}

function normId(p: string): string {
  return p.split("\\").join("/"); // graph ids are posix; no-op on mac/linux
}

function readDim(db: Db): number {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'vectors_vec'")
    .get() as { sql: string } | undefined;
  const m = row?.sql.match(/float\[(\d+)\]/);
  return m ? Number(m[1]) : 0;
}

function tableExists(db: Db, name: string): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    )
    .get(name);
}

/** hash -> graph id, for active docs whose file lives under vaultRoot. */
function buildHashToId(db: Db, vaultRoot: string): Map<string, string> {
  const roots = new Map<string, string>();
  for (const c of db
    .prepare("SELECT name, path FROM store_collections")
    .all() as Array<{ name: string; path: string }>) {
    roots.set(c.name, c.path);
  }
  const out = new Map<string, string>();
  for (const d of db
    .prepare("SELECT collection, path, hash FROM documents WHERE active = 1")
    .all() as Array<{ collection: string; path: string; hash: string }>) {
    const root = roots.get(d.collection);
    if (!root) continue;
    const rel = relative(vaultRoot, join(root, d.path));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue; // outside vault
    out.set(d.hash, normId(rel));
  }
  return out;
}

function meanPool(vecs: Float32Array[], dim: number): Float32Array {
  const acc = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) acc[i] += v[i];
  for (let i = 0; i < dim; i++) acc[i] /= vecs.length;
  return acc;
}

export function openQmdVectors(opts: OpenOptions): QmdVectorsHandle {
  const dbPath = opts.dbPath ?? DEFAULT_QMD_INDEX;
  if (!existsSync(dbPath)) {
    return { available: false, reason: `qmd index not found at ${dbPath}` };
  }

  let db: Db;
  try {
    const Database = nativeRequire("better-sqlite3") as DbCtor;
    const sqliteVec = nativeRequire("sqlite-vec") as SqliteVecModule;
    db = new Database(dbPath, { readonly: true });
    sqliteVec.load(db);
  } catch (e) {
    return {
      available: false,
      reason: `cannot open qmd index: ${(e as Error).message}`,
    };
  }

  try {
    for (const t of REQUIRED_TABLES) {
      if (!tableExists(db, t)) {
        db.close();
        return {
          available: false,
          reason: `qmd index missing table '${t}' (unexpected schema)`,
        };
      }
    }
    const dim = readDim(db);
    if (!dim) {
      db.close();
      return {
        available: false,
        reason: "vectors_vec dimension not found (unexpected schema)",
      };
    }

    const hashToId = buildHashToId(db, opts.vaultRoot);
    let docCache: Map<string, Float32Array> | null = null;

    const allDocVectors = (): Map<string, Float32Array> => {
      if (docCache) return docCache;
      // Collect chunk vectors per in-vault content hash.
      const byHash = new Map<string, Float32Array[]>();
      const rows = db
        .prepare("SELECT hash_seq, embedding FROM vectors_vec")
        .iterate() as IterableIterator<{ hash_seq: string; embedding: Buffer }>;
      for (const r of rows) {
        const hash = hashOf(r.hash_seq);
        if (!hashToId.has(hash)) continue;
        // Copy out: the row Buffer may be pooled/reused across iteration.
        const view = new Float32Array(
          r.embedding.buffer,
          r.embedding.byteOffset,
          r.embedding.byteLength / 4,
        );
        const list = byHash.get(hash) ?? byHash.set(hash, []).get(hash)!;
        list.push(Float32Array.from(view));
      }
      const map = new Map<string, Float32Array>();
      for (const [hash, id] of hashToId) {
        const vecs = byHash.get(hash);
        if (vecs && vecs.length) map.set(id, meanPool(vecs, dim));
      }
      docCache = map;
      return map;
    };

    const handle: QmdVectorsReady = {
      available: true,
      dim,
      docVector: (id) => allDocVectors().get(id) ?? null,
      allDocVectors,
      knn: (vector, k) => {
        const buf = Buffer.from(
          vector.buffer,
          vector.byteOffset,
          vector.byteLength,
        );
        // Over-fetch chunks: many collapse to one doc and non-vault ones drop.
        const rows = db
          .prepare(
            "SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
          )
          .all(buf, Math.max(k * 4, k)) as Array<{
          hash_seq: string;
          distance: number;
        }>;
        const best = new Map<string, number>(); // id -> min distance
        for (const r of rows) {
          const id = hashToId.get(hashOf(r.hash_seq));
          if (!id) continue;
          const prev = best.get(id);
          if (prev === undefined || r.distance < prev) best.set(id, r.distance);
        }
        return [...best.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, k)
          .map(([id, d]) => ({ id, score: 1 - d }));
      },
      close: () => db.close(),
    };
    return handle;
  } catch (e) {
    db.close();
    return {
      available: false,
      reason: `qmd schema guard failed: ${(e as Error).message}`,
    };
  }
}
