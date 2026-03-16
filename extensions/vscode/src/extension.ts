import * as vscode from "vscode";
import { TerminalPanelProvider } from "./terminalPanel";

/**
 * Called by VS Code when the extension activates.
 * Activation is triggered by "onStartupFinished" (see package.json).
 *
 * Responsibilities:
 *  1. Register the WebviewViewProvider that renders the sidebar panel.
 *  2. Register the command that focuses/reveals the panel.
 *  3. Push both registrations onto context.subscriptions so VS Code
 *     disposes them automatically when the extension deactivates.
 */
export function activate(context: vscode.ExtensionContext): void {
  // 1. Create the provider.  It holds the xterm.js terminal and the
  //    WebSocket connection to code-puppy's PTY endpoint.
  const provider = new TerminalPanelProvider(context);

  // 2. Register the provider for the view id declared in package.json
  //    under contributes.views["code-puppy"][0].id
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    TerminalPanelProvider.viewId,
    provider,
    {
      // Keep the webview alive even when the user switches away from the
      // Code Puppy sidebar.  Without this, the terminal would reset every
      // time the user hid the panel.
      webviewOptions: { retainContextWhenHidden: true },
    }
  );

  // 3. Register the command declared in package.json under
  //    contributes.commands[0].command
  const commandRegistration = vscode.commands.registerCommand(
    "codePuppy.openTerminal",
    () => {
      // executeCommand("workbench.view.extension.<container-id>") focuses
      // the activity-bar container.  The container id is the one we
      // declared in contributes.viewsContainers.activitybar[0].id.
      vscode.commands.executeCommand("workbench.view.extension.code-puppy");
    }
  );

  context.subscriptions.push(viewRegistration, commandRegistration);
}

/**
 * Called by VS Code when the extension deactivates (e.g. window closes,
 * extension disabled).  Cleanup of long-lived resources (WebSocket,
 * timeouts) goes here.  For now the provider handles its own disposal
 * via the WebviewView.onDidDispose callback.
 */
export function deactivate(): void {
  // Nothing extra required in Phase 1.
  // The WebSocket inside TerminalPanelProvider is closed in its own
  // dispose handler, which VS Code calls via context.subscriptions.
}
