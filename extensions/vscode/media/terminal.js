/**
 * Code Puppy — terminal webview bootstrap
 *
 * Runs inside the VS Code webview sandbox (browser-like environment).
 * Loaded via a webview URI so it is subject to the extension's CSP.
 *
 * Responsibilities:
 *  1. Read VS Code CSS custom properties to build a matching xterm.js theme.
 *  2. Initialise xterm.js with the FitAddon.
 *  3. Bridge messages in both directions:
 *       window 'message' event  →  term.write()
 *       term.onData()           →  vscode.postMessage({ type: 'input', ... })
 *       ResizeObserver          →  vscode.postMessage({ type: 'resize', ... })
 */

(function () {
  'use strict';

  // ── 1. Read VS Code theme colours ─────────────────────────────────────────
  //
  // VS Code injects its CSS custom properties on <body>. We read them here
  // so xterm.js matches the active theme (light, dark, high-contrast, etc.).
  // If a variable is missing we fall back to sensible defaults that work
  // on both light and dark themes.

  const style = getComputedStyle(document.body);

  function cssVar(name, fallback) {
    return style.getPropertyValue(name).trim() || fallback;
  }

  const termBackground  = cssVar('--vscode-terminal-background',
                                 cssVar('--vscode-editor-background', 'transparent'));
  const termForeground  = cssVar('--vscode-terminal-foreground',
                                 cssVar('--vscode-editor-foreground', '#cccccc'));
  const termCursor      = cssVar('--vscode-terminalCursor-foreground', termForeground);
  const termCursorAccent= cssVar('--vscode-terminalCursor-background', termBackground);
  const termSelection   = cssVar('--vscode-terminal-selectionBackground', 'rgba(255,255,255,0.3)');
  const editorFont      = cssVar('--vscode-editor-font-family', 'monospace');

  // ANSI colours — fall back to VS Code terminal palette, then to classic xterm colours.
  const ansiBlack   = cssVar('--vscode-terminal-ansiBlack',   '#000000');
  const ansiRed     = cssVar('--vscode-terminal-ansiRed',     '#cd3131');
  const ansiGreen   = cssVar('--vscode-terminal-ansiGreen',   '#0dbc79');
  const ansiYellow  = cssVar('--vscode-terminal-ansiYellow',  '#e5e510');
  const ansiBlue    = cssVar('--vscode-terminal-ansiBlue',    '#2472c8');
  const ansiMagenta = cssVar('--vscode-terminal-ansiMagenta', '#bc3fbc');
  const ansiCyan    = cssVar('--vscode-terminal-ansiCyan',    '#11a8cd');
  const ansiWhite   = cssVar('--vscode-terminal-ansiWhite',   '#e5e5e5');

  const ansiBrightBlack   = cssVar('--vscode-terminal-ansiBrightBlack',   '#666666');
  const ansiBrightRed     = cssVar('--vscode-terminal-ansiBrightRed',     '#f14c4c');
  const ansiBrightGreen   = cssVar('--vscode-terminal-ansiBrightGreen',   '#23d18b');
  const ansiBrightYellow  = cssVar('--vscode-terminal-ansiBrightYellow',  '#f5f543');
  const ansiBrightBlue    = cssVar('--vscode-terminal-ansiBrightBlue',    '#3b8eea');
  const ansiBrightMagenta = cssVar('--vscode-terminal-ansiBrightMagenta', '#d670d6');
  const ansiBrightCyan    = cssVar('--vscode-terminal-ansiBrightCyan',    '#29b8db');
  const ansiBrightWhite   = cssVar('--vscode-terminal-ansiBrightWhite',   '#e5e5e5');

  // ── 2. Initialise xterm.js ────────────────────────────────────────────────

  const term = new Terminal({
    theme: {
      background:    termBackground,
      foreground:    termForeground,
      cursor:        termCursor,
      cursorAccent:  termCursorAccent,
      selectionBackground: termSelection,
      black:         ansiBlack,
      red:           ansiRed,
      green:         ansiGreen,
      yellow:        ansiYellow,
      blue:          ansiBlue,
      magenta:       ansiMagenta,
      cyan:          ansiCyan,
      white:         ansiWhite,
      brightBlack:   ansiBrightBlack,
      brightRed:     ansiBrightRed,
      brightGreen:   ansiBrightGreen,
      brightYellow:  ansiBrightYellow,
      brightBlue:    ansiBrightBlue,
      brightMagenta: ansiBrightMagenta,
      brightCyan:    ansiBrightCyan,
      brightWhite:   ansiBrightWhite,
    },
    fontFamily: editorFont,
    fontSize: 13,
    scrollback: 5000,
    convertEol: true,  // convert \r\n → \n so output displays cleanly
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  // ── 3. VS Code ↔ webview message bridge ──────────────────────────────────

  const vscode = acquireVsCodeApi();

  // TextDecoder for UTF-8 — used to correctly decode PTY output that was
  // base64-encoded on the server side. atob() only produces Latin-1 strings
  // so multi-byte UTF-8 characters (emoji, box-drawing chars) would corrupt
  // without this step.
  const utf8Decoder = new TextDecoder('utf-8');

  // Extension host → webview
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'data':
        // msg.payload is already a decoded string (decoded in terminalWebSocket.ts
        // via atob). Re-encode to bytes then decode as UTF-8 to fix multi-byte chars.
        {
          const bytes = Uint8Array.from(msg.payload, c => c.charCodeAt(0));
          term.write(utf8Decoder.decode(bytes));
        }
        break;
      case 'connected':
        term.writeln('\r\n\x1b[32m● connected to code-puppy\x1b[0m\r\n');
        break;
      case 'disconnected':
        term.writeln('\r\n\x1b[33m○ disconnected: ' + msg.reason + '\x1b[0m');
        break;
      case 'error':
        term.writeln('\r\n\x1b[31m✗ ' + msg.message + '\x1b[0m');
        break;
    }
  });

  // Webview → extension host (keystrokes)
  term.onData((data) => {
    vscode.postMessage({ type: 'input', payload: data });
  });

  // Webview → extension host (resize)
  // Debounced: ResizeObserver fires many times per second while dragging.
  // We fit immediately (so xterm reflows visually) but only send the resize
  // message to the PTY after 100ms of quiet — prevents the REPL from
  // redrawing the prompt on every pixel change.
  let resizeTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
    }, 100);
  });
  resizeObserver.observe(document.getElementById('terminal'));
}());
