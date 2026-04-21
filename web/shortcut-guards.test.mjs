import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "shortcut-guards.js"), "utf8");
const context = vm.createContext({ globalThis: {} });
vm.runInContext(source, context);
const { isTypingTarget } = context.globalThis.__reviewShortcutGuards;

function makeNode({ tagName, isContentEditable = false, parentNode = null, insideMonaco = false } = {}) {
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

test("returns true for regular textarea targets", () => {
  const textarea = makeNode({ tagName: "textarea" });
  assert.equal(isTypingTarget(textarea), true);
});

test("returns false for Monaco textarea targets", () => {
  const textarea = makeNode({ tagName: "textarea", insideMonaco: true });
  assert.equal(isTypingTarget(textarea), false);
});

test("returns true when typing parent exists outside Monaco", () => {
  const input = makeNode({ tagName: "input" });
  const child = makeNode({ parentNode: input });
  assert.equal(isTypingTarget(child), true);
});

test("returns false for non-typing targets", () => {
  const div = makeNode({ tagName: "div" });
  assert.equal(isTypingTarget(div), false);
});
