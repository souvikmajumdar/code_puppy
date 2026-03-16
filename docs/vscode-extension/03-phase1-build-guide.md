# Phase 1 Build Guide — PTY Terminal in the Sidebar

**Phase goal:** Embed a working terminal in the VS Code sidebar that connects to
code-puppy's existing PTY WebSocket endpoint (`/ws/terminal`). The user can type
commands and see output exactly as if they had opened a plain terminal — but
without leaving VS Code.

**Sources:**
| Topic | Source |
|---|---|
| VS Code extension anatomy | https://code.visualstudio.com/api/get-started/extension-anatomy |
| WebviewViewProvider API | https://code.visualstudio.com/api/references/vscode-api#WebviewViewProvider |
| Webview guide | https://code.visualstudio.com/api/extension-guides/webview |
| package.json manifest reference | https://code.visualstudio.com/api/references/extension-manifest |
| tsconfig reference | https://www.typescriptlang.org/tsconfig |
| xterm.js | https://xtermjs.org |
| xterm.js addon-fit | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit |
| Node.js release schedule | https://nodejs.org/en/about/previous-releases |

---

## 1. Folder structure

```
extensions/vscode/
├── media/
│   ├── puppy.svg          ← activity-bar icon
│   ├── terminal.html      ← webview HTML template (placeholder tokens)
│   ├── terminal.css       ← webview styles (uses VS Code CSS vars for theming)
│   └── terminal.js        ← xterm.js bootstrap + postMessage bridge
├── src/
│   ├── extension.ts       ← entry point (activate / deactivate)
│   ├── terminalPanel.ts   ← WebviewViewProvider; loads media/terminal.html
│   ├── terminalWebSocket.ts ← WebSocket ↔ PTY connection manager
│   └── portDiscovery.ts   ← reads ~/.code_puppy/api_server.port
├── out/                   ← TypeScript compiler output (git-ignored)
├── node_modules/          ← npm dependencies (git-ignored)
├── package.json           ← VS Code manifest + npm package descriptor
└── tsconfig.json          ← TypeScript compiler config
```

**Why separate media files?**
The xterm.js HTML/CSS/JS was originally inlined as a TypeScript template literal.
Moving it to real files means editors can provide syntax highlighting, linting,
and refactoring support. `terminalPanel.ts` now reads `media/terminal.html` from
disk and substitutes placeholder tokens (`{{NONCE}}`, `{{XTERM_JS}}`, etc.) at
runtime.

**Why is the extension in its own folder?**
`extensions/vscode/` is a self-contained npm package. It has its own
`package.json`, its own `node_modules`, and its own build output. This keeps
it decoupled from the Python package at the repo root — a Python developer
doesn't need Node installed just to work on the CLI.

---

## 2. `package.json`

Every VS Code extension is simultaneously a VS Code manifest and an npm
package. The same file serves both roles.

```json
{
  "name": "code-puppy",
  "displayName": "Code Puppy",
  "description": "AI coding agent powered by code-puppy",
  "version": "0.1.0",
  "engines": { "vscode": "^1.111.0" },
  "categories": ["AI", "Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": { ... },
  "scripts": { ... },
  "devDependencies": { ... },
  "dependencies": { ... }
}
```

### Field-by-field

| Field | Value | Why |
|---|---|---|
| `name` | `code-puppy` | npm package name — must be lowercase, no spaces |
| `displayName` | `Code Puppy` | What VS Code shows in the Extensions panel |
| `version` | `0.1.0` | Semver. VS Code uses this for marketplace updates |
| `engines.vscode` | `^1.111.0` | Minimum VS Code version required. `^` means "this version or newer within the same major". Set to the version you have installed so the API types match |
| `categories` | `["AI", "Other"]` | Used for marketplace filtering |

### `activationEvents`

```json
"activationEvents": ["onStartupFinished"]
```

VS Code extensions are **lazy** — they don't activate until needed. This
field tells VS Code *when* to wake the extension up.

`onStartupFinished` means: activate after VS Code has fully loaded (all
built-in extensions initialised, workbench rendered). It is the right choice
for a sidebar panel because:

- The workbench is ready so `registerWebviewViewProvider` will succeed.
- We don't block VS Code startup.
- The sidebar will appear as soon as the window is open, not only when the
  user opens a specific file type or runs a command.

Other common options for comparison:

| Event | When it fires |
|---|---|
| `onStartupFinished` | After full startup — best for persistent UI panels |
| `onCommand:foo.bar` | Only when that command is invoked — laziest option |
| `onView:viewId` | When the user first opens that specific view |
| `*` | Immediately on startup — avoid unless truly necessary |

### `main`

```json
"main": "./out/extension.js"
```

The compiled JavaScript entry point. TypeScript compiles `src/extension.ts`
→ `out/extension.js`. VS Code loads `out/extension.js` at activation time.

