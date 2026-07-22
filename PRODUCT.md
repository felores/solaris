---
name: Sinapso
last_updated: 2026-07-18
strategy_ref: STRATEGY.md
---

# Sinapso

## Product Promise

Sinapso makes a user-owned knowledge world available as a grounded partner for exploration, research, synthesis, and decisions while keeping portable Markdown and YAML files under the user's control.

## Primary User and Job

Independent knowledge operators, including consultants, researchers, founders, and analysts, use Sinapso to recover relevant context, discover connections, and turn accumulated knowledge into durable work without rebuilding their history in every tool or conversation.

## Product Principles

- **User ownership is non-negotiable.** Markdown and YAML remain portable and canonical.
- **Local capability comes first.** Core reading, editing, search, and visualization work without a required account or managed service.
- **Knowledge must act.** Research and decisions should produce durable artifacts, not disposable chat history.
- **External action is explicit.** Network access, AI spending, and repository synchronization happen only through user-triggered paths.
- **Vendor independence is a feature.** Obsidian and model providers are optional integrations, not foundations the product cannot outlive.

## Current Experience

The desktop and local web application scans a folder of linked Markdown into a navigable 3D graph. Users can open and edit notes beside the graph, search their vault, ingest external material, conduct grounded voice and text workflows, and preserve useful results as files in the same knowledge system.

## Current Capabilities

- Incremental scanning of linked Markdown and YAML metadata into a local graph.
- Large-vault 3D navigation, filtering, grouping, clustering, and saved layouts.
- An always-editable Markdown reader with guarded autosave and version recovery.
- Keyword, literal, path, and optional local semantic discovery.
- Explicit, user-triggered web research and model-assisted synthesis using user-provided keys.
- Document and URL ingestion with preview and guarded writes into the vault.
- Real-time voice navigation, discovery, research, and drafting.
- CLI and MCP access to the same loopback product tools.
- Explicit Git commit and synchronization workflows for vaults that use Git.

## Planned Product

- Opt-in private synchronization, encrypted backup, recovery, and versioning as managed continuity services.
- A mobile companion focused first on conversation, research, decisions, search, capture, and reading.
- Selective document sharing that gives recipients immediate value and a path into their own Sinapso workspace.

Planned capabilities are not shipped commitments. `ROADMAP.md`, when present, owns their outcome sequence and status.

## Business Model

The local platform remains free, open source, and usable without an account. AI providers remain bring-your-own-key where applicable. Optional paid continuity earns recurring revenue by removing synchronization, recovery, backup, and mobile operational work rather than charging users to access their own files.

## Trust and Ownership

- The current core binds to loopback and keeps scanning, rendering, reading, and local search on the user's machine.
- External Web, LLM, and Git actions require explicit user action and applicable consent or credentials.
- Secrets stay outside the vault and are never returned by product APIs.
- App-authored note writes use the guarded, journaled write path.
- Managed continuity must preserve local files as canonical rather than replacing them with a cloud-only format.

## Design Context

- **Register:** product.
- **Experience qualities:** fast, quiet, spatial, direct, and trustworthy.
- **Interaction principle:** expose the knowledge and the next useful action without turning the interface into a chatbot transcript or activity feed.
- **Accessibility:** preserve readable non-3D paths to notes and controls; no project-wide WCAG target is currently specified.

## Deliberate Boundaries

The current strategic exclusions are maintained in `STRATEGY.md`: full real-time collaboration and complex permissions, enterprise administration, and full mobile 3D parity are deferred until their preceding demand signals are proven.

## Document Ownership

- `STRATEGY.md`: direction, metrics, tracks, and exclusions.
- `PRODUCT.md`: product promise, current/planned experience, business model, and trust contract.
- `ROADMAP.md`: mutable outcome sequence when created.
- `CONTEXT.md`: optional canonical domain vocabulary when ambiguity exists.
- `README.md`: installation, configuration, and usage documentation.
- `docs/plans/` and `docs/solutions/`: durable implementation plans and tactical learnings.
