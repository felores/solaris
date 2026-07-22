# Connecting MCP clients to Sinapso

Sinapso exposes its registry's `mcp`-surface tools over a **stdio** MCP
server (`server/mcp.ts`). It opens no network listener: every tool call is
proxied over loopback HTTP to the running Sinapso server with a
surface-scoped session token, so path confinement, the write journal,
consent/key gates, and token guards all apply exactly as they do for the
browser.

Start Sinapso first (`npm run dev` or `npm start`); the MCP server exits
with a clear stderr message if it cannot reach it. Point at a non-default
port with `SINAPSO_URL` (or `SINAPSO_PORT`).

## Claude Code

```bash
claude mcp add sinapso -e SINAPSO_URL=http://127.0.0.1:5175 -- \
  npx tsx /path/to/sinapso/server/mcp.ts
```

Then e.g. "search my vault for X with sinapso" or "create a note in my
vault". Tools are derived from Sinapso's registry and may vary with the
local edit opt-in; inspect the connected MCP client's tool list rather than
copying a static list into an agent prompt.

## Podcast agent (or any MCP-speaking agent)

Spawn `npx tsx /path/to/sinapso/server/mcp.ts` with `SINAPSO_URL` in the
environment and speak MCP over stdio. `search_vault` is the consolidated
discovery tool: one call handles meaning/keyword (mode `auto`), literal
matches (mode `exact`, with line + context), and path/title lookups (mode
`path`). `auto` is a **hybrid**: it runs BOTH the semantic (qmd vsearch)
and keyword (MiniSearch) engines and fuses them with Reciprocal Rank
Fusion (RRF), because the two engines' native scores are not comparable.
Every result carries a stable 1-based `rank` (the recommended order),
`score`, `scoreKind` (`rrf`/`semantic`/`keyword`/`exact`/`path`), and
`sources` (which engines found it, in `auto`). Agents should order by
`rank` and read `snippet`/`line` context, never compare raw `score`
values across modes or engines.

**Discovery discipline (applies to MCP and CLI too):** follow
Discover → Verify → Act for any answer about the vault.
- **Current context**: `current_view` returns the latest note or Research view
  published by the active Sinapso window. Call it first for "what am I
  reading?" or "this research"; then use `read_note` when the reader note
  needs more context. If `viewStateKnown` is false, no Sinapso window has
  published an active view.
- **Discover**: `browse_folder` (top-down) when scope is unknown;
  `search_vault` for concepts/topics. A subfolder's `count` is the TOTAL
  notes anywhere under it (recursive); `notes` lists up to 40 DIRECT
  children and `noteCount` gives the total direct-note count before that cap.
- **Verify**: `read_note` on the path you found before citing, quoting,
  summarizing, or editing. A `snippet` alone is not a citation.
- **Act**: only with a real path and verified context. Never invent paths.
- **Empty results are a signal, not an answer**: if `auto` returns nothing,
  retry with `exact` (precise term/quote/id), `path` (file/title), or
  `browse_folder` (folder scope). Never repeat the same
  `(queries, mode, path)` call unchanged.

**Wiki ingest (propose → approve → apply):** before `propose_wiki_ingest`,
call `search_vault` for related notes and `read_wiki_contract` on the
target wiki. The server reads the contract again and plans the exact
canonical RAW path. The caller must present the proposal and obtain explicit
user approval before `apply_wiki_ingest`; the server validates token,
confinement, source state and operations, but cannot prove approval itself.
Both propose and apply are available to MCP when its surface-scoped token is
accepted. Backend guards (path confinement, OUTSIDE_SELECTED_WIKI rejection,
RAW-first apply) remain the authority.

## In-place editing (off by default)

`edit_vault_note` — the only tool that can replace existing note content —
is not registered unless the config opt-in is set, and the server rejects
it independently of the bridge:

```bash
curl -X POST http://127.0.0.1:5175/api/integrations/config \
  -H "content-type: application/json" \
  -H "x-sinapso-token: $(curl -s http://127.0.0.1:5175/api/session | jq -r .token)" \
  -d '{"mcpEditEnabled": true}'
```

Restart the MCP server after changing the flag so the tool list updates.

## Security model

- stdio only — no new port, loopback-bound Sinapso stays loopback-bound.
- The bridge's token comes from `GET /api/session?surface=mcp` and is only
  accepted on routes whose registry entry declares the `mcp` surface. Wiki
  ingest propose/apply are on that surface; git sync and admin config stay
  browser-only even if the token leaks.
- A Sinapso restart rotates tokens; the bridge re-fetches once on 403 and
  replays the call.
