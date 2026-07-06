---
title: Git Note Versions - Plan
type: feat
date: 2026-07-06
topic: git-note-versions
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Git Note Versions - Plan

## Goal Capsule

- **Objective:** When the active knowledge base is backed by Git, let the reader show a note's commit history, open an older version, and restore that older version into the current file.
- **Product authority:** User request in this session. Product Contract preservation: new plan bootstrapped directly from the request.
- **Execution profile:** Server-first, security-sensitive. Git reads are safe subprocess calls; restore is a vault write and must use `server/integrations/write.ts`.
- **Stop conditions:** Stop and ask before adding diff views, branch switching, arbitrary refs, Git commits from Solaris, repo-wide checkout/reset/revert, or version indexing in `graph.json`.
- **Open blockers:** None.

---

## Product Contract

### Summary

Solaris already reads the current Markdown content for a selected note. If the active vault is inside a Git repository, the reader should expose lightweight version history for that same note. The first version is intentionally small: list historical commits, preview a selected commit's file content in the existing reader, and offer a restore button that replaces only that current file's working-copy content with the selected historical content after confirmation. It must not move Git HEAD, check out a commit, reset the repo, revert commits, or touch any other file.

### Requirements

- R1. Detect whether the active vault is inside a Git worktree.
- R2. For a real note, return a bounded commit history for that file.
- R3. Preserve the existing `/api/note` path traversal and `.md` guard semantics for every version endpoint.
- R4. Let the reader show a compact `Versions` control only when history is available.
- R5. Opening a historical version renders sanitized Markdown in the existing reader and clearly marks it as an old version.
- R6. The old-version view has a `Restore` button.
- R7. Restore requires confirmation, is token-guarded, writes only the current note file through `guardedEdit()`, journals the edit, and then reloads the current note. It never runs `git checkout`, `git reset`, `git revert`, or any command that changes repository state.
- R8. If the vault has no Git repository, Git is unavailable, or the file has no history, the reader behaves exactly as it does today.

### Key Flows

- F1. View current note with Git history
  - **Trigger:** User opens a real `.md` note whose vault is inside Git.
  - **Steps:** Reader fetches the current note, fetches its version list, and shows a `Versions` control with commit date/message entries.
  - **Outcome:** Current reader behavior remains, with version navigation available.
  - **Covers:** R1, R2, R4.

- F2. Preview old version
  - **Trigger:** User selects a commit from `Versions`.
  - **Steps:** Solaris asks the server for that commit's content, renders it in the reader, and shows an old-version banner.
  - **Outcome:** User can inspect old content without changing the vault.
  - **Covers:** R3, R5.

- F3. Restore old version for the current note only
  - **Trigger:** User clicks `Restore` while previewing a historical version.
  - **Steps:** Browser asks for confirmation, posts the current note id and selected commit to a token-guarded restore route, server re-reads only that file at that commit via Git, writes only that note through `guardedEdit()`, and reader reloads the current note.
  - **Outcome:** That one Markdown file's working-copy content becomes the selected historical content, with a normal Solaris changelog entry. The Git repository remains on the same branch and commit.
  - **Covers:** R6, R7.

### Acceptance Examples

- AE1. Given a vault with no `.git`, when a note opens, then no `Versions` control is shown and no error appears.
- AE2. Given a Git-backed vault with two commits for `real.md`, when `/api/note-versions?id=real.md` is called, then it returns two bounded history entries with hash, timestamp, author, and subject.
- AE3. Given `id=../../etc/passwd`, when any version endpoint is called, then it is rejected with the same style as `/api/note`.
- AE4. Given a selected old commit, when the user previews it, then the reader renders that commit's Markdown and shows that it is not the current working copy.
- AE5. Given an old version preview, when the user cancels restore, then no file changes.
- AE6. Given an old version preview, when the user confirms restore, then only the current note content equals the old commit content, `data/changes.jsonl` records an edit, and no other tracked file changes because of the restore.

