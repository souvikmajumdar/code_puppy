# Observability Guide — code-puppy + VS Code Extension

> **Purpose:** Know exactly where to look when something goes wrong.
> Covers the current dev baseline (Phase 1) and lays the groundwork for
> structured telemetry in later phases.
>
> **Scope:** Local development only. Remote/production telemetry is a Phase 4+ concern.

---

## 1. The Three Log Sources

There are three completely separate processes involved, each with its own logs:

```
┌─────────────────────────────────────────────────────────────────┐
│  Process 1: code-puppy REPL (pup -i)                            │
│  Logs: your terminal window — stdout only (no log file)         │
├─────────────────────────────────────────────────────────────────┤
│  Process 2: code-puppy API server (uvicorn)                     │
│  Logs: DISCARDED (stdout/stderr → /dev/null) — Gap G13          │
│  Workaround: run directly to see logs (see Section 3)           │
├─────────────────────────────────────────────────────────────────┤
│  Process 3: VS Code Extension Host (Node.js)                    │
│  Logs: VS Code → Output panel → "Extension Host" channel        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Where to look in VS Code

### 2.1 Extension code logs (most useful for WebSocket errors)

When running under the debugger (F5), `console.log()`, `console.warn()`, `console.error()`
from extension TypeScript code go to the **Debug Console**, not Output.

**Debug Console** tab (next to Terminal/Output in the bottom panel) → filter by `Code Puppy`

Key messages to look for:

| Message | Meaning |
|---|---|
| `Code Puppy: loading template from /path/to/terminal.html` | `buildHtml()` ran — template found |
| `Code Puppy: port file was absent or stale; connected via fallback port 8765` | Normal — port file mismatch (G1), using fallback |
| `Code Puppy: WebSocket opened → ws://127.0.0.1:8765/ws/puppy` | Connection succeeded |
| `Code Puppy: ws message type="output"` | Terminal output streaming |
| `Code Puppy: WebSocket closed code=XXXX` | See Section 5 for close code meanings |

> **Note:** Output → "Extension Host" shows VS Code infrastructure logs (extension activation
> events, etc.), not `console.log` output from extension code. Do not look there for Code Puppy logs.

### 2.2 Webview DevTools (for xterm.js / UI errors)

In the **Extension Development Host** window (the second VS Code window):

1. Open the Code Puppy sidebar panel
2. Right-click anywhere inside the terminal panel → **"Open WebView Developer Tools"**
   *(or: Cmd+Shift+P → "Developer: Open Webview Developer Tools")*
3. Look at the **Console** tab for JavaScript errors
4. Look at the **Network** tab — you will NOT see WebSocket frames here because
   the WebSocket is owned by the extension host, not the webview. The webview
   only sends/receives postMessages.

### 2.3 Extension Development Host output

In the **original** VS Code window (where you pressed F5):

- **Terminal panel** → shows the `npm: compile` preLaunchTask output
- **Debug Console** → shows anything written via `console.log` if you set a breakpoint
- **Output → "Extension Host"** → runtime logs from the extension

---

## 3. Seeing API server logs (Gap G13 workaround)

`/api start` in the REPL launches uvicorn with `stdout=DEVNULL, stderr=DEVNULL`
(see `code_puppy/tools/terminal_tools.py`). All FastAPI/uvicorn logs are thrown away.

**Workaround — run the server directly in a terminal:**

```bash
cd /Users/souvikmajumdar/pilots/sandbox/developer-experience/code_puppy
source .venv/bin/activate
python -m code_puppy.api.main
```

This prints uvicorn logs directly to your terminal, including:

```
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8765 (Press CTRL+C to quit)
INFO:     127.0.0.1:XXXXX - "WebSocket /ws/puppy" [accepted]
INFO:     connection open
```

You will also see the `/ws/puppy` WebSocket connection attempt and any
Python-side errors from `websocket.py` when the extension connects.

**When debugging WebSocket connection errors, always use this method** — it is
the only way to see what the server is doing.

### 3.1 Enabling Python logging in the server

code-puppy does not call `logging.basicConfig()` (Gap G12), so Python
`logger.info()`/`logger.debug()` calls are silently dropped even when running
directly.

To enable them, set the log level before starting:

```bash
PYTHONPATH=. python -c "
import logging
logging.basicConfig(level=logging.DEBUG, format='%(name)s %(levelname)s %(message)s')
from code_puppy.api.main import app
import uvicorn
uvicorn.run(app, host='0.0.0.0', port=8765)
"
```

Or patch `code_puppy/api/main.py` temporarily to add `logging.basicConfig()` at
the top of the file during debugging sessions.

---

## 4. Diagnosing the WebSocket error: step by step

When the panel shows `✗ WebSocket error — see disconnect reason`, work through
this checklist in order:

### Step 1 — Is the API server actually running?

```bash
curl -s http://127.0.0.1:8765/health | python3 -m json.tool
```

Expected: `{"status": "ok", ...}`
If curl fails or times out: the server is not running → run `python -m code_puppy.api.main`

### Step 2 — Does the `/ws/puppy` endpoint exist on the running server?