### `contributes`

This is where you declare everything the extension adds to VS Code's UI.
Think of it as a registry — VS Code reads these declarations at install time
without executing any code.

#### `viewsContainers`

```json
"viewsContainers": {
  "activitybar": [
    {
      "id": "code-puppy",
      "title": "Code Puppy",
      "icon": "media/puppy.svg"
    }
  ]
}
```

A **views container** is the clickable icon in the activity bar (the vertical
strip on the far left of the VS Code window — the same place as Explorer,
Source Control, Extensions). Declaring one here creates a new icon slot.

| Field | Meaning |
|---|---|
| `id` | Unique identifier for this container. Referenced later in `views` and in the `workbench.view.extension.<id>` command |
| `title` | Tooltip shown when hovering the icon |
| `icon` | Path to an SVG icon relative to the extension root. Must use `currentColor` so it respects the VS Code theme (light/dark) |

#### `views`

```json
"views": {
  "code-puppy": [
    {
      "type": "webview",
      "id": "codePuppy.terminalView",
      "name": "Terminal",
      "icon": "media/puppy.svg"
    }
  ]
}
```

A **view** is the panel rendered inside the container. The key (`"code-puppy"`)
must match the container `id` above.

| Field | Meaning |
|---|---|
| `type` | `"webview"` means VS Code will call our `WebviewViewProvider` to render arbitrary HTML/CSS/JS. The alternative `"tree"` renders a tree-data provider |
| `id` | Unique id for this view. Must match the string passed to `registerWebviewViewProvider` in `extension.ts` |
| `name` | Label shown at the top of the panel |
| `icon` | Icon shown in the view header — required to suppress a VS Code warning |

#### `commands`

```json
"commands": [
  {
    "command": "codePuppy.openTerminal",
    "title": "Code Puppy: Open Terminal"
  }
]
```

Registers a command that users can invoke from the Command Palette (`⌘⇧P`).
The `command` id must match the string passed to `registerCommand` in
`extension.ts`.

### `scripts`

```json
"scripts": {
  "compile": "tsc -p ./",
  "watch":   "tsc -watch -p ./",
  "lint":    "eslint src"
}
```

| Script | When to use |
|---|---|
| `npm run compile` | One-shot build before packaging or testing |
| `npm run watch` | During development — recompiles on every file save |
| `npm run lint` | Before committing — catches style and type issues |

### `devDependencies` vs `dependencies`

**`devDependencies`** are needed only to build the extension. They are not
bundled into the `.vsix` package:

| Package | Purpose |
|---|---|
| `@types/node` | TypeScript types for Node.js built-ins (`fs`, `path`, etc.) |
| `@types/vscode` | TypeScript types for the VS Code API — must match `engines.vscode` |
| `@types/ws` | TypeScript types for the `ws` WebSocket library |
| `typescript` | The TypeScript compiler (`tsc`) |

**`dependencies`** are shipped inside the `.vsix` and loaded at runtime:

| Package | Purpose |
|---|---|
| `@xterm/xterm` | Terminal renderer — draws characters, handles ANSI escape codes |
| `@xterm/addon-fit` | xterm.js addon that resizes the terminal to fill its container |
| `ws` | WebSocket client — connects to code-puppy's `/ws/terminal` endpoint |

> **Why is `ws` a runtime dependency?**
> The webview HTML runs in a sandboxed browser context that has the browser's
> native `WebSocket`. However `extension.ts` (which runs in Node.js) also
> needs a WebSocket client to proxy messages in certain architectures. For
> Phase 1 we use the browser WebSocket directly from the webview, so `ws` is
> reserved for future phases.

---

## 3. `tsconfig.json`

```json
{
  "compilerOptions": {
    "module": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "out"]
}
```

### Option-by-option

| Option | Value | Why |
|---|---|---|
| `module` | `Node16` | Tells TypeScript to use Node.js 16+ module resolution (supports both CommonJS and ESM). VS Code extensions run in Node.js, not a browser |
| `target` | `ES2022` | Compiled JavaScript will use ES2022 syntax. Node 18+ and VS Code's embedded Node both support this |
| `lib` | `["ES2022"]` | Which built-in type definitions TypeScript includes. `ES2022` covers `Array.at()`, `Object.hasOwn()`, etc. We don't add `"DOM"` because extension code runs in Node.js, not a browser |
| `outDir` | `out` | Where compiled `.js` files go. Referenced by `"main"` in `package.json` |
| `rootDir` | `src` | Where TypeScript source files live. Keeps `out/` structure mirroring `src/` |
| `strict` | `true` | Enables all strict type-checking flags. Catches bugs at compile time rather than runtime |
| `esModuleInterop` | `true` | Allows `import fs from 'fs'` style imports for CommonJS modules that don't have a default export |
| `skipLibCheck` | `true` | Skips type-checking of `.d.ts` files in `node_modules`. Speeds up compilation and avoids errors from third-party type packages |
| `sourceMap` | `true` | Generates `.js.map` files alongside compiled output. VS Code's debugger uses these to map breakpoints back to `.ts` source lines |

