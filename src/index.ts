import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { getReviewWindowData, loadReviewFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

type WaitingEditorResult = "escape" | "window-settled";

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function shouldDebugShortcuts(): boolean {
  const value = process.env.PI_DIFF_REVIEW_DEBUG_KEYS;
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function openReviewWindow(html: string): { window: GlimpseWindow; cleanup: () => void } {
  // WebView2 NavigateToString on Windows can throw ArgumentException for larger
  // HTML payloads. The practical limit is brittle, so we always load from a
  // temp file on Windows instead of relying on a size heuristic.
  const shouldUseTempFile = process.platform === "win32";

  if (!shouldUseTempFile) {
    return {
      window: open(html, {
        width: 1680,
        height: 1020,
        title: "pi review",
      }),
      cleanup: () => {},
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
  const tempFilePath = join(tempDir, "index.html");
  writeFileSync(tempFilePath, html, "utf8");

  const window = open("", {
    width: 1680,
    height: 1020,
    title: "pi review",
  });

  let cleaned = false;
  const handleReady = (): void => {
    if (cleaned) return;
    window.loadFile(tempFilePath);
  };

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    window.removeListener("ready", handleReady);
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  window.once("closed", cleanup);
  window.once("error", cleanup);

  // Load after the host reports ready. Sending `file` too early on Windows can
  // race host initialization and leave the default blank page in place.
  window.once("ready", handleReady);

  return { window, cleanup };
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewRepository(ctx: ExtensionCommandContext): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    const { repoRoot, files, branchBaseRef, branchBaseRevision } = await getReviewWindowData(pi, ctx.cwd);
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const debugShortcuts = shouldDebugShortcuts();
    const html = buildReviewHtml({ repoRoot, files, branchBaseRef, debugShortcuts });
    const { window, cleanup: cleanupWindowTempFiles } = openReviewWindow(html);
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"]): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, repoRoot, file, scope, branchBaseRevision);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    ctx.ui.notify("Opened native review window.", "info");

    try {
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
          const file = fileMap.get(message.fileId);
          if (file == null) {
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: "Unknown file requested.",
            });
            return;
          }

          try {
            const contents = await loadContents(file, message.scope);
            sendWindowMessage({
              type: "file-data",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              originalContent: contents.originalContent,
              modifiedContent: contents.modifiedContent,
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              message: messageText,
            });
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;

          if (isRequestFilePayload(message)) {
            void handleRequestFile(message);
            return;
          }
          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      if (prompt.length === 0) {
        ctx.ui.notify("No feedback submitted; editor left unchanged.", "info");
        return;
      }

      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    } finally {
      cleanupWindowTempFiles();
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native review window with git diff, branch diff, last commit, and all files scopes",
    handler: async (_args, ctx) => {
      await reviewRepository(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