### Scope Boundaries

**In scope**

- Current branch/file history only.
- Markdown note files already addressable by graph node `id`.
- Restore the current note file's working-copy content from that same file at a selected commit.

**Deferred for later**

- Side-by-side diff UI.
- Restore as a Git commit.
- Repo-wide checkout/reset/revert to an older commit.
- Branch, tag, or stash browsing.
- Searching historical versions.
- Showing deleted files not present in the current graph.

**Outside this product's identity**

- Arbitrary filesystem history browsing outside the active vault.
- Direct browser writes or a second vault writer outside `server/integrations/write.ts`.
- Shell execution built from string interpolation.

### Sources and Research

- Existing read pattern: `/api/note`, `/api/note-lines`, and `/api/note-grep` in `server/app.ts` already guard note ids.
- Existing write contract: `server/integrations/write.ts` is the single sanctioned vault writer and journals edits.
- Existing subprocess pattern: `server/integrations/detect.ts` uses injectable `execFile` via `realRunner`; `server/integrations/qmd.ts` keeps CLI integration behind small functions.
- Existing reader pattern: `web/src/main.ts` `openReader()` fetches Markdown, sanitizes via DOMPurify, then appends async reader sections.
- External research: skipped. This uses standard Git CLI behavior and established local patterns.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Git lives behind a small adapter in `server/integrations/git.ts`. Keep Git subprocess details out of route handlers and make the runner injectable for tests.
- KTD2. Use `execFile`, never shell strings. Commands pass args arrays only: `rev-parse`, `log --follow`, and `show`.
- KTD3. Validate note id before Git. Reuse the `/api/note` confinement logic by extracting a shared helper or duplicating the same minimal guard near the new routes if extraction would churn too much.
- KTD4. Restore re-reads the selected file at the selected commit server-side. The browser should send `id` and `commit`, not trusted Markdown content.
- KTD5. `Restore` is a normal Solaris edit. It goes through `guardedEdit(writeDeps(), { actor: "user", mode: "full" })`; no Git commit is created.
- KTD5a. Restore must not mutate Git state. The only Git command in the restore path is read-only content lookup, followed by `guardedEdit()` for the one current note file.
- KTD6. UI stays inside the reader header/body. No new page, no modal unless the existing browser `confirm()` is enough for the MVP.

### High-Level Technical Design

```mermaid
flowchart TB
  Reader[reader note open] --> Note[/api/note]
  Reader --> Versions[/api/note-versions]
  Versions --> Git[git adapter]
  Reader --> Version[/api/note-version]
  Version --> Git
  Reader --> Restore[/api/note-version/restore]
  Restore --> Git
  Restore --> Write[guardedEdit in write.ts]
  Write --> Vault[(current markdown)]
  Write --> Log[(data/changes.jsonl)]
```

### Directional Data Shape

```ts
interface NoteVersion {
  commit: string;
  committedAt: string;
  author: string;
  subject: string;
}
```

### Assumptions

- `git` is available on systems where the user expects Git-backed version history. If unavailable, endpoints return `available: false`.
- The active vault may be a subdirectory of a larger Git repository, so Git paths must be relative to the repo root, not necessarily the vault root.
- File names may contain spaces. All Git paths are passed as args and after `--`.

---

## Implementation Units

### U1. Add Git adapter and version endpoints