### Why no `"DOM"` in `lib`?

Extension code (everything in `src/`) runs inside VS Code's Node.js host —
not a browser. Adding `"DOM"` would give TypeScript the browser's `document`,
`window`, `fetch`, etc., which don't exist at runtime. The webview's HTML
(which *does* run in a browser context) is a string we construct — TypeScript
doesn't type-check it.

---

## 4. `media/puppy.svg`

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="1.5" ...>
  ...
</svg>
```

Two rules VS Code enforces for activity-bar icons:

1. **SVG format** — raster images (PNG, JPG) are not supported for icons.
2. **`currentColor`** — the icon must use `currentColor` for stroke and fill
   rather than hardcoded hex values. VS Code swaps `currentColor` to match
   the active theme (white on dark themes, dark on light themes). A
   hardcoded colour would look wrong or invisible on half of all themes.

The `viewBox="0 0 24 24"` means the icon is designed on a 24×24 grid, which
is the conventional size VS Code renders activity-bar icons at.

---

## 5. `src/extension.ts`

This is the entry point VS Code loads when the extension activates. It
exports exactly two functions: `activate` and `deactivate`.

```typescript
import * as vscode from "vscode";
import { TerminalPanelProvider } from "./terminalPanel";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TerminalPanelProvider(context);

  const viewRegistration = vscode.window.registerWebviewViewProvider(
    TerminalPanelProvider.viewId,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  const commandRegistration = vscode.commands.registerCommand(
    "codePuppy.openTerminal",
    () => {
      vscode.commands.executeCommand("workbench.view.extension.code-puppy");
    }
  );

  context.subscriptions.push(viewRegistration, commandRegistration);
}

export function deactivate(): void {}
```

### Concept: `ExtensionContext`

`context` is passed in by VS Code and is your extension's handle to the
runtime environment. Key members:

| Member | What it gives you |
|---|---|
| `context.subscriptions` | Array of disposables. Anything pushed here is `.dispose()`d automatically when the extension deactivates |
| `context.extensionUri` | URI of the extension's root folder — used to load local files into webviews |
| `context.globalState` | Key-value store that persists across VS Code sessions |
| `context.workspaceState` | Key-value store scoped to the current workspace |

### Concept: `WebviewViewProvider`

A `WebviewViewProvider` is a class with a single required method:

```typescript
resolveWebviewView(webviewView: vscode.WebviewView): void
```

VS Code calls `resolveWebviewView` when it needs to render the view for the
first time (or after a reload). Inside this method you set
`webviewView.webview.html` to the HTML you want to display.

We register the provider with:

```typescript
vscode.window.registerWebviewViewProvider(viewId, provider, options)
```

| Argument | Value | Meaning |
|---|---|---|
| `viewId` | `"codePuppy.terminalView"` | Must match `contributes.views["code-puppy"][0].id` in `package.json` |
| `provider` | our `TerminalPanelProvider` instance | The object whose `resolveWebviewView` VS Code will call |
| `options.webviewOptions.retainContextWhenHidden` | `true` | Keep the webview alive when the sidebar panel is hidden. Without this, the terminal resets every time the user switches to a different activity-bar panel |

### Concept: `context.subscriptions`

VS Code uses the **Disposable** pattern for cleanup. Every `register*` call
returns a `Disposable` — an object with a `.dispose()` method that tears down
the registration.

By pushing registrations onto `context.subscriptions`, we delegate cleanup
to VS Code:

```
extension deactivates
  → VS Code calls .dispose() on everything in context.subscriptions
    → view provider unregistered
    → command unregistered
    → (WebSocket closed by TerminalPanelProvider's own dispose handler)
```

If we didn't push them, the registrations would leak — the command would still
appear in the palette but point at dead code.

### Concept: command wiring

The `codePuppy.openTerminal` command is declared in `package.json`
(so VS Code knows it exists and shows it in the palette) and registered in
`extension.ts` (so it actually does something when invoked).

The handler calls:

```typescript
vscode.commands.executeCommand("workbench.view.extension.code-puppy");
```

This is a built-in VS Code command that focuses an activity-bar container.
The pattern is always `workbench.view.extension.<container-id>`, where
`<container-id>` is the `id` from `contributes.viewsContainers.activitybar`.

---

## 6. `src/portDiscovery.ts`

This file answers one question: what port is code-puppy listening on right now?

code-puppy picks a dynamic port at startup (scanning 8090–9010) and writes it
to a file. `portDiscovery.ts` reads that file.

### State directory resolution

The Python side (in `config.py`) resolves the state directory with this logic:

```python
xdg_base = os.getenv("XDG_STATE_HOME")
if xdg_base:
    return os.path.join(xdg_base, "code_puppy")
return os.path.join(os.path.expanduser("~"), ".code_puppy")  # legacy fallback
```

The TypeScript mirror:

```typescript
function resolveStateDir(): string {
  const xdgStateHome = process.env["XDG_STATE_HOME"];
  if (xdgStateHome) {
    return path.join(xdgStateHome, "code_puppy");
  }
  return path.join(os.homedir(), ".code_puppy");
}
```

**Why must we mirror this exactly?** code-puppy deliberately does NOT use
`~/.local/state/code_puppy` as an automatic fallback — that would only be
used if `$XDG_STATE_HOME` is set. If we used the XDG default instead of the
legacy fallback, we'd look in the wrong directory for most users and never
find the port file.

### Result type — why not throw?

```typescript
export type PortDiscoveryResult =
  | { ok: true; port: number }
  | { ok: false; reason: "not_running" | "bad_content" | "read_error"; detail: string };
```

There are three meaningfully different failure cases:

| `reason` | What it means | Right user message |
|---|---|---|
| `not_running` | File absent (`ENOENT`) | "Is code-puppy running?" |
| `bad_content` | File exists but has garbage | Indicates a code-puppy bug |
| `read_error` | Permissions / I/O failure | System-level problem |

Using a **discriminated union** (the `ok: true / ok: false` pattern) means
TypeScript forces every caller to handle the failure path before accessing
`port`. If we threw instead, callers could skip error handling and crash the
extension with an unhandled exception.

### `ENOENT` vs other errors

```typescript
} catch (err) {
  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr.code === "ENOENT") {
    return { ok: false, reason: "not_running", ... };
  }
  return { ok: false, reason: "read_error", ... };
}
```

`NodeJS.ErrnoException` is the typed form of Node.js filesystem errors. The
`.code` property contains a POSIX error name. `ENOENT` = "Error NO ENTry" =
file not found. Checking `.code` rather than the error message string is
reliable — message text varies by OS and Node version.

---

## 7. `src/terminalWebSocket.ts`

This file owns the WebSocket connection between the extension host and
code-puppy's PTY. It is the data bridge: PTY output flows in → posted to the
webview; keystrokes from the webview → sent to the PTY.

### Architecture: why does the extension host own the WebSocket?

The webview (which renders xterm.js) runs in a sandboxed browser context.
Opening a WebSocket to `ws://127.0.0.1` from inside a webview requires
relaxing the Content Security Policy (`connect-src`). While possible, routing
the connection through the extension host (Node.js) keeps the webview's CSP
strict and gives us a single place to manage the connection lifecycle.

