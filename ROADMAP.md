---
name: Sinapso
last_updated: 2026-07-22
strategy_ref: STRATEGY.md
product_ref: PRODUCT.md
---

# Roadmap

| ID | Horizon | Outcome | Strategy track | Status | Depends on | Success signal | Next artifact |
|----|---------|---------|----------------|--------|------------|----------------|---------------|
| RM001 | Now | Make Inbox the durable working-note workspace shared by users and agents, with research-panel navigation, pin-aware arrival, single-editor ownership, and explicit promotion into wikis | Knowledge partner experience | delivered | - | Users can create, find, edit, pin, and promote Inbox notes without duplicate editors, lost context, or hidden temporary documents | docs/plans/2026-07-18-020-feat-durable-inbox-workspace-plan.md |
| RM002 | Next | Dropped: Manual Inbox Review was deprecated and removed after implementation | Knowledge partner experience | dropped | RM001 | Runtime, routes, controls, state, and tests remain absent | - |
| RM007 | Next | Present grounded results, proposed actions, and decisions as safe interactive cards across Research, Inbox, and agent workflows | Knowledge partner experience | committed | RM001 | Users can understand and act on grounded results through consistent cards while execution remains explicit and guarded | docs/plans/2026-07-22-feat-contextual-workflow-ui-plan.md |
| RM008 | Later | Turn a learner's objective into a grounded learning route, using knowns, assumptions, and knowledge gaps as visible factors for what to investigate and present, then form a guide, practice, and review loop around the learner's preferred way of learning | Knowledge partner experience | exploring | RM007 | Users can pursue an explicit learning objective, inspect relevant gaps and grounded material, and retain a durable learning route without a chat transcript | - |
| RM003 | Later | Dropped: persistent Inbox Review routines were invalidated with RM002 | Knowledge partner experience | dropped | RM002 | No background review routine or unattended action is introduced | - |
| RM004 | Later | Provide opt-in encrypted synchronization, backup, recovery, and versioning while local Markdown remains canonical | Secure knowledge continuity | exploring | - | Active users can recover and continue their knowledge world across devices without surrendering file ownership | - |
| RM005 | Later | Deliver a mobile companion for grounded conversation, research, decisions, capture, search, and reading | Secure knowledge continuity | exploring | RM004 | Mobile users complete recurring value sessions against the same privately synchronized knowledge world | - |
| RM006 | Later | Enable selective document sharing that gives recipients immediate value and a path into their own Sinapso workspace | Share-to-growth loop | exploring | RM004 | Shared-document recipients activate and complete a first grounded value session | - |
