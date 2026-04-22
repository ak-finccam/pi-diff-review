function hasDataCommentId(node) {
  if (!node || typeof node !== "object") return false;
  if (typeof node.hasAttribute === "function") {
    return node.hasAttribute("data-comment-id");
  }
  if (typeof node.getAttribute === "function") {
    return node.getAttribute("data-comment-id") != null;
  }
  return node.dataCommentId === true;
}

function isTypingTargetGuard(target) {
  let node = target;
  while (node && typeof node === "object") {
    const tagName = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
    const isContentEditable = node.isContentEditable === true;
    const isTypingElement = tagName === "INPUT" || tagName === "TEXTAREA" || isContentEditable;
    if (isTypingElement) {
      const insideMonaco = typeof node.closest === "function" && Boolean(node.closest(".monaco-editor"));
      if (insideMonaco) {
        if (tagName === "TEXTAREA" && hasDataCommentId(node)) {
          return true;
        }
        return false;
      }
      return true;
    }
    node = node.parentNode;
  }
  return false;
}

if (typeof globalThis === "object") {
  globalThis.__reviewShortcutGuards = {
    isTypingTarget: isTypingTargetGuard,
  };
}
