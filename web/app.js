const reviewData = JSON.parse(document.getElementById("diff-review-data").textContent || "{}");

const state = {
  activeFileId: null,
  currentScope: reviewData.files.some((file) => file.inGitDiff)
    ? "git-diff"
    : reviewData.files.some((file) => file.inBranchDiff)
      ? "branch-diff"
      : reviewData.files.some((file) => file.inLastCommit)
        ? "last-commit"
        : "all-files",
  comments: [],
  overallComment: "",
  hideUnchanged: false,
  wrapLines: true,
  collapsedDirs: {},
  reviewedFiles: {},
  scrollPositions: {},
  sidebarCollapsed: false,
  fileFilter: "",
  fileContents: {},
  fileErrors: {},
  pendingRequestIds: {},
  hunkNavigationIndex: {},
};

const shortcutDefinitions = [
  {
    actionId: "nextChange",
    description: "Jump to next change hunk",
    helpLabel: "j",
    bindings: [{ key: "j", code: "KeyJ", shift: false }],
  },
  {
    actionId: "previousChange",
    description: "Jump to previous change hunk",
    helpLabel: "k",
    bindings: [{ key: "k", code: "KeyK", shift: false }],
  },
  {
    actionId: "nextFile",
    description: "Open next file",
    helpLabel: "J (Shift+j)",
    bindings: [{ key: "J", code: "KeyJ", shift: true }],
  },
  {
    actionId: "previousFile",
    description: "Open previous file",
    helpLabel: "K (Shift+k)",
    bindings: [{ key: "K", code: "KeyK", shift: true }],
  },
  {
    actionId: "addLineComment",
    description: "Add inline comment at current line",
    helpLabel: "c",
    bindings: [{ key: "c", code: "KeyC", shift: false }],
  },
  {
    actionId: "addOverallComment",
    description: "Add overall review note",
    helpLabel: "C (Shift+c)",
    bindings: [{ key: "C", code: "KeyC", shift: true }],
  },
  {
    actionId: "focusSidebarSearch",
    description: "Focus sidebar file search",
    helpLabel: "/ or ?",
    bindings: [
      { key: "/", code: "Slash", shift: false },
      { key: "?", code: "Slash", shift: true },
    ],
  },
  {
    actionId: "toggleSidebar",
    description: "Toggle sidebar",
    helpLabel: "b or B",
    bindings: [
      { key: "b", code: "KeyB", shift: false },
      { key: "B", code: "KeyB", shift: true },
    ],
  },
  {
    actionId: "toggleReviewed",
    description: "Toggle reviewed state for current file",
    helpLabel: "r or R",
    bindings: [
      { key: "r", code: "KeyR", shift: false },
      { key: "R", code: "KeyR", shift: true },
    ],
  },
];

const monacoKeyCodeByEventCode = {
  KeyJ: "KeyJ",
  KeyK: "KeyK",
  KeyC: "KeyC",
  Slash: "Slash",
  KeyB: "KeyB",
  KeyR: "KeyR",
};

const shortcutActionByKey = new Map();
const shortcutActionByCode = new Map();
const trackedShortcutCodes = new Set();
const monacoShortcutBindings = [];

shortcutDefinitions.forEach((definition) => {
  definition.bindings.forEach((binding) => {
    shortcutActionByKey.set(binding.key, definition.actionId);
    trackedShortcutCodes.add(binding.code);

    const codeBinding = shortcutActionByCode.get(binding.code) ?? { plain: null, shifted: null };
    if (binding.shift) {
      codeBinding.shifted = definition.actionId;
    } else {
      codeBinding.plain = definition.actionId;
    }
    shortcutActionByCode.set(binding.code, codeBinding);

    const monacoKeyCode = monacoKeyCodeByEventCode[binding.code];
    if (monacoKeyCode) {
      monacoShortcutBindings.push({
        actionId: definition.actionId,
        keyCode: monacoKeyCode,
        shift: binding.shift === true,
      });
    }
  });
});

const shortcutDebugEnabled = reviewData.debugShortcuts === true;

const rootLayoutEl = document.getElementById("root-layout");
const sidebarEl = document.getElementById("sidebar");
const sidebarTitleEl = document.getElementById("sidebar-title");
const sidebarSearchInputEl = document.getElementById("sidebar-search-input");
const toggleSidebarButton = document.getElementById("toggle-sidebar-button");
const scopeDiffButton = document.getElementById("scope-diff-button");
const scopeBranchButton = document.getElementById("scope-branch-button");
const scopeLastCommitButton = document.getElementById("scope-last-commit-button");
const scopeAllButton = document.getElementById("scope-all-button");
const windowTitleEl = document.getElementById("window-title");
const repoRootEl = document.getElementById("repo-root");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const modeHintEl = document.getElementById("mode-hint");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const fileCommentButton = document.getElementById("file-comment-button");
const shortcutsHelpButton = document.getElementById("shortcuts-help-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");

repoRootEl.textContent = reviewData.repoRoot || "";
windowTitleEl.textContent = "Review";

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;
let requestSequence = 0;
let shortcutDebugPanelEl = null;
let shortcutDebugLines = [];
let shortcutsHelpBackdropEl = null;
let shortcutsHelpLastFocusedEl = null;
const handledKeydownEvents = new WeakSet();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function isMonacoTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(".monaco-editor"));
}

