import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(testDir, "shortcut-guards.js"), "utf8");
const context = vm.createContext({ globalThis: {} });
vm.runInContext(source, context);
const { isTypingTarget } = context.globalThis.__reviewShortcutGuards;

function createMockNode({ tagName, isContentEditable = false, parentNode = null, insideMonaco = false } = {}) {
  return {
    tagName,
    isContentEditable,
    parentNode,
    closest(selector) {
      if (selector === ".monaco-editor" && insideMonaco) return {};
      return null;
    },
  };
}

test("returns true for regular textarea targets outside Monaco", () => {
  const textarea = createMockNode({ tagName: "textarea" });
  assert.equal(isTypingTarget(textarea), true);
});

test("returns false for Monaco textarea targets", () => {
  const textarea = createMockNode({ tagName: "textarea", insideMonaco: true });
  assert.equal(isTypingTarget(textarea), false);
});

test("treats tagName matching as case-insensitive", () => {
  const textarea = createMockNode({ tagName: "TeXtArEa" });
  assert.equal(isTypingTarget(textarea), true);
});

test("returns true when typing parent exists outside Monaco", () => {
  const input = createMockNode({ tagName: "input" });
  const child = createMockNode({ parentNode: input });
  assert.equal(isTypingTarget(child), true);
});

test("returns false for non-typing targets", () => {
  const div = createMockNode({ tagName: "div" });
  assert.equal(isTypingTarget(div), false);
});

test("returns true for contentEditable targets outside Monaco", () => {
  const editable = createMockNode({ tagName: "div", isContentEditable: true });
  assert.equal(isTypingTarget(editable), true);
});

test("returns false for contentEditable targets inside Monaco", () => {
  const editable = createMockNode({ tagName: "div", isContentEditable: true, insideMonaco: true });
  assert.equal(isTypingTarget(editable), false);
});