```
[xterm.js in webview]
      │  postMessage (FromWebviewMessage)
      ▼
[TerminalWebSocket in extension host]  ←→  ws://127.0.0.1:{port}/ws/terminal
      │  postMessage (ToWebviewMessage)
      ▼
[xterm.js in webview]
```

### Message types

Two typed unions define the protocol between the extension host and the
webview — this is not WebSocket protocol, it is VS Code's
`webview.postMessage` / `window.addEventListener("message")` channel:

```typescript
// Extension host → webview
type ToWebviewMessage =
  | { type: "data"; payload: string }        // PTY output
  | { type: "connected" }                    // WebSocket opened
  | { type: "disconnected"; reason: string } // WebSocket closed
  | { type: "error"; message: string };      // connection failed

// Webview → extension host
type FromWebviewMessage =
  | { type: "input"; payload: string }              // keystrokes
  | { type: "resize"; cols: number; rows: number }; // terminal resize
```

Using discriminated unions here means `terminalPanel.ts` can use a
`switch (msg.type)` and TypeScript will narrow the type in each branch —
no casting needed.

### Key methods

| Method | What it does |
|---|---|
| `connect()` | Calls `discoverPort()`, builds the `ws://` URL, opens the WebSocket, wires handlers |
| `sendInput(data)` | Forwards raw keystroke strings to the PTY via `ws.send()` |
| `sendResize(cols, rows)` | Sends `{ type: "resize", cols, rows }` JSON — code-puppy's PTY uses this to reflow output |
| `dispose()` | Closes the WebSocket; sets `disposed = true` to prevent reconnection |

### `WebSocket.OPEN` guard

```typescript
sendInput(data: string): void {
  if (this.ws?.readyState === WebSocket.OPEN) {
    this.ws.send(data);
  }
}
```

`?.` is optional chaining — if `this.ws` is `null`, the expression
short-circuits to `undefined` rather than throwing. We also guard on
`readyState === WebSocket.OPEN` because `send()` throws if called on a
closing or closed socket.

### Node.js built-in WebSocket

VS Code's extension host runs on Node.js 20+. Global `WebSocket` was added
in Node 22 (stable in 22.4). Since we target Node 24 (see `.nvmrc`), we can
use the built-in global rather than importing `ws`. This avoids loading an
extra npm package in the extension host.

