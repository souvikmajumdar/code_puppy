# Planning Session — 2026-03-13

> **Purpose:** Compact summary of the planning conversation that established
> the VS Code extension project. Use this to quickly re-orient in future sessions.

---

## What we did

1. **Explored the code-puppy codebase** — understood the full project structure,
   agents, tools, plugins, messaging system, and API layer.

2. **Read the `api/` and `command_line/` directories** in detail — understood every
   REST endpoint, WebSocket endpoint, command registry, and the frontend_emitter system.

3. **Created the planning docs** in `docs/vscode-extension/`:
   - `00-current-architecture.md` — full baseline of what code-puppy exposes today
   - `01-gaps-and-risks.md` — 10 gaps identified (3 critical blockers)
   - `02-vision-and-plan.md` — 4-phase roadmap with review checklists

4. **Created the branch** `feature/vscode-extension` off `main`.

5. **Decided on project structure**: extension lives at `extensions/vscode/` inside
   the code-puppy repo for now.

---

## Key decisions made

| Decision | Rationale |
|----------|-----------|
| Extension inside code-puppy repo | Easier coordination while both sides change together |
| Phase 1 = PTY terminal via xterm.js | Gets something working fast, no new code-puppy API needed (except port file) |
| Phase 2 = Structured chat + prompt API | Requires new `POST /api/agent/run` endpoint in code-puppy |
| Phase 3 = VS Code context injection | File/selection/cursor sent with each prompt |
| Phase 4 = Remote ready (SSE + auth) | Corporate network compatibility, TLS, API key auth |
| WebSocket for local, SSE for remote | WS = low latency localhost; SSE = firewall-friendly for remote |
| No commits without explicit instruction | User wants full control over git history |
| Not peeking at `dag-sidebar`/`web-puppy` branches | Learning exercise — build first, compare later |

---

## Critical gaps identified (from 01-gaps-and-risks.md)

| Gap | Severity | Phase to fix |
|-----|----------|-------------|
| G1 — No port discovery | 🔴 Critical | Phase 1 |
| G7 — No prompt submission API | 🔴 Critical | Phase 2 |
| G3 — Unauthenticated PTY shell | 🔴 Critical | Phase 4 |
| G4 — No SSE fallback | 🟡 High | Phase 4 |
| G2 — No authentication | 🔴 Critical | Phase 4 |

---

## What code-puppy already handles well

- **In-session context compaction** — `SummarizationAgent` summarizes old messages
  at 85% context threshold; configurable strategy (summarize or truncate);
  protected 50K token zone for recent messages; defers during tool execution
- **Session persistence** — full history pickled to `~/.code_puppy/subagent_sessions/`
- **Dynamic port** — scans 8090–9010 for a free port (but doesn't write it anywhere — G1)

## What is missing for context management

- No cross-session project memory (proposed: `memory.md` per project — G11)
- Token estimation is a rough heuristic (`len/2.5`) — ~10-30% inaccurate
- No project-scoped persistent memory across sessions

---

## Immediate next steps (Phase 1)

1. **code-puppy change (G1):** Write chosen port to `{STATE_DIR}/api_server.port`
   at startup, delete on shutdown — in `cli_runner.py`
2. **Scaffold extension:** `yo code` → TypeScript, no webpack, sidebar panel
3. **Connect xterm.js** to `/ws/terminal` WebSocket
4. **Handle "not running"** gracefully

---

## User profile notes

- Learning TypeScript / VS Code extension development for the first time
- Comfortable with JavaScript
- Wants to review before each new piece is built — do not build multiple phases at once
- Does not want commits made without explicit instruction
- Interested in understanding the codebase deeply, not just getting something working
