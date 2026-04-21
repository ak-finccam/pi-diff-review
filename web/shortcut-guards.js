function isTypingTarget(target) {
  let node = target;
  while (node && typeof node === "object") {
    const tagName = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
    const isContentEditable = node.isContentEditable === true;
    const isTypingElement = tagName === "INPUT" || tagName === "TEXTAREA" || isContentEditable;
    if (isTypingElement) {
      const insideMonaco = typeof node.closest === "function" && Boolean(node.closest(".monaco-editor"));
      if (insideMonaco) return false;
      return true;
    }
    node = node.parentNode;
  }
  return false;
}

if (typeof globalThis === "object") {
  globalThis.__reviewShortcutGuards = {
    isTypingTarget,
  };
}