---

## 8. `src/terminalPanel.ts` and `media/` assets

`terminalPanel.ts` implements `WebviewViewProvider` — the interface VS Code
calls to get the HTML for the sidebar panel. The visual layer (HTML, CSS, JS)
lives in three separate files under `media/`:

| File | Role |
|---|---|
| `media/terminal.html` | HTML skeleton; contains `{{PLACEHOLDER}}` tokens |
| `media/terminal.css` | Styles; uses `--vscode-*` CSS custom properties for theming |
| `media/terminal.js` | xterm.js bootstrap + VS Code ↔ webview message bridge |

### The three jobs of `TerminalPanelProvider`

1. **Produce the webview HTML** — reads `media/terminal.html` from disk and
   replaces all `{{TOKEN}}` placeholders with webview URIs and a CSP nonce
2. **Own `TerminalWebSocket`** — create it, feed it a `postMessage` callback,
   dispose it when the panel closes
3. **Bridge messages** — receive `FromWebviewMessage` from the webview,
   forward to `TerminalWebSocket`; receive `ToWebviewMessage` from
   `TerminalWebSocket`, forward to the webview

### Token substitution

`buildHtml()` reads `media/terminal.html` as plain text and replaces tokens:

```typescript
const replacements: Record<string, string> = {
  "{{CSP_SOURCE}}":   webview.cspSource,
  "{{NONCE}}":        nonce,
  "{{XTERM_JS}}":     xtermUri("@xterm", "xterm", "lib", "xterm.js").toString(),
  "{{XTERM_CSS}}":    xtermUri("@xterm", "xterm", "css", "xterm.css").toString(),
  "{{XTERM_FIT_JS}}": xtermUri("@xterm", "addon-fit", "lib", "addon-fit.js").toString(),
  "{{TERMINAL_CSS}}": mediaUri("terminal.css").toString(),
  "{{TERMINAL_JS}}":  mediaUri("terminal.js").toString(),
};
```

`{{NONCE}}` appears in three places in the HTML (CSP header + two script tags)
so we use `.split(token).join(value)` rather than `.replace()` which only
replaces the first occurrence.

### `resolveWebviewView`

VS Code calls this method once when the panel first becomes visible. The
signature is:

```typescript
resolveWebviewView(webviewView: vscode.WebviewView): void
```

Inside it we do five things in order:

```typescript
// 1. Configure the webview (scripts on, localResourceRoots set)
webviewView.webview.options = { enableScripts: true, localResourceRoots: [...] };

// 2. Create the WebSocket client, give it a postMessage callback
this.wsClient = new TerminalWebSocket((msg) => webviewView.webview.postMessage(msg));

// 3. Handle messages from the webview
webviewView.webview.onDidReceiveMessage((raw) => { ... });

// 4. Set HTML and open WebSocket
webviewView.webview.html = this.buildHtml(webviewView.webview);
this.wsClient.connect();

// 5. Clean up when the panel is closed
webviewView.onDidDispose(() => { this.wsClient?.dispose(); });
```

**Why set HTML before calling `connect()`?**
`connect()` may immediately post a `"connected"` or `"error"` message. The
webview must have its HTML (and therefore its `message` event listener)
already in place before those messages arrive, or they will be silently
dropped.

### `webview.options`

```typescript
webviewView.webview.options = {
  enableScripts: true,
  localResourceRoots: [
    vscode.Uri.joinPath(this.context.extensionUri, "node_modules"),
  ],
};
```

| Option | Why |
|---|---|
| `enableScripts: true` | Required for any JavaScript to run in the webview. Off by default as a security default |
| `localResourceRoots` | Whitelist of directories the webview can load local files from. We restrict to `node_modules/` only — the webview cannot read arbitrary files on disk |

### Webview URIs

Local files cannot be loaded in a webview with plain `file://` paths — VS Code
blocks them. You must convert every local path to a **webview URI** first:

```typescript
const xtermJs = webview.asWebviewUri(
  vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "@xterm", "xterm", "lib", "xterm.js")
);
```

`asWebviewUri()` converts a `vscode.Uri` into a special `vscode-resource://`
scheme URL that the webview sandbox is allowed to load.

### Nonces and Content Security Policy

A **nonce** is a random string generated fresh for each page load. We embed it
in both the CSP header and every `<script>` tag. The browser only executes
inline scripts whose nonce matches the CSP — so even if an attacker injected
a `<script>` into the HTML, it would be blocked because it lacks the nonce.

```html
<meta http-equiv="Content-Security-Policy"
  content="
    default-src 'none';
    style-src 'unsafe-inline' ${webview.cspSource};
    script-src 'nonce-${nonce}' ${webview.cspSource};
    connect-src 'none';
  ">
```