FastAPI does **not** expose WebSocket routes in the OpenAPI spec (`/openapi.json`).
The only way to verify a WebSocket endpoint exists on a running server is to
actually connect to it (Step 3 below), or to check the source directly:

```bash
grep -n "ws/puppy" \
  /Users/souvikmajumdar/pilots/sandbox/developer-experience/code_puppy/code_puppy/api/websocket.py
```

If that grep returns nothing, the endpoint hasn't been added yet.
If it returns the `@app.websocket("/ws/puppy")` line, the code is there — but
the **running** server may still be old code. Restart the server to pick it up.

### Step 3 — Can you connect to `/ws/puppy` manually?

```bash
# Install wscat if needed: npm install -g wscat
wscat -c ws://127.0.0.1:8765/ws/puppy
```

You should see the code-puppy REPL output streaming in. If this works but the
extension doesn't, the bug is in the extension. If this fails, the bug is in
the server.

### Step 4 — Check the Extension Host log

View → Output → "Extension Host". Look for:
- `Code Puppy: port file was absent or stale` — normal, using 8765
- Any error stack trace from `portDiscovery.ts` or `terminalWebSocket.ts`

### Step 5 — Check the server logs

Run the server with `python -m code_puppy.api.main` (see Section 3) and watch
for the WebSocket connection being accepted or rejected.

---

## 5. What each WebSocket close code means

When the panel shows `○ disconnected: code XXXX`, the close code tells you why:

| Code | Meaning | Likely cause |
|---|---|---|
| `1000` | Normal closure | Panel closed, extension deactivated |
| `1001` | Going away | VS Code window closed |
| `1006` | Abnormal — no close frame | Server crashed mid-connection, or TCP reset |
| `1011` | Server error | Python exception in `websocket_puppy()` |
| `4000–4999` | App-defined | Not used yet in code-puppy |

Code `1006` is the most common in dev. It means the server-side PTY process
died or the server threw an uncaught exception. Run the server directly
(Section 3) to see the Python traceback.

---

## 6. State files — what exists and where

| File | Path | Contains | When written |
|---|---|---|---|
| Port file | `~/.code_puppy/api_server.port` | Port number (wrong — G1) | REPL startup |
| PID file | `~/.code_puppy/api_server.pid` | uvicorn process PID | `/api start` |
| Session history | `~/.code_puppy/terminal_sessions.json` | PTY session IDs | Each PTY session |
| Config | `~/.code_puppy/puppy.cfg` | API keys, model, agent | First run |

```bash
# Quick health snapshot
echo "=== port file ===" && cat ~/.code_puppy/api_server.port
echo "=== pid file ===" && cat ~/.code_puppy/api_server.pid 2>/dev/null || echo "(none)"
echo "=== process ===" && ps aux | grep uvicorn | grep -v grep
echo "=== tcp listen ===" && lsof -iTCP -sTCP:LISTEN | grep 876
```

---

## 7. Future telemetry — baseline for Phase 4+

This section captures what structured telemetry should look like once we build it.
Not implemented yet — for planning purposes only.

### 7.1 What we want to instrument

| Event | Where | Why |
|---|---|---|
| Extension activated | Extension Host | Baseline activation metric |
| WebSocket connect attempt | Extension Host | Funnel: how often does it try? |
| WebSocket connected / failed | Extension Host | Connection success rate |
| Port discovery source (file vs fallback) | Extension Host | Measure G1 impact |
| PTY session created / closed | API server | Session duration |
| `/ws/puppy` connection accepted | API server | Correlate with extension events |
| `pup` process exit code | API server | Did the REPL crash? |
| Prompt submitted | Extension Host | Usage |
| Response received | Extension Host | Latency (submit → first token) |

### 7.2 Recommended approach (Phase 4)

- **Extension side:** VS Code Telemetry API (`@vscode/extension-telemetry`) — respects user's telemetry opt-out setting automatically
- **Server side:** structured JSON logging via Python `structlog` or `python-json-logger` — replaces the current `logging.basicConfig()` gap (G12)
- **Correlation:** generate a `session_id` UUID on WebSocket connect and include it in all log lines on both sides — lets you join extension logs with server logs for a single session

### 7.3 Gaps to fix before telemetry is useful

| Gap | Fix needed |
|---|---|
| G12 — No logging in server | Call `logging.basicConfig()` in `main.py`; add structured formatter |
| G13 — API server output discarded | Remove `DEVNULL` from `terminal_tools.py`; write to a log file |
| G14 — No `--debug` flag | Add `--log-level` argparse argument in `cli_runner.py` |

---

## 8. Quick reference card

```
WHEN THE PANEL SHOWS AN ERROR:

1. curl http://127.0.0.1:8765/health
   → fails? Server not running. Run: python -m code_puppy.api.main

2. View → Output → "Extension Host"  (⌘⇧U then pick from dropdown)
   → look for "Code Puppy:" lines

3. Right-click panel → "Open WebView Developer Tools" → Console
   → look for JavaScript errors

4. Run server directly to see Python logs:
   python -m code_puppy.api.main
   → watch for WebSocket accept/reject and Python tracebacks

5. Test the endpoint manually:
   wscat -c ws://127.0.0.1:8765/ws/puppy
   → works? Bug is in extension. Fails? Bug is in server.
```
