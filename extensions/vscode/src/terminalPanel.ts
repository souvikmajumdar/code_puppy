import * as fs from "fs";
import * as vscode from "vscode";
import { TerminalWebSocket, ToWebviewMessage, FromWebviewMessage } from "./terminalWebSocket";

/**
 * Implements WebviewViewProvider for the Code Puppy sidebar panel.
 *
 * Responsibilities:
 *  1. Load media/terminal.html and substitute placeholder tokens with
 *     webview URIs and a per-load CSP nonce.
 *  2. Create and own a TerminalWebSocket instance.
 *  3. Bridge messages in both directions:
 *       webview → extension host → PTY  (keystrokes, resize)
 *       PTY → extension host → webview  (terminal output)
 *  4. Clean up on dispose.
 *
 * VS Code calls resolveWebviewView() once when the panel first becomes
 * visible. After that the webview stays alive (retainContextWhenHidden)
 * and we do not get called again unless the panel is moved to a new
 * window or the extension reloads.
 */
export class TerminalPanelProvider implements vscode.WebviewViewProvider {
  /** Must match contributes.views["code-puppy"][0].id in package.json */
  static readonly viewId = "codePuppy.terminalView";

  private wsClient: TerminalWebSocket | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    // ── 1. Configure the webview ────────────────────────────────────────
    webviewView.webview.options = {
      enableScripts: true,
      // localResourceRoots restricts which local directories the webview
      // can load files from.  We allow node_modules (xterm.js assets) and
      // media (our CSS/JS/HTML).
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "node_modules"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    // ── 2. Wire up the WebSocket client ─────────────────────────────────
    this.wsClient = new TerminalWebSocket((msg: ToWebviewMessage) => {
      webviewView.webview.postMessage(msg);
    });

    // ── 3. Handle messages from the webview ─────────────────────────────
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      // onDidReceiveMessage gives us `unknown` — we cast after checking
      // the shape. The webview is our own code so this is safe, but
      // being explicit keeps TypeScript happy without `any`.
      const msg = raw as FromWebviewMessage;
      switch (msg.type) {
        case "input":
          this.wsClient?.sendInput(msg.payload);
          break;
        case "resize":
          this.wsClient?.sendResize(msg.cols, msg.rows);
          break;
      }
    });

    // ── 4. Render HTML and open the connection ───────────────────────────
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    // connect() is called after html is set so the webview is ready to
    // receive the "connected" / "error" messages immediately.
    void this.wsClient.connect();

    // ── 5. Dispose when the panel is destroyed ───────────────────────────
    webviewView.onDidDispose(() => {
      this.wsClient?.dispose();
      this.wsClient = null;
    });
  }

  // ── HTML builder ────────────────────────────────────────────────────────

  /**
   * Loads media/terminal.html and replaces placeholder tokens with
   * webview URIs and a per-load CSP nonce.
   *
   * Token substitution keeps the HTML, CSS, and JavaScript in real files
   * that editors can understand (syntax highlighting, linting, etc.) rather
   * than buried in a TypeScript template literal.
   */
  private buildHtml(webview: vscode.Webview): string {
    const mediaUri = (filename: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", filename)
      );

    const xtermUri = (...parts: string[]) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "node_modules", ...parts)
      );

    const nonce = getNonce();

    // Read the HTML template from disk (runs in Node.js extension host,
    // not the webview sandbox, so fs.readFileSync is available).
    const templatePath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "terminal.html"
    ).fsPath;
    console.log(`Code Puppy: loading template from ${templatePath}`);
    let html: string;
    try {
      html = fs.readFileSync(templatePath, "utf8");
    } catch (err) {
      const msg = `Code Puppy: failed to read media/terminal.html at ${templatePath}: ${err}`;
      console.error(msg);
      vscode.window.showErrorMessage(msg);
      return `<html><body><pre>${msg}</pre></body></html>`;
    }

    // Substitute all placeholder tokens.
    const replacements: Record<string, string> = {
      "{{CSP_SOURCE}}":   webview.cspSource,
      "{{NONCE}}":        nonce,
      "{{XTERM_JS}}":     xtermUri("@xterm", "xterm", "lib", "xterm.js").toString(),
      "{{XTERM_CSS}}":    xtermUri("@xterm", "xterm", "css", "xterm.css").toString(),
      "{{XTERM_FIT_JS}}": xtermUri("@xterm", "addon-fit", "lib", "addon-fit.js").toString(),
      "{{TERMINAL_CSS}}": mediaUri("terminal.css").toString(),
      "{{TERMINAL_JS}}":  mediaUri("terminal.js").toString(),
    };

    for (const [token, value] of Object.entries(replacements)) {
      // Replace all occurrences (nonce appears twice: in CSP and on script tags).
      html = html.split(token).join(value);
    }

    return html;
  }
}

/** Generates a cryptographically random nonce string for the CSP. */
function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
