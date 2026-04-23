# pi-diff-review

This is pure slop, see: https://pi.dev/session/#d4ce533cedbd60040f2622dc3db950e2

It is my hope, that someone takes this idea and makes it gud.

Native diff review window for pi, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

```
pi install git:https://github.com/badlogic/pi-diff-review
```

## Keyboard shortcuts

These shortcuts work in the review window when you're not typing into an input/textarea.

| Shortcut | What it does |
| --- | --- |
| `j` | Jump to next change hunk |
| `k` | Jump to previous change hunk |
| `J` (`Shift+j`) | Open next file |
| `K` (`Shift+k`) | Open previous file |
| `c` | Add inline comment at the current line |
| `C` (`Shift+c`) | Add overall review note |
| `/` or `?` | Focus sidebar file search |
| `b` or `B` | Toggle sidebar |
| `r` or `R` | Toggle reviewed state for current file |

## What it does

Adds a `/diff-review` command to pi.

The command:

1. opens a native review window
2. lets you switch between `git diff`, `last commit`, and `all files` scopes
3. shows a collapsible sidebar with fuzzy file search
4. shows git status markers in the sidebar for changed files and untracked files
5. lazy-loads file contents on demand as you switch files and scopes
6. lets you draft comments on the original side, modified side, or whole file
7. inserts the resulting feedback prompt into the pi editor when you submit

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Tailwind and Monaco CDNs used by the review window

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
