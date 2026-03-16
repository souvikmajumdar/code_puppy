# Debug Session Steps

Follow these steps in order every time you want to test the extension.

---

## Step 1 — Start the API server (once per machine restart)

Open a terminal and run:

```bash
cd /Users/souvikmajumdar/pilots/sandbox/developer-experience/code_puppy
source .venv/bin/activate
source extensions/vscode/.env
python -m code_puppy.api.main
```

The `source extensions/vscode/.env` step is critical — it sets `ANTHROPIC_API_KEY` in
the API server's environment. The PTY spawned by `/ws/puppy` inherits this environment,
so without it `pup -i` cannot call the Anthropic API.

Leave this terminal open. You will see WebSocket connections logged here.

Verify it is up:
```bash
curl -s http://127.0.0.1:8765/health
```
Expected: `{"status": "ok", ...}`

---

## Step 2 — Compile the TypeScript

In a separate terminal:

```bash
cd /Users/souvikmajumdar/pilots/sandbox/developer-experience/code_puppy/extensions/vscode
/Users/souvikmajumdar/.nvm/versions/node/v24.14.0/bin/npm run compile
```

Expected: exits with no errors. If there are TypeScript errors, fix them before continuing.

---

## Step 3 — Stop any running Extension Development Host

In VS Code: click the red square stop button in the debug toolbar (or Shift+F5).

---

## Step 4 — Launch the extension

In VS Code (the **original** window, where this repo is open):

- Run menu → **Start Debugging** (or press **F5**)
- Select **"Launch Extension"** if prompted
- VS Code will open a second window (the Extension Development Host)

If VS Code asks "Debug Anyway" because the preLaunchTask failed — click **"Debug Anyway"** only if Step 2 compiled cleanly. If Step 2 failed, fix the errors first.

---

## Step 5 — Open the Code Puppy panel

In the **Extension Development Host** window (the second window):

- Click the Code Puppy icon in the Activity Bar (left sidebar)
- The terminal panel should appear

---

## Step 6 — Read the logs

In the **original** VS Code window:

- **Debug Console** tab (bottom panel, next to Terminal)
- Filter by: `Code Puppy`

You should see:
```
Code Puppy: loading template from /path/to/media/terminal.html
Code Puppy: WebSocket opened → ws://127.0.0.1:8765/ws/puppy
```

> Note: Output → "Extension Host" shows VS Code infrastructure logs, NOT `console.log` from extension code. Use Debug Console instead.

In the **API server terminal** (Step 1), you should see:
```
INFO:     127.0.0.1:XXXXX - "WebSocket /ws/puppy" [accepted]
```

---

## What each failure means

| Symptom | Cause | Fix |
|---|---|---|
| No `Code Puppy:` lines in Extension Host | Old compiled code is running | Redo Steps 2–4 |
| `failed to read media/terminal.html` | Wrong `extensionUri` path | Check that `media/` folder exists in the extension directory |
| `✗ WebSocket error` with no Extension Host logs | `connect()` never called — `buildHtml()` threw | Look for error notification popup in the Extension Development Host window |
| `✗ WebSocket error` with `WebSocket opened` log | Server closed connection after accepting | Check the API server terminal for a Python traceback |
| Extension Development Host window doesn't open | Compile failed silently | Check Terminal panel in original window for tsc errors |