| CSP directive | Value | Why |
|---|---|---|
| `default-src 'none'` | Block everything | Deny-by-default; only what's listed is allowed |
| `style-src 'unsafe-inline'` | Allow inline styles | xterm.js injects inline styles at runtime to position the canvas |
| `style-src ${webview.cspSource}` | Allow webview URIs | Permit the xterm.css file we loaded via `asWebviewUri` |
| `script-src 'nonce-...'` | Allow our inline bootstrap | Only scripts with matching nonce execute |
| `script-src ${webview.cspSource}` | Allow xterm.js from node_modules | Permit the `.js` files loaded via `asWebviewUri` |
| `connect-src 'none'` | Block all network from webview | WebSocket goes through the extension host, not the webview |

### xterm.js configuration and theming

`media/terminal.js` reads VS Code's CSS custom properties from `document.body`
at startup and passes them all into xterm.js:

```javascript
const style = getComputedStyle(document.body);
function cssVar(name, fallback) {
  return style.getPropertyValue(name).trim() || fallback;
}

const term = new Terminal({
  theme: {
    background:  cssVar('--vscode-terminal-background', ...),
    foreground:  cssVar('--vscode-terminal-foreground', ...),
    // ... all 16 ANSI colours, cursor, selectionBackground
  },
  fontFamily: cssVar('--vscode-editor-font-family', 'monospace'),
  fontSize: 13,
  scrollback: 5000,
  convertEol: true,
});
```

| Option | Why |
|---|---|
| `theme` | All 16 ANSI colours + background/foreground read from `--vscode-terminal-ansi*` vars — works on light, dark, and high-contrast themes |
| `fontFamily` | Read `--vscode-editor-font-family` so it uses whatever font the user has configured |
| `scrollback: 5000` | Keep 5000 lines of history in memory — AI output can be long |
| `convertEol: true` | Convert `\r\n` to `\n` — PTY output uses `\r\n` line endings; this prevents double newlines |

**Why the theme was broken on light themes:** The original code hardcoded
`background: '#1e1e1e'` as a fallback. On light themes, VS Code sets
`--vscode-terminal-background` to a light colour but the fallback overrode it.
The fix is to fall back to `--vscode-editor-background` (which is always the
right colour) and then to `transparent` — letting VS Code paint the background.

### `ResizeObserver` for terminal resize

```javascript
const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
});
resizeObserver.observe(document.getElementById('terminal'));
```

`fitAddon.fit()` resizes xterm.js to fill its container. After fitting, we
read the new `cols`/`rows` and send them to the extension host, which forwards
them to the PTY via `sendResize()`. This keeps the PTY and xterm.js in sync —
without it, commands like `top` or `vim` that depend on terminal dimensions
display incorrectly.

### `acquireVsCodeApi()`

```javascript
const vscode = acquireVsCodeApi();
```

This is a function VS Code injects into every webview's global scope. It
returns an object with a `.postMessage()` method — the webview's only channel
back to the extension host. It can only be called once per page load.

---

## 9. `.nvmrc` and `.gitignore`

Two small but important files.

**`.nvmrc`** contains a single line: `24`. When you `cd` into
`extensions/vscode/` and run `nvm use`, nvm reads this file and switches to
Node.js 24 automatically. This ensures everyone working on the extension uses
the same Node version without having to remember to set it manually.

**`.gitignore`** excludes three things:

| Entry | Why |
|---|---|
| `node_modules/` | npm dependencies — hundreds of megabytes, re-installable with `npm install` |
| `out/` | TypeScript compiler output — derived from source, should not be committed |
| `*.vsix` | Packaged extension files — build artifacts, not source |

---

## 10. `extensions/vscode/.env`

This file holds environment variables for local development. It is loaded by
`launch.json` via the `"envFile"` field when you press F5, so it applies to
both the extension host process and (when used with the Python launch config)
the code-puppy process.

**It is git-ignored — never put real API keys in this file.**

### Variables included

| Variable | Value | Why |
|---|---|---|
| `CODE_PUPPY_SKIP_TUTORIAL` | `1` | Skips the first-run onboarding wizard on every dev restart |
| `CODE_PUPPY_NO_TUI` | `1` | Disables the interactive TUI model picker — needed for non-interactive dev runs |
| `NO_VERSION_UPDATE` | `1` | Suppresses version update checks on startup — faster restarts |
| `DBOS_LOG_LEVEL` | `ERROR` | Suppresses DBOS internal logs that would clutter the debug console |
| `XDG_STATE_HOME` | *(commented out)* | Uncomment to redirect state files (port file, PID) to `/tmp/code_puppy_dev` and isolate dev from your real code-puppy data |
| `ANTHROPIC_API_KEY` | *(commented out)* | Uncomment to override the Anthropic key from `puppy.cfg` |
| `OPENAI_API_KEY` | *(commented out)* | Uncomment to override the OpenAI key from `puppy.cfg` |
| `GEMINI_API_KEY` | *(commented out)* | Uncomment to override the Google Gemini key from `puppy.cfg` |