function ensureShortcutDebugPanel() {
  if (!shortcutDebugEnabled) return null;
  if (shortcutDebugPanelEl != null) return shortcutDebugPanelEl;

  const panel = document.createElement("div");
  panel.id = "shortcut-debug-panel";
  panel.style.position = "fixed";
  panel.style.right = "12px";
  panel.style.bottom = "12px";
  panel.style.zIndex = "300";
  panel.style.maxWidth = "720px";
  panel.style.maxHeight = "240px";
  panel.style.overflow = "auto";
  panel.style.pointerEvents = "none";
  panel.style.border = "1px solid #30363d";
  panel.style.borderRadius = "8px";
  panel.style.background = "rgba(1, 4, 9, 0.92)";
  panel.style.padding = "8px 10px";
  panel.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  panel.style.fontSize = "11px";
  panel.style.lineHeight = "1.35";
  panel.style.color = "#8b949e";
  panel.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.45)";

  document.body.appendChild(panel);
  shortcutDebugPanelEl = panel;
  return panel;
}

function pushShortcutDebugLine(line) {
  if (!shortcutDebugEnabled) return;

  const panel = ensureShortcutDebugPanel();
  if (!panel) return;

  shortcutDebugLines.push(`${new Date().toLocaleTimeString()} ${line}`);
  if (shortcutDebugLines.length > 8) {
    shortcutDebugLines = shortcutDebugLines.slice(-8);
  }

  panel.innerHTML = shortcutDebugLines.map((item) => escapeHtml(item)).join("<br>");
  panel.scrollTop = panel.scrollHeight;
}

function focusShortcutHost() {
  if (isShortcutsHelpModalOpen()) return;
  if (!rootLayoutEl) return;
  if (typeof rootLayoutEl.focus !== "function") return;
  if (document.activeElement === rootLayoutEl) return;
  rootLayoutEl.focus({ preventScroll: true });
}

function inferLanguage(path) {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  return "plaintext";
}

function scopeLabel(scope) {
  switch (scope) {
    case "git-diff": return "Git diff";
    case "branch-diff": return "Branch diff";
    case "last-commit": return "Last commit";
    default: return "All files";
  }
}

function scopeHint(scope) {
  switch (scope) {
    case "git-diff":
      return "Review working tree changes against HEAD. Hover or click line numbers in the gutter to add an inline comment.";
    case "branch-diff": {
      const baseRef = typeof reviewData.branchBaseRef === "string" && reviewData.branchBaseRef.length > 0
        ? reviewData.branchBaseRef
        : "the inferred base branch";
      return `Review all branch changes against merge-base with ${baseRef}. Hover or click line numbers in the gutter to add an inline comment.`;
    }
    case "last-commit":
      return "Review the last commit against its parent. Hover or click line numbers in the gutter to add an inline comment.";
    default:
      return "Review the current working tree snapshot. Hover or click line numbers in the gutter to add a code review comment.";
  }
}

function statusLabel(status) {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "deleted": return "text-[#f85149]";
    case "renamed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function isFileReviewed(fileId) {
  return state.reviewedFiles[fileId] === true;
}

function getScopedFiles() {
  switch (state.currentScope) {
    case "git-diff":
      return reviewData.files.filter((file) => file.inGitDiff);
    case "branch-diff":
      return reviewData.files.filter((file) => file.inBranchDiff);
    case "last-commit":
      return reviewData.files.filter((file) => file.inLastCommit);
    default:
      return reviewData.files.filter((file) => file.hasWorkingTreeFile);
  }
}

function ensureActiveFileForScope() {
  const scopedFiles = getScopedFiles();
  if (scopedFiles.length === 0) {
    state.activeFileId = null;
    return;
  }
  if (scopedFiles.some((file) => file.id === state.activeFileId)) {
    return;
  }
  state.activeFileId = scopedFiles[0].id;
}

function activeFile() {
  return reviewData.files.find((file) => file.id === state.activeFileId) ?? null;
}

function getScopeComparison(file, scope = state.currentScope) {
  if (!file) return null;
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "branch-diff") return file.branchDiff;
  if (scope === "last-commit") return file.lastCommit;
  return null;
}

function activeComparison() {
  return getScopeComparison(activeFile(), state.currentScope);
}

function activeFileShowsDiff() {
  return activeComparison() != null;
}

function getScopeFilePath(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.newPath || comparison?.oldPath || file?.path || "";
}

function getScopeDisplayPath(file, scope = state.currentScope) {
  const comparison = getScopeComparison(file, scope);
  return comparison?.displayPath || file?.path || "";
}

function getFileSearchPath(file) {
  return file?.path || "";
}

function getBaseName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function getActiveStatus(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.status ?? file?.worktreeStatus ?? null;
}

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, "");
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = i;
    score += 10;

    if (i === previousMatchIndex + 1) {
      score += 8;
    }

    const previousChar = i > 0 ? candidate[i - 1] : "";
    if (i === 0 || previousChar === "/" || previousChar === "_" || previousChar === "-" || previousChar === ".") {
      score += 12;
    }

    previousMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return -1;
  if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
  return score;
}

function getFileSearchScore(query, file) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;

  const path = getFileSearchPath(file).toLowerCase();
  const baseName = getBaseName(path);
  const pathScore = scoreSubsequence(normalizedQuery, path);
  const baseScore = scoreSubsequence(normalizedQuery, baseName);
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);

  if (score < 0) return -1;
  if (baseName === normalizedQuery) score += 200;
  else if (baseName.startsWith(normalizedQuery)) score += 120;
  else if (path.includes(normalizedQuery)) score += 35;

  return score;
}

