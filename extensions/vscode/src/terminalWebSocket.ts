import * as vscode from "vscode";
import { discoverPort, PortDiscoveryResult } from "./portDiscovery";

/** Messages the extension sends to the webview. */
export type ToWebviewMessage =
  | { type: "data"; payload: string }       // terminal output to render
  | { type: "connected" }                   // WebSocket open
  | { type: "disconnected"; reason: string }// WebSocket closed
  | { type: "error"; message: string };     // connection error

/** Messages the webview sends to the extension. */
export type FromWebviewMessage =
  | { type: "input"; payload: string }      // keystrokes from xterm.js
  | { type: "resize"; cols: number; rows: number }; // terminal resize event

/**
 * Manages the WebSocket connection between the VS Code extension host
 * and code-puppy's PTY endpoint (`/ws/terminal`).
 *
 * Architecture
 * ───────────────────────────────────────────────────────────────────
 *  [xterm.js in webview]
 *        │  postMessage (FromWebviewMessage)
 *        ▼
 *  [TerminalWebSocket]  ←→  ws://127.0.0.1:{port}/ws/terminal
 *        │  postMessage (ToWebviewMessage)
 *        ▼
 *  [xterm.js in webview]
 * ───────────────────────────────────────────────────────────────────
 *
 * The extension host (Node.js) owns the WebSocket; the webview (browser
 * sandbox) cannot open WebSockets to arbitrary hosts without relaxing
 * the Content Security Policy.  Routing through the extension host
 * keeps the webview CSP strict.
 *
 * Lifecycle:
 *  1. Call connect() once the webview is ready.
 *  2. Call sendInput() for each keystroke received from the webview.
 *  3. Call sendResize() when the terminal dimensions change.
 *  4. Call dispose() when the webview panel is closed.
 */
export class TerminalWebSocket {
  private ws: WebSocket | null = null;
  private disposed = false;

  /**
   * @param postMessage  Callback to send a message to the webview.
   *                     Provided by TerminalPanelProvider from
   *                     WebviewView.webview.postMessage().
   */
  constructor(
    private readonly postMessage: (msg: ToWebviewMessage) => void
  ) {}

  /**
   * Discovers the port, opens the WebSocket, and wires up event handlers.
   * Safe to call multiple times — if already connected, this is a no-op.
   * Async because port discovery does a TCP probe to verify the server is up.
   */
  async connect(): Promise<void> {
    if (this.ws || this.disposed) {
      return;
    }

    const result: PortDiscoveryResult = await discoverPort();
    if (!result.ok) {
      this.postMessage({ type: "error", message: result.detail });
      // Surface in the VS Code notification area as well.
      vscode.window.showWarningMessage(`Code Puppy: ${result.detail}`);
      return;
    }

    // Log which source was used so devs can see whether the port file
    // matched or the fallback was needed (visible in the Extension Host log).
    if (result.source === "fallback") {
      console.warn(
        `Code Puppy: port file was absent or stale; connected via fallback port ${result.port}. ` +
        `This is expected until upstream bug G1/G11 is fixed.`
      );
    }

    // /ws/puppy spawns `pup -i` as the PTY process so the sidebar gets
    // the code-puppy REPL rather than a plain shell.
    // /ws/terminal (raw shell) remains available for debugging.
    const url = `ws://127.0.0.1:${result.port}/ws/puppy`;

    // VS Code's extension host runs in Node.js 20+, which has a native
    // global WebSocket (added in Node 22 behind a flag; stable in 22.4).
    // For Node < 22 we fall back to the 'ws' package.
    // For now we use the built-in global since we target Node 24.
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log(`Code Puppy: WebSocket opened → ${url}`);
      this.postMessage({ type: "connected" });
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        console.warn(`Code Puppy: unexpected binary frame`);
        return;
      }
      let msg: { type: string; id?: string; data?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        this.postMessage({ type: "data", payload: event.data });
        return;
      }

      console.log(`Code Puppy: ws message type="${msg.type}" dataLen=${msg.data?.length ?? 0}`);

      if (msg.type === "output" && typeof msg.data === "string") {
        const decoded = atob(msg.data);
        this.postMessage({ type: "data", payload: decoded });
      }
    };

    this.ws.onerror = (event) => {
      console.error(`Code Puppy: WebSocket onerror`, event);
      this.postMessage({ type: "error", message: "WebSocket error — see disconnect reason." });
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      const reason = event.reason || `code ${event.code}`;
      console.warn(`Code Puppy: WebSocket closed code=${event.code} reason="${event.reason}" wasClean=${event.wasClean}`);
      this.postMessage({ type: "disconnected", reason });
    };
  }

  /**
   * Sends keystroke data to the PTY.
   * Called by TerminalPanelProvider when it receives an "input" message
   * from the webview.
   *
   * The server expects JSON: { "type": "input", "data": "<string>" }
   * (see websocket.py line 118 — msg.get("type") == "input")
   */
  sendInput(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "input", data }));
    }
  }

  /**
   * Sends a terminal resize event to the PTY so it reflows output
   * correctly.  code-puppy's PTY endpoint expects a JSON message with
   * the shape: { "type": "resize", "cols": N, "rows": N }
   */
  sendResize(cols: number, rows: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  /**
   * Closes the WebSocket and prevents any further reconnection.
   * Called from TerminalPanelProvider.dispose().
   */
  dispose(): void {
    this.disposed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
