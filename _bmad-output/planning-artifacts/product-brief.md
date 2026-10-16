---
title: 'Switchboard — Product Brief'
status: 'draft'
created: '2026-10-16'
author: 'Emils + Claude (Fable 5.1)'
workingTitle: 'Switchboard'
---

# Switchboard — Product Brief

*Working title. "Switchboard" because the core act is an operator plugging sessions into each other and into repos. Rename freely.*

## The problem

Emils does nearly all development through Claude Code, and occasionally reviews what it produced. The tool in use for that is VS Code, which means:

- One VS Code window per repo, each one carrying an editor, extension host, language servers, source control UI and a terminal — most of it idle, all of it in RAM.
- No overview. Which repo has a session running? Which session is waiting on a permission prompt? Which branch is which worktree? That lives in the operator's head and in a stack of terminal tabs.
- Sessions are flat. There is no way to *see* that session A is working on `guild-auth` while session B is doing the matching frontend change in `ui`, or to tell them so.
- The agent cannot see the workspace either. Claude Code knows its own cwd and whatever `--add-dir` it was given; it has no model of "the other things going on around me".

## The product

A desktop app for Windows and Linux whose main surface is a **graph of projects, sessions and branches**, and whose job is to **start, watch, connect and review Claude Code sessions** — not to be a text editor.

- A **node per project** (a folder, usually a git repo). Expand it to see its **sessions** (historic and live) and its **local branches / worktrees**.
- **Start a session** on any node: new, resumed, forked, in a fresh worktree, with model/effort/permission mode chosen up front. The session runs as the real `claude` TUI in an embedded terminal — nothing is lost or re-implemented.
- **Connect nodes with edges.** A session → folder edge means "you may also work in there" (`--add-dir`). A session ↔ session edge means "you two are cooperating" — each learns the other exists and gets a channel to talk.
- **Review** by clicking a node: working-tree diff, branch-vs-base diff, file tree, open in external editor. Read-only in v1.
- **The app is a tool for Claude too.** Every session it launches gets an MCP server pointing back at the app, so Claude can read the graph, start sibling sessions, link nodes, post status and ask for review.

Visually: one canvas, a terminal/diff pane, almost no chrome. Keyboard-first. Dark by default.

## Who it is for

1. **Emils** — operator. Wants fewer windows, a picture of what is running, and faster "start a session over there with these dirs".
2. **Claude** — the agent in each session. Wants to know what else is going on, hand work to a sibling, and report "done, please look" without the human polling terminals.

No third audience. No marketplace, no collaboration-with-other-humans, no cloud account.

## Goals (v1)

| # | Goal | Measure |
|---|------|---------|
| G1 | Replace VS Code as the default place Claude Code sessions are started and watched | A normal day runs with zero VS Code windows open for Claude work |
| G2 | Whole-workspace overview at a glance | Every live session and its state (busy / idle / waiting on permission / exited) visible on the canvas without opening it |
| G3 | Cheap | Cold start under 1 s; idle RSS under 150 MB with 5 projects and 3 live sessions (terminals excluded from the budget only for their scrollback) |
| G4 | Nothing lost vs the terminal | Every Claude Code feature (slash commands, permission prompts, `/resume`, plugins, hooks) works unchanged inside a session node |
| G5 | Sessions can cooperate | Two linked sessions can exchange messages and one can start another, through the app, without the human relaying |
| G6 | Windows and Linux | Same binary set builds and runs on Windows 11 and a mainstream Linux (Ubuntu/Fedora, X11 and Wayland) |

## Non-goals (v1)

- Editing files in-app (read-only review only; "open in external editor" covers the rest).
- Language servers, linting, debugging, test runners.
- Re-implementing Claude Code's chat UI. The terminal *is* the chat UI in v1.
- Cloud sessions, Remote Control, multi-machine. (`claude --cloud` exists; a later epic, not v1.)
- macOS. Should be portable later since the stack is cross-platform, but nothing is tested there.
- Any agent other than Claude Code.

## Success looks like

Open the app. Five project nodes. Two of them glow: `guild-auth` has a busy session, `ui` has one waiting on a permission prompt. Click `ui`, answer the prompt in the terminal pane. Drag an edge from the `ui` session to the `guild-auth` session: both now know about each other. Type into `ui`'s terminal: "coordinate the API shape with your peer". Later, a toast: "`guild-auth`/`auth-refresh` asks for review". Click it — a diff. Nod, open the branch in the external editor for one nit, done. VS Code never opened.

## Constraints and givens

- Claude Code CLI **2.1.x** is installed and is the only agent runtime. Its `agents --json`, `--resume`, `--fork-session`, `--worktree`, `--add-dir`, `--name`, `--mcp-config` and `-p --output-format stream-json` are the integration surface (see `docs/research/claude-code-integration.md`).
- Rust 1.94, Node 25, Cargo and npm are present. Tauri 2 (Rust core + web UI) is the chosen shell.
- Planning follows BMAD v6 conventions (`_bmad-output/planning-artifacts`, `implementation-artifacts`); BMAD itself is installed when implementation starts.

## Open questions

Tracked in `prd.md` → *Open questions*. The big one: how far to push structured cooperation between sessions in v1 (native `SendMessage` between local sessions vs an app-mediated inbox) — the PRD proposes both, native first.