function getFilteredFiles() {
  const scopedFiles = getScopedFiles();
  const query = state.fileFilter.trim();
  if (!query) return [...scopedFiles];

  return scopedFiles
    .map((file) => ({ file, score: getFileSearchScore(query, file) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return getFileSearchPath(a.file).localeCompare(getFileSearchPath(b.file));
    })
    .map((entry) => entry.file);
}

function buildTree(files) {
  const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
  for (const file of files) {
    const path = getFileSearchPath(file);
    const parts = path.split("/");
    let node = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: new Map(),
          file: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
      if (isLeaf) node.file = file;
    }
  }
  return root;
}

function cacheKey(scope, fileId) {
  return `${scope}:${fileId}`;
}

function scrollKey(scope, fileId) {
  return `${scope}:${fileId}`;
}

function saveCurrentScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)] = {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreFileScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const scrollState = state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)];
  if (!scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function captureScrollState() {
  if (!diffEditor) return null;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  return {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreScrollState(scrollState) {
  if (!diffEditor || !scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function getRequestState(fileId, scope = state.currentScope) {
  const key = cacheKey(scope, fileId);
  return {
    contents: state.fileContents[key],
    error: state.fileErrors[key],
    requestId: state.pendingRequestIds[key],
  };
}

function ensureFileLoaded(fileId, scope = state.currentScope) {
  if (!fileId) return;
  const key = cacheKey(scope, fileId);
  if (state.fileContents[key] != null) return;
  if (state.fileErrors[key] != null) return;
  if (state.pendingRequestIds[key] != null) return;

  const requestId = `request:${Date.now()}:${++requestSequence}`;
  state.pendingRequestIds[key] = requestId;
  renderTree();
  if (window.glimpse?.send) {
    window.glimpse.send({ type: "request-file", requestId, fileId, scope });
  }
}

function openFile(fileId, options = {}) {
  const shouldFocusEditor = options.focusEditor !== false;

  if (state.activeFileId === fileId) {
    ensureFileLoaded(fileId, state.currentScope);
    if (shouldFocusEditor) {
      requestMonacoFocusAfterFileSwitch("open-file:same");
    }
    return;
  }

  saveCurrentScrollPosition();
  state.activeFileId = fileId;
  renderAll({ restoreFileScroll: true, focusEditor: shouldFocusEditor });
  ensureFileLoaded(fileId, state.currentScope);

  if (shouldFocusEditor) {
    requestMonacoFocusAfterFileSwitch("open-file");
  }
}

function collectVisibleTreeFiles(node, output) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const child of children) {
    if (child.kind === "dir") {
      const collapsed = state.collapsedDirs[child.path] === true;
      if (!collapsed) {
        collectVisibleTreeFiles(child, output);
      }
      continue;
    }

    if (child.file != null) {
      output.push(child.file);
    }
  }
}

function getVisibleFilesInTreeOrder() {
  const visibleFiles = getFilteredFiles();

  if (state.fileFilter.trim()) {
    return visibleFiles;
  }

  const output = [];
  collectVisibleTreeFiles(buildTree(visibleFiles), output);
  return output;
}

function openRelativeFile(direction) {
  const visibleFiles = getVisibleFilesInTreeOrder();
  if (visibleFiles.length === 0) return;
  const currentIndex = visibleFiles.findIndex((file) => file.id === state.activeFileId);
  const targetIndex = currentIndex < 0
    ? (direction > 0 ? 0 : visibleFiles.length - 1)
    : (currentIndex + direction + visibleFiles.length) % visibleFiles.length;
  openFile(visibleFiles[targetIndex].id);
}

function renderTreeNode(node, depth) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indentPx = 12;

  for (const child of children) {
    if (child.kind === "dir") {
      const collapsed = state.collapsedDirs[child.path] === true;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] text-[#c9d1d9] hover:bg-[#21262d]";
      row.style.paddingLeft = `${depth * indentPx + 8}px`;
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-[#8b949e] transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="truncate">${escapeHtml(child.name)}</span>
      `;
      row.addEventListener("click", () => {
        state.collapsedDirs[child.path] = !collapsed;
        renderTree();
      });
      fileTreeEl.appendChild(row);
      if (!collapsed) renderTreeNode(child, depth + 1);
      continue;
    }

    const file = child.file;
    const count = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[13px]",
      file.id === state.activeFileId ? "bg-[#373e47] text-white" : reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
    ].join(" ");
    button.style.paddingLeft = `${(depth * indentPx) + 26}px`;
    button.innerHTML = `
      <span class="flex min-w-0 items-center gap-1.5 truncate ${file.id === state.activeFileId ? "font-medium" : ""}">
        <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : errored ? "text-red-400" : loading ? "text-[#58a6ff]" : "text-transparent"}">${reviewed ? "●" : errored ? "!" : loading ? "…" : "●"}</span>
        <span class="truncate">${escapeHtml(child.name)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        ${status ? `<span class="font-medium ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status).charAt(0))}</span>` : ""}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  }
}

function renderSearchResults(files) {
  files.forEach((file) => {
    const path = getFileSearchPath(file);
    const baseName = getBaseName(path);
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const count = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left",
      file.id === state.activeFileId ? "bg-[#373e47] text-white" : "text-[#c9d1d9] hover:bg-[#21262d]",
    ].join(" ");
    button.innerHTML = `
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : errored ? "text-red-400" : loading ? "text-[#58a6ff]" : "text-transparent"}">${reviewed ? "●" : errored ? "!" : loading ? "…" : "●"}</span>
          <span class="truncate text-[13px] ${file.id === state.activeFileId ? "font-medium" : ""}">${escapeHtml(baseName)}</span>
        </span>
        <span class="mt-0.5 block truncate pl-[14px] text-[11px] ${file.id === state.activeFileId ? "text-[#c9d1d9]" : "text-review-muted"}">${escapeHtml(parentPath || path)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        ${status ? `<span class="font-medium ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status).charAt(0))}</span>` : ""}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  });
}

function updateSidebarLayout() {
  const collapsed = state.sidebarCollapsed;
  sidebarEl.style.width = collapsed ? "0px" : "280px";
  sidebarEl.style.minWidth = collapsed ? "0px" : "280px";
  sidebarEl.style.flexBasis = collapsed ? "0px" : "280px";
  sidebarEl.style.borderRightWidth = collapsed ? "0px" : "1px";
  sidebarEl.style.pointerEvents = collapsed ? "none" : "auto";
  toggleSidebarButton.textContent = collapsed ? "Show sidebar" : "Hide sidebar";
}

function updateScopeButtons() {
  const counts = {
    diff: reviewData.files.filter((file) => file.inGitDiff).length,
    branch: reviewData.files.filter((file) => file.inBranchDiff).length,
    lastCommit: reviewData.files.filter((file) => file.inLastCommit).length,
    all: reviewData.files.filter((file) => file.hasWorkingTreeFile).length,
  };

  const applyButtonClasses = (button, active, disabled) => {
    button.disabled = disabled;
    button.className = disabled
      ? "cursor-default rounded-md border border-review-border bg-[#11161d] px-2.5 py-1 text-[11px] font-medium text-review-muted opacity-60"
      : active
        ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-[11px] font-medium text-[#3fb950] hover:bg-[#238636]/25"
        : "cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-[11px] font-medium text-review-text hover:bg-[#21262d]";
  };

  scopeDiffButton.textContent = `Git diff${counts.diff > 0 ? ` (${counts.diff})` : ""}`;
  scopeBranchButton.textContent = `Branch diff${counts.branch > 0 ? ` (${counts.branch})` : ""}`;
  scopeLastCommitButton.textContent = `Last commit${counts.lastCommit > 0 ? ` (${counts.lastCommit})` : ""}`;
  scopeAllButton.textContent = `All files${counts.all > 0 ? ` (${counts.all})` : ""}`;

  applyButtonClasses(scopeDiffButton, state.currentScope === "git-diff", counts.diff === 0);
  applyButtonClasses(scopeBranchButton, state.currentScope === "branch-diff", counts.branch === 0);
  applyButtonClasses(scopeLastCommitButton, state.currentScope === "last-commit", counts.lastCommit === 0);
  applyButtonClasses(scopeAllButton, state.currentScope === "all-files", counts.all === 0);
}

function updateToggleButtons() {
  const file = activeFile();
  const reviewed = file ? isFileReviewed(file.id) : false;
  toggleReviewedButton.textContent = reviewed ? "Reviewed" : "Mark reviewed";
  toggleReviewedButton.className = reviewed
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]";
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  toggleUnchangedButton.textContent = state.hideUnchanged ? "Show full file" : "Show changed areas only";
  toggleUnchangedButton.style.display = activeFileShowsDiff() ? "inline-flex" : "none";
  updateScopeButtons();
  modeHintEl.textContent = scopeHint(state.currentScope);
  submitButton.disabled = false;
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    renderSideBySide: activeFileShowsDiff(),
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: activeFileShowsDiff() && state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function renderTree() {
  ensureActiveFileForScope();
  fileTreeEl.innerHTML = "";
  const scopedFiles = getScopedFiles();
  const visibleFiles = getFilteredFiles();

  if (visibleFiles.length === 0) {
    const message = state.fileFilter.trim()
      ? `No files match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>.`
      : `No files in <span class="text-review-text">${escapeHtml(scopeLabel(state.currentScope).toLowerCase())}</span>.`;
    fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        ${message}
      </div>
    `;
  } else if (state.fileFilter.trim()) {
    renderSearchResults(visibleFiles);
  } else {
    renderTreeNode(buildTree(visibleFiles), 0);
  }

  sidebarTitleEl.textContent = scopeLabel(state.currentScope);
  const comments = state.comments.length;
  const filteredSuffix = state.fileFilter.trim() ? ` • ${visibleFiles.length} shown` : "";
  summaryEl.textContent = `${scopedFiles.length} file(s) • ${comments} comment(s)${state.overallComment ? " • overall note" : ""}${filteredSuffix}`;
  updateToggleButtons();
  updateSidebarLayout();
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function isShortcutsHelpModalOpen() {
  return shortcutsHelpBackdropEl != null;
}

function renderShortcutsHelpRows() {
  return shortcutDefinitions
    .map((definition, index) => {
      const borderClass = index < shortcutDefinitions.length - 1 ? " border-b border-review-border" : "";
      return `
            <tr>
              <td class="${borderClass} px-3 py-2 font-mono">${escapeHtml(definition.helpLabel)}</td>
              <td class="${borderClass} px-3 py-2">${escapeHtml(definition.description)}</td>
            </tr>
      `;
    })
    .join("");
}

function closeShortcutsHelpModal(options = {}) {
  const backdrop = shortcutsHelpBackdropEl;
  if (!backdrop) return;

  shortcutsHelpBackdropEl = null;
  backdrop.remove();

  const lastFocusedEl = shortcutsHelpLastFocusedEl;
  shortcutsHelpLastFocusedEl = null;

  const restoreFocus = options.restoreFocus !== false;
  if (!restoreFocus) return;

  if (lastFocusedEl && typeof lastFocusedEl.focus === "function") {
    try {
      lastFocusedEl.focus({ preventScroll: true });
      return;
    } catch {}
  }

  focusShortcutHost();
}

function showShortcutsHelpModal() {
  if (isShortcutsHelpModalOpen()) return;

  shortcutsHelpLastFocusedEl = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Keyboard shortcuts");
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">Keyboard shortcuts</div>
      <div class="mb-4 text-sm text-review-muted">Shortcuts are active while focus is in the review view (not in text inputs).</div>
      <div class="overflow-hidden rounded-md border border-review-border">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-[#0d1117] text-review-muted">
            <tr>
              <th class="border-b border-review-border px-3 py-2 text-left font-semibold">Shortcut</th>
              <th class="border-b border-review-border px-3 py-2 text-left font-semibold">Action</th>
            </tr>
          </thead>
          <tbody class="bg-review-panel text-review-text">${renderShortcutsHelpRows()}</tbody>
        </table>
      </div>
      <div class="mt-4 flex items-center justify-between gap-2">
        <div class="text-xs text-review-muted">Press <span class="rounded border border-review-border px-1 py-0.5 text-review-text">Esc</span> to close.</div>
        <button id="shortcuts-help-close" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Close</button>
      </div>
    </div>
  `;

  const close = () => closeShortcutsHelpModal();
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });

  document.body.appendChild(backdrop);
  shortcutsHelpBackdropEl = backdrop;

  const closeButton = backdrop.querySelector("#shortcuts-help-close");
  if (closeButton) {
    closeButton.addEventListener("click", close);
    closeButton.focus();
  }
}

function showOverallCommentModal() {
  showTextModal({
    title: "Overall review note",
    description: "This note is prepended to the generated prompt above the inline comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      renderTree();
    },
  });
}

function showFileCommentModal() {
  const file = activeFile();
  if (!file) return;
  showTextModal({
    title: `File comment for ${getScopeDisplayPath(file, state.currentScope)}`,
    description: `This comment applies to the whole file in ${scopeLabel(state.currentScope).toLowerCase()}.`,
    initialValue: "",
    saveLabel: "Add comment",
    onSave: (value) => {
      if (!value) return;
      state.comments.push({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        fileId: file.id,
        scope: state.currentScope,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
      submitButton.disabled = false;
      updateCommentsUI();
    },
  });
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  updateSidebarLayout();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!state.sidebarCollapsed);
}

function toggleReviewedForActiveFile() {
  const file = activeFile();
  if (!file) return;
  state.reviewedFiles[file.id] = !isFileReviewed(file.id);
  renderTree();
}

function layoutEditor() {
  if (!diffEditor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  diffEditor.layout({ width, height });
}

function focusMonacoAfterFileSwitch() {
  if (!diffEditor) return false;

  const modifiedEditor = diffEditor.getModifiedEditor?.();
  const originalEditor = diffEditor.getOriginalEditor?.();

  try {
    if (modifiedEditor && typeof modifiedEditor.focus === "function") {
      modifiedEditor.focus();
      return true;
    }
  } catch {}

  try {
    if (originalEditor && typeof originalEditor.focus === "function") {
      originalEditor.focus();
      return true;
    }
  } catch {}

  return false;
}

function requestMonacoFocusAfterFileSwitch(_reason = "file-switch") {
  const focusAttempt = () => {
    focusMonacoAfterFileSwitch();
  };

  focusAttempt();
  requestAnimationFrame(() => focusAttempt());
  setTimeout(() => focusAttempt(), 40);
}

function clearViewZones() {
  if (!diffEditor || activeViewZones.length === 0) return;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  activeViewZones = [];
}

function renderCommentDOM(comment, onDelete) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  const title = comment.side === "file"
    ? `File comment • ${scopeLabel(comment.scope)}`
    : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.startLine} • ${scopeLabel(comment.scope)}`;

  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (textarea.value.trim().length > 0) return;
    event.preventDefault();
    event.stopPropagation();
    onDelete();
    queueMicrotask(() => {
      requestMonacoFocusAfterFileSwitch("delete-empty-comment");
    });
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (!comment.body) setTimeout(() => textarea.focus(), 50);
  return container;
}

function canCommentOnSide(file, side) {
  if (!file) return false;
  const comparison = activeComparison();
  if (side === "original") {
    return comparison != null && comparison.hasOriginal;
  }
  return comparison != null ? comparison.hasModified : file.hasWorkingTreeFile;
}

function isActiveFileReady() {
  const file = activeFile();
  if (!file) return false;
  const requestState = getRequestState(file.id, state.currentScope);
  return requestState.contents != null && requestState.error == null;
}

function syncViewZones() {
  clearViewZones();
  if (!diffEditor || !isActiveFileReady()) return;
  const file = activeFile();
  if (!file) return;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && comment.side !== "file");

  inlineComments.forEach((item) => {
    const editor = item.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(item, () => {
      state.comments = state.comments.filter((comment) => comment.id !== item.id);
      updateCommentsUI();
    });

    editor.changeViewZones((accessor) => {
      const lineCount = typeof item.body === "string" && item.body.length > 0 ? item.body.split("\n").length : 1;
      const id = accessor.addZone({
        afterLineNumber: item.startLine,
        heightInPx: Math.max(150, lineCount * 22 + 86),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });
}

function updateDecorations() {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  const comments = file ? state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && comment.side !== "file") : [];
  const originalRanges = [];
  const modifiedRanges = [];

  for (const comment of comments) {
    const range = {
      range: new monacoApi.Range(comment.startLine, 1, comment.startLine, 1),
      options: {
        isWholeLine: true,
        className: comment.side === "original" ? "review-comment-line-original" : "review-comment-line-modified",
        glyphMarginClassName: comment.side === "original" ? "review-comment-glyph-original" : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, originalRanges);
  modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modifiedRanges);
}

function renderFileComments() {
  fileCommentsContainer.innerHTML = "";
  const file = activeFile();
  if (!file) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  const fileComments = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && comment.side === "file");

  if (fileComments.length === 0) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileCommentsContainer.className = "border-b border-review-border bg-[#0d1117] px-4 py-4 space-y-4";
  fileComments.forEach((comment) => {
    const dom = renderCommentDOM(comment, () => {
      state.comments = state.comments.filter((item) => item.id !== comment.id);
      updateCommentsUI();
    });
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  });
}

function getPlaceholderContents(file, scope) {
  const path = getScopeDisplayPath(file, scope);
  const requestState = getRequestState(file.id, scope);
  if (requestState.error) {
    const body = `Failed to load ${path}\n\n${requestState.error}`;
    return { originalContent: body, modifiedContent: body };
  }
  const body = `Loading ${path}...`;
  return { originalContent: body, modifiedContent: body };
}

function getMountedContents(file, scope = state.currentScope) {
  return getRequestState(file.id, scope).contents || getPlaceholderContents(file, scope);
}

function mountFile(options = {}) {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  if (!file) {
    currentFileLabelEl.textContent = "No file selected";
    clearViewZones();
    if (originalModel) originalModel.dispose();
    if (modifiedModel) modifiedModel.dispose();
    originalModel = monacoApi.editor.createModel("", "plaintext");
    modifiedModel = monacoApi.editor.createModel("", "plaintext");
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    applyEditorOptions();
    updateDecorations();
    renderFileComments();
    requestAnimationFrame(layoutEditor);
    return;
  }

  ensureFileLoaded(file.id, state.currentScope);

  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll ? captureScrollState() : null;
  const language = inferLanguage(getScopeFilePath(file) || file.path);
  const contents = getMountedContents(file, state.currentScope);

  clearViewZones();
  currentFileLabelEl.textContent = getScopeDisplayPath(file, state.currentScope);

  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();

  originalModel = monacoApi.editor.createModel(contents.originalContent, language);
  modifiedModel = monacoApi.editor.createModel(contents.modifiedContent, language);

  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  applyEditorOptions();
  syncViewZones();
  updateDecorations();
  renderFileComments();
  requestAnimationFrame(() => {
    layoutEditor();
    if (options.restoreFileScroll) restoreFileScrollPosition();
    if (options.preserveScroll) restoreScrollState(scrollState);
    if (options.focusEditor) requestMonacoFocusAfterFileSwitch("mount-file");
    setTimeout(() => {
      layoutEditor();
      if (options.restoreFileScroll) restoreFileScrollPosition();
      if (options.preserveScroll) restoreScrollState(scrollState);
      if (options.focusEditor) requestMonacoFocusAfterFileSwitch("mount-file:delayed");
    }, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) comment.body = textarea.value;
  });
}

function updateCommentsUI() {
  renderTree();
  syncViewZones();
  updateDecorations();
  renderFileComments();
}

function renderAll(options = {}) {
  renderTree();
  submitButton.disabled = false;
  if (diffEditor && monacoApi) {
    mountFile(options);
    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
    });
  } else {
    renderFileComments();
  }
}

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    addInlineCommentDraft(side, line);
    editor.revealLineInCenter(line);
  }

  editor.onMouseMove((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
      return;
    }

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [{
        range: new monacoApi.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" },
      }]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

function addInlineCommentDraft(side, line) {
  const file = activeFile();
  if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;
  state.comments.push({
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    fileId: file.id,
    scope: state.currentScope,
    side,
    startLine: line,
    endLine: line,
    body: "",
  });
  updateCommentsUI();
}

function getSelectedCommentTarget() {
  if (!diffEditor) return null;
  const file = activeFile();
  if (!file || !isActiveFileReady()) return null;
  const candidates = [
    { editor: diffEditor.getOriginalEditor(), side: "original" },
    { editor: diffEditor.getModifiedEditor(), side: "modified" },
  ];
  const activeCandidate = candidates.find((candidate) => candidate.editor.hasTextFocus() || candidate.editor.hasWidgetFocus());
  if (!activeCandidate || !canCommentOnSide(file, activeCandidate.side)) return null;
  const selection = activeCandidate.editor.getSelection();
  const line = selection?.startLineNumber ?? activeCandidate.editor.getPosition()?.lineNumber;
  if (!line) return null;
  return { ...activeCandidate, line };
}

function getHunkAnchors() {
  if (!diffEditor || !activeFileShowsDiff()) return [];
  const lineChanges = diffEditor.getLineChanges() || [];
  return lineChanges
    .map((change) => {
      if (change.modifiedStartLineNumber > 0 && change.modifiedEndLineNumber > 0) {
        return { side: "modified", line: change.modifiedStartLineNumber };
      }
      if (change.originalStartLineNumber > 0 && change.originalEndLineNumber > 0) {
        return { side: "original", line: change.originalStartLineNumber };
      }
      return null;
    })
    .filter((anchor) => anchor != null);
}

function moveCursorToChangeAnchor(editor, line) {
  if (!editor) return;

  const model = typeof editor.getModel === "function" ? editor.getModel() : null;
  const lineCount = model && typeof model.getLineCount === "function" ? model.getLineCount() : 0;
  const safeLine = lineCount > 0 ? Math.max(1, Math.min(line, lineCount)) : Math.max(1, line);

  try {
    editor.setPosition({ lineNumber: safeLine, column: 1 });
  } catch {}

  if (monacoApi?.Range) {
    try {
      editor.setSelection(new monacoApi.Range(safeLine, 1, safeLine, 1));
    } catch {}
  }

  editor.revealLineInCenter(safeLine);

  try {
    editor.focus();
  } catch {}
}

function navigateChange(direction) {
  const file = activeFile();
  if (!file || !diffEditor) return;
  const anchors = getHunkAnchors();
  if (anchors.length === 0) return;
  const key = cacheKey(state.currentScope, file.id);
  let index = state.hunkNavigationIndex[key];
  if (!Number.isInteger(index) || index < 0 || index >= anchors.length) {
    index = direction > 0 ? -1 : anchors.length;
  }
  index = (index + direction + anchors.length) % anchors.length;
  state.hunkNavigationIndex[key] = index;
  const anchor = anchors[index];
  const editor = anchor.side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  moveCursorToChangeAnchor(editor, anchor.line);
}

function focusSidebarSearch() {
  if (state.sidebarCollapsed) {
    setSidebarCollapsed(false);
  }
  sidebarSearchInputEl.focus();
  sidebarSearchInputEl.select();
}

function addCommentFromSelection() {
  const selectedTarget = getSelectedCommentTarget();
  if (!selectedTarget) return;
  addInlineCommentDraft(selectedTarget.side, selectedTarget.line);
  selectedTarget.editor.revealLineInCenter(selectedTarget.line);
}

const shortcutActions = {
  nextChange: () => navigateChange(1),
  previousChange: () => navigateChange(-1),
  nextFile: () => openRelativeFile(1),
  previousFile: () => openRelativeFile(-1),
  focusSidebarSearch,
  toggleSidebar: toggleSidebarCollapsed,
  toggleReviewed: toggleReviewedForActiveFile,
  addLineComment: addCommentFromSelection,
  addOverallComment: showOverallCommentModal,
};

function isTypingTarget(target) {
  const guardFn = globalThis.__reviewShortcutGuards?.isTypingTarget;
  if (typeof guardFn === "function" && guardFn !== isTypingTarget) {
    try {
      return guardFn(target);
    } catch {
      // Fall back to local detection.
    }
  }
  let node = target instanceof Node ? target : null;
  while (node) {
    if (node instanceof HTMLElement) {
      const tag = node.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable) return true;
    }
    node = node.parentNode;
  }
  return false;
}

function resolveShortcutAction(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const codeBinding = shortcutActionByCode.get(event.code);
  if (codeBinding) {
    return event.shiftKey ? codeBinding.shifted : codeBinding.plain;
  }

  return shortcutActionByKey.get(event.key) ?? null;
}

function describeShortcutTarget(target) {
  if (!(target instanceof Element)) return null;
  const tagName = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : "";
  const className = typeof target.className === "string" ? target.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  const classSuffix = className ? `.${className}` : "";
  return `${tagName}${id}${classSuffix}`;
}

function shouldTraceShortcutEvent(event) {
  if (trackedShortcutCodes.has(event.code)) return true;
  if (shortcutActionByKey.has(event.key)) return true;
  return false;
}

function isTypingShortcutContext(event) {
  if (isTypingTarget(event.target)) return true;
  return isTypingTarget(document.activeElement);
}

function sendShortcutDebug(event, actionId, reason) {
  if (!shortcutDebugEnabled) return;
  if (!shouldTraceShortcutEvent(event)) return;

  const line = [
    `[shortcut] key=${event.key}`,
    `code=${event.code}`,
    `action=${actionId ?? "-"}`,
    `reason=${reason ?? "-"}`,
    `target=${describeShortcutTarget(event.target) ?? "-"}`,
    `active=${describeShortcutTarget(document.activeElement) ?? "-"}`,
  ].join(" ");
  pushShortcutDebugLine(line);
}

function onGlobalKeydown(event) {
  if (handledKeydownEvents.has(event)) return;
  handledKeydownEvents.add(event);

  const actionId = resolveShortcutAction(event);

  if (isShortcutsHelpModalOpen()) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeShortcutsHelpModal();
      sendShortcutDebug(event, actionId, "shortcuts-help-close");
      return;
    }

    sendShortcutDebug(event, actionId, "shortcuts-help-open");
    return;
  }

  if (!actionId) {
    sendShortcutDebug(event, null, "no-action");
    return;
  }

  if (isTypingShortcutContext(event)) {
    sendShortcutDebug(event, actionId, "typing-target");
    return;
  }

  const action = shortcutActions[actionId];
  if (!action) {
    sendShortcutDebug(event, actionId, "missing-handler");
    return;
  }

  sendShortcutDebug(event, actionId, "invoke");
  event.preventDefault();
  event.stopPropagation();

  try {
    action();
  } catch (error) {
    sendShortcutDebug(event, actionId, "action-error");
    console.error(`[diff-review] shortcut action failed: ${actionId}`, error);
  }
}

window.__reviewReceive = function (message) {
  if (!message || typeof message !== "object") return;
  const key = cacheKey(message.scope, message.fileId);

  if (message.type === "file-data") {
    state.fileContents[key] = {
      originalContent: message.originalContent,
      modifiedContent: message.modifiedContent,
    };
    delete state.fileErrors[key];
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope) {
      mountFile({ restoreFileScroll: true, focusEditor: true });
    }
    return;
  }

  if (message.type === "file-error") {
    state.fileErrors[key] = message.message || "Unknown error";
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope) {
      mountFile({ preserveScroll: false, focusEditor: true });
    }
  }
};

function registerMonacoShortcutCommands() {
  if (!diffEditor || !monacoApi) return;

  const bindings = [
    { keybinding: monacoApi.KeyCode.KeyJ, actionId: "nextChange" },
    { keybinding: monacoApi.KeyMod.Shift | monacoApi.KeyCode.KeyJ, actionId: "nextFile" },
    { keybinding: monacoApi.KeyCode.KeyK, actionId: "previousChange" },
    { keybinding: monacoApi.KeyMod.Shift | monacoApi.KeyCode.KeyK, actionId: "previousFile" },
    { keybinding: monacoApi.KeyCode.KeyC, actionId: "addLineComment" },
    { keybinding: monacoApi.KeyMod.Shift | monacoApi.KeyCode.KeyC, actionId: "addOverallComment" },
    { keybinding: monacoApi.KeyCode.KeyB, actionId: "toggleSidebar" },
    { keybinding: monacoApi.KeyCode.KeyR, actionId: "toggleReviewed" },
    { keybinding: monacoApi.KeyCode.Slash, actionId: "focusSidebarSearch" },
  ];

  const editors = [diffEditor.getOriginalEditor(), diffEditor.getModifiedEditor()];
  editors.forEach((editor) => {
    bindings.forEach((binding) => {
      editor.addCommand(binding.keybinding, () => {
        if (isShortcutsHelpModalOpen()) {
          if (shortcutDebugEnabled) {
            pushShortcutDebugLine(`[monaco-command] blocked action=${binding.actionId} reason=shortcuts-help-open`);
          }
          return;
        }

        if (isTypingTarget(document.activeElement)) {
          if (shortcutDebugEnabled) {
            pushShortcutDebugLine(`[monaco-command] blocked action=${binding.actionId} reason=typing-target`);
          }
          return;
        }

        if (shortcutDebugEnabled) {
          pushShortcutDebugLine(`[monaco-command] action=${binding.actionId}`);
        }
        const action = shortcutActions[binding.actionId];
        if (!action) return;
        action();
      }, "editorTextFocus");
    });
  });
}

function setupMonaco() {
  window.require.config({
    paths: {
      vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    },
  });

  window.require(["vs/editor/editor.main"], function () {
    monacoApi = window.monaco;

    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
      },
    });
    monacoApi.editor.setTheme("review-dark");

    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: activeFileShowsDiff(),
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
    });

    createGlyphHoverActions(diffEditor.getOriginalEditor(), "original");
    createGlyphHoverActions(diffEditor.getModifiedEditor(), "modified");
    registerMonacoShortcutCommands();

    if (typeof ResizeObserver !== "undefined") {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    mountFile();
  });
}

function switchScope(scope) {
  const hasScopeFiles = {
    "git-diff": reviewData.files.some((file) => file.inGitDiff),
    "branch-diff": reviewData.files.some((file) => file.inBranchDiff),
    "last-commit": reviewData.files.some((file) => file.inLastCommit),
    "all-files": reviewData.files.some((file) => file.hasWorkingTreeFile),
  };
  if (!hasScopeFiles[scope] || state.currentScope === scope) return;
  saveCurrentScrollPosition();
  state.currentScope = scope;
  renderAll({ restoreFileScroll: true });
  const file = activeFile();
  if (file) ensureFileLoaded(file.id, state.currentScope);
}

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  const payload = {
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: state.comments
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
  };
  window.glimpse.send(payload);
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

overallCommentButton.addEventListener("click", () => {
  showOverallCommentModal();
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

shortcutsHelpButton.addEventListener("click", () => {
  showShortcutsHelpModal();
});

toggleUnchangedButton.addEventListener("click", () => {
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(layoutEditor);
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

toggleReviewedButton.addEventListener("click", () => {
  toggleReviewedForActiveFile();
});

scopeDiffButton.addEventListener("click", () => {
  switchScope("git-diff");
});

scopeBranchButton.addEventListener("click", () => {
  switchScope("branch-diff");
});

scopeLastCommitButton.addEventListener("click", () => {
  switchScope("last-commit");
});

scopeAllButton.addEventListener("click", () => {
  switchScope("all-files");
});

toggleSidebarButton.addEventListener("click", () => {
  toggleSidebarCollapsed();
});

sidebarSearchInputEl.addEventListener("input", () => {
  state.fileFilter = sidebarSearchInputEl.value;
  renderTree();
});

sidebarSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    sidebarSearchInputEl.value = "";
    state.fileFilter = "";
    renderTree();
  }
});

[
  window,
  document,
  document.body,
  rootLayoutEl,
].forEach((target) => {
  if (target && typeof target.addEventListener === "function") {
    target.addEventListener("keydown", onGlobalKeydown, true);
  }
});

if (rootLayoutEl) {
  rootLayoutEl.tabIndex = -1;
}

document.addEventListener("pointerdown", (event) => {
  const target = event.target;

  if (isShortcutsHelpModalOpen()) {
    return;
  }

  if (isTypingTarget(target) || isMonacoTarget(target)) {
    return;
  }

  queueMicrotask(() => {
    focusShortcutHost();
  });
}, true);

window.addEventListener("focus", () => {
  focusShortcutHost();
});

if (shortcutDebugEnabled) {
  ensureShortcutDebugPanel();
  pushShortcutDebugLine("[shortcut] debug enabled");
}

ensureActiveFileForScope();
renderTree();
renderFileComments();
updateSidebarLayout();
setupMonaco();
requestAnimationFrame(() => {
  focusShortcutHost();
});