For full details on obtaining and configuring API keys, see
[04-code-puppy-setup-guide.md](04-code-puppy-setup-guide.md) Section 5.

### Why a `.env` file instead of hardcoding in `launch.json`?

`launch.json` is committed to git. `.env` is not. Any value that is
sensitive (API keys) or personal (local path overrides) belongs in `.env`,
not `launch.json`. VS Code's `"envFile"` field is the bridge between them.

---

## 11. `.vscode/launch.json` and `.vscode/tasks.json`

These two files live at the **repo root** (not inside `extensions/vscode/`)
so that VS Code picks them up as workspace-level debug configurations.

### `launch.json` — three configurations + one compound

**1. Launch Extension** (`type: extensionHost`)

The core F5 config. VS Code's built-in extension host launcher:
- Opens a second VS Code window with the Code Puppy extension loaded
- Loads `.env` via `"envFile"` so dev flags are active
- Points `"outFiles"` at `out/**/*.js` so source maps work for breakpoints
- Runs the `npm: compile` task before launch via `"preLaunchTask"` so you're
  always debugging the latest compiled code

**2. Launch code-puppy** (`type: debugpy`)

Starts the Python CLI in VS Code's integrated terminal with the Python
debugger attached. Run this first so code-puppy's API server starts and
writes the port file before the extension activates.

`"justMyCode": true` means the debugger only steps through your code, not
into library internals (FastAPI, asyncio, etc.).

**3. Attach to code-puppy** (`type: debugpy, request: attach`)

For when code-puppy is already running and you want to hook up the debugger
without restarting it. Requires code-puppy to have been started with debugpy
listening on port 5678:

```bash
python -m debugpy --listen 5678 -m code_puppy
```

**Compound: "Launch All"**

Starts both "Launch code-puppy" and "Launch Extension" together with a single
click. `"stopAll": true` means stopping one also stops the other.

### `tasks.json` — two build tasks

**`npm: compile - extensions/vscode`** — one-shot TypeScript compile.
Referenced by `launch.json`'s `"preLaunchTask"` so it runs automatically
on every F5. `"reveal": "silent"` means the task panel doesn't steal focus.

**`watch extension`** — runs `tsc --watch` in the background. Start this once
via Terminal → Run Task → "watch extension" and leave it running for the
whole dev session. Combined with the `Launch Extension` config (which also has
`preLaunchTask`), you get near-instant recompile on every file save.

#### Why does the task use an absolute `npm` path and inject `PATH`?

VS Code task shells are non-interactive — they don't source `~/.zshrc` or load
nvm. This means both `npm` and `node` are missing from `$PATH`.

Two fixes needed:

1. **Absolute npm path** — `command` uses the full nvm path:
   `/Users/souvikmajumdar/.nvm/versions/node/v24.14.0/bin/npm run compile`
2. **PATH injection** — `options.env.PATH` prepends the nvm bin dir:
   ```json
   "env": {
     "PATH": "/Users/souvikmajumdar/.nvm/versions/node/v24.14.0/bin:${env:PATH}"
   }
   ```

Both are required because `npm` itself internally calls `node` via
`#!/usr/bin/env node` — if `node` isn't on PATH, npm exits with code 127 even
though we invoked it via its absolute path.

#### `.vscode/settings.json` — Python interpreter

```json
{
  "python.defaultInterpreterPath": "${workspaceFolder}/.venv/bin/python"
}
```

This tells the VS Code Python extension (Pylance, debugpy) to use the project's
virtualenv without prompting you to select an interpreter on every session.
`${workspaceFolder}` resolves to the repo root automatically.

---

## 12. Phase 1 file status

**Phase 1 is complete and working as of 2026-03-16.**

The sidebar panel now connects to `/ws/puppy` which spawns `pup -i` as the PTY
process, giving you the code-puppy REPL in the panel instead of a plain shell.

**Known gaps (deferred — not blocking Phase 1):**
- **G11** — Must manually run `pup -i` + `/api start` before launching the extension. The API server does not auto-start.
- **G1** — Port file still shows the wrong port (8090-range); extension falls back to 8765 transparently.
- Running code-puppy via "Launch code-puppy" debug config still opens the REPL in VS Code's own integrated terminal — that is a separate process from the PTY spawned by `/ws/puppy`. Both are valid ways to interact with code-puppy; the sidebar panel gives its own fresh REPL session.

Confirmed output in Extension Development Host:

| File | Location | Status | Notes |
|---|---|---|---|
| `package.json` | `extensions/vscode/` | ✅ Done | `@types/vscode` pinned to `^1.110.0` (latest available) |
| `tsconfig.json` | `extensions/vscode/` | ✅ Done | Added `"types": ["node"]` for built-in Node modules |
| `media/puppy.svg` | `extensions/vscode/` | ✅ Done | Activity-bar icon |
| `src/extension.ts` | `extensions/vscode/` | ✅ Done | Entry point, wiring |
| `src/portDiscovery.ts` | `extensions/vscode/` | ✅ Done | TCP-probe + fallback to port 8765 (G1/G11 workaround) |
| `src/terminalWebSocket.ts` | `extensions/vscode/` | ✅ Done | `connect()` made async; message envelope decoded; `sendInput` JSON-wrapped |
| `src/terminalPanel.ts` | `extensions/vscode/` | ✅ Done | Loads `media/terminal.html`; token substitution replaces inline HTML |
| `media/terminal.html` | `extensions/vscode/` | ✅ Done | Webview HTML template with `{{NONCE}}` / `{{XTERM_JS}}` etc. placeholders |
| `media/terminal.css` | `extensions/vscode/` | ✅ Done | Webview styles; uses `--vscode-*` CSS vars for light/dark/HC theme support |
| `media/terminal.js` | `extensions/vscode/` | ✅ Done | xterm.js bootstrap; reads all VS Code CSS colour vars for full ANSI palette |
| `.nvmrc` | `extensions/vscode/` | ✅ Done | Pins Node.js 24 |
| `.gitignore` | `extensions/vscode/` | ✅ Done | Excludes `node_modules/`, `out/`, `.env` |
| `.env` | `extensions/vscode/` | ✅ Done | Dev environment variables (git-ignored) |
| `launch.json` | `.vscode/` | ✅ Done | F5 debug configs for extension + code-puppy |
| `tasks.json` | `.vscode/` | ✅ Done | Build tasks (compile, watch); `PATH` env set so `node` resolves inside npm scripts |
| `settings.json` | `.vscode/` | ✅ Done | `python.defaultInterpreterPath` → `.venv/bin/python` |
| `node_modules/` | `extensions/vscode/` | ✅ Installed | `npm install` completed — 8 packages |
| `out/` | `extensions/vscode/` | ✅ Compiled | `npm run compile` — clean, zero errors |

**Ready for F5 test run.** See Section 13.

---

## 13. How to run the extension locally

### Prerequisites (one-time setup — already done)

```bash
cd extensions/vscode
npm install      # ✅ done — installs @xterm/xterm, ws, @types/node, etc.
npm run compile  # ✅ done — out/extension.js, out/*.js.map generated
```

### Before every F5 session

**Step 1** — Start code-puppy and the API server (separate terminal):

```bash
cd /Users/souvikmajumdar/pilots/sandbox/developer-experience/code_puppy
source .venv/bin/activate
pup -i
```

Then at the `pup>` prompt:

```
/api start
```

Wait for `API server started (PID ...)` — **do not skip this step**.
The extension's WebSocket connects to port 8765; nothing will work without it.

**Step 2** — Open the repo root in VS Code (not `extensions/vscode/`):

```
code /Users/souvikmajumdar/pilots/sandbox/developer-experience/code_puppy
```

**Step 3** — Press **F5** (or Run → Start Debugging → "Launch Extension").

VS Code will:
1. Run `npm run compile` (the `preLaunchTask`) — wait for it to finish
2. Open a second VS Code window — the **Extension Development Host**

**Step 4** — In the Extension Development Host window, click the **dog icon**
in the left activity bar. The Code Puppy terminal panel should appear.

Expected sequence in the panel:
- Brief pause (TCP probe runs to verify port 8765 is up)
- `● connected to code-puppy` status line
- xterm.js renders the code-puppy REPL — the `pup -i` splash screen and `>>` prompt
- You can type prompts directly in the sidebar panel and receive agent responses

### What to check if it doesn't connect

| Symptom | Likely cause | Fix |
|---|---|---|
| Warning toast: "port file not found … fallback port 8765 is not listening" | `/api start` not called | Run `/api start` in the pup REPL |
| WebSocket error immediately | API server crashed silently | Run `python -m code_puppy.api.main` directly to see logs |
| Blank panel, no message | xterm.js failed to load | Open DevTools in the webview (right-click → Inspect Element) |
| `preLaunchTask` fails | TypeScript compile error | Run `npm run compile` in the terminal and read the error |

### Watching for logs

When running under the debugger (F5), `console.log/warn/error` from extension code
appears in the **Debug Console** tab (bottom panel), not Output → Extension Host.
Filter by `Code Puppy` to see only extension messages. In particular:

```
Code Puppy: port file was absent or stale; connected via fallback port 8765.
```

This message is expected during Phase 1 (until the upstream G1/G11 bug is fixed).

The Extension Development Host is a second VS Code window where your extension
runs in isolation. You can set breakpoints in `src/*.ts` and VS Code's debugger
will map them correctly via source maps.