- **Goal:** Expose safe read-only Git history/content endpoints plus one guarded restore endpoint.
- **Requirements:** R1, R2, R3, R7, R8.
- **Files:** `server/integrations/git.ts`, `server/integrations/git.test.ts`, `server/app.ts`, `server/app.test.ts`.
- **Approach:** Implement adapter functions for repo detection, file history, and file content at a commit. Resolve `vaultRoot` to the Git top-level via `git -C <vaultRoot> rev-parse --show-toplevel`. Convert the guarded full note path to a repo-relative path. Parse `git log --follow --format=%H%x00%ct%x00%an%x00%s -- <path>` into bounded entries. Read historical content via `git -C <repoRoot> show <commit>:<repoRelativePath>`. Add `GET /api/note-versions`, `GET /api/note-version`, and token-guarded `POST /api/note-version/restore`. The restore route must never run Git state-changing commands; it only reads historical content and writes the current `id` through `guardedEdit()`.
- **Patterns to follow:** `realRunner` and `Runner` in `server/integrations/detect.ts`; note id guard in `/api/note`; write failure handling and `guardedEdit()` usage in existing write routes.
- **Test scenarios:** no Git repo returns `available:false`; Git repo returns ordered history; spaces in filenames work; traversal and non-`.md` ids are rejected; invalid commit is rejected; restore without token is forbidden; restore with token writes old content only to that note and appends changelog; restore does not change sibling files or Git HEAD; restore of missing file returns 404/400 without writing.
- **Verification:** `npm test -- server/integrations/git.test.ts server/app.test.ts` and `npm run typecheck`.

### U2. Add reader versions UI and restore action

- **Goal:** Let users inspect and restore old versions from the existing reader.
- **Requirements:** R4, R5, R6, R8.
- **Files:** `web/index.html`, `web/src/main.ts`, `web/src/style.css`, `web/src/i18n.ts`.
- **Approach:** Add a compact hidden `Versions` select/button area near the reader actions. On successful current-note load, fetch `/api/note-versions?id=...` asynchronously. If available with entries, show the control. Selecting a version fetches `/api/note-version`, renders it through the same Markdown stripping, wikilink preparation, `marked`, and DOMPurify path used by `openReader()`, then shows a banner with commit metadata and a `Restore` button. `Restore` confirms, posts `{ id, commit }` with the existing session token helper, then reopens the current note.
- **Patterns to follow:** `openReader()` sanitization path, reader history nav controls, `apiToken()` mutating route pattern, existing i18n keys in `web/src/i18n.ts`.
- **Test scenarios:** Frontend has no test framework; manual checklist covers unavailable Git, visible history, old-version banner, cancel restore, confirm restore, and normal current-note reload.
- **Verification:** `npm run typecheck`, `npm run build`, manual `npm run dev` smoke with a scratch Git vault.

### U3. Document the version-history behavior

- **Goal:** Make the Git-backed feature and restore semantics discoverable.
- **Requirements:** R1, R6, R7, R8.
- **Files:** `README.md`, `CLAUDE.md`.
- **Approach:** Add a short note that Git-backed vaults can show note versions, restore writes only the selected note file in the working copy, does not create a Git commit, and does not roll the repository back to an older commit.
- **Patterns to follow:** existing local-first and trust-model language.
- **Test scenarios:** Documentation only; reviewed manually.
- **Verification:** Manual doc read.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Unit and route tests | `npm test -- server/integrations/git.test.ts server/app.test.ts` | U1 |
| Full test suite | `npm test` | U1 regression safety |
| Type safety | `npm run typecheck` | U1, U2 |
| Production build | `npm run build` | U2 |
| Manual web smoke | `npm run dev` | U2 restore flow |

Manual checklist:

- Open a note in a non-Git vault: no versions control, no error.
- Open a note in a Git vault: versions control appears with commit metadata.
- Select an old version: reader banner says it is historical content.
- Cancel restore: file content and changelog stay unchanged.
- Confirm restore: only the current file content changes, changelog records edit, reader reloads current content, and Git HEAD stays unchanged.
- Try traversal id against every new endpoint: rejected.

---

## Definition of Done

- Git-backed vaults expose per-note history in the reader.
- Historical previews are read-only until the user confirms restore.
- Restore writes only the selected note through `server/integrations/write.ts`, journals the edit, does not create a Git commit, and does not move the repo to an older commit.
- Non-Git vaults behave exactly as before.
- `npm test`, `npm run typecheck`, and `npm run build` pass.
- No diff UI, branch browser, repo checkout/reset/revert, historical search, or second vault writer is added.
