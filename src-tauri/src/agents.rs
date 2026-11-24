//! Agent cards (Story 12.2): coding agents other than Claude Code (`settings.agents`: Kimi Code,
//! Qwen Code, …) started from the launch sheet in a Switchboard terminal under a project, and
//! tracked by their process only: `running`, then `exited (<code>)`.
//!
//! Basic support on purpose. Switchboard runs `<command> <args…>` (separate arguments, never a
//! shell string) in the project folder, in a PTY of [`TermKind::Agent`] with the id
//! `agent:<node uuid>`, and passes no settings file, MCP config or system prompt. It never reads
//! the agent's history, wires hooks or runs `--version` on it. None of the id-keyed Claude state
//! applies (the live map, hooks tokens, the launcher, the inbox, approvals): a run lives in
//! [`AgentRuns`] only, in memory, and is gone after an app restart, its card position with it.
//!
//! An agent card is its own child kind (`graph::ChildKind::Agent`), so the edge, peer, inbox,
//! review, resume and fork paths -- which all look for session children -- refuse it unchanged.
//! What does know about agents: the project's `N live` (a running agent counts), its glow and the
//! card's attention colour (an exit nobody saw), and the exit toast (the `finished` rule).
//!
//! The pure parts -- the `${env:NAME}` resolution, the command lookup with its batch-file
//! refusal, the spawn spec, the exit's attention rule and the card nodes -- are unit-tested here;
//! the wiring (`start`, `restart`, `stop`, `remove`, `acknowledge`) is driven by a fixture test in
//! `lib.rs`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::claude::launch;
use crate::graph::{self, AgentMeta, ChildKind, ChildNode, Position, WorkspaceSnapshot};
use crate::ipc::{self, Missing};
use crate::pty::{self, SessionHooks, SpawnSpec, TermInfo, TermKind};
use crate::settings::detect::{self, Search};
use crate::settings::{AgentSetting, AppState};

/// Why Restart or Remove is refused while the agent runs.
pub const STILL_RUNNING: &str = "the agent is still running; stop it first";

/// Why Stop is refused once the agent has exited.
pub const NOT_RUNNING: &str = "the agent is not running";

/// Why an agent action names no run.
pub const UNKNOWN_AGENT_CARD: &str = "unknown agent card";

/// One run of an agent: what its card shows, plus the spawn it was started with (Restart
/// re-runs exactly that: the same agent, args and env, under the same node id).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRun {
    /// The card's node id (a v4 uuid); its terminal is `agent:<id>`.
    pub id: String,
    pub project_id: String,
    /// The `settings.agents` name.
    pub agent: String,
    /// The card's label and the terminal's title (`<agent>-<4 hex>` unless renamed on the sheet).
    pub name: String,
    /// Milliseconds since the epoch, of the latest start.
    pub started_at: i64,
    /// `None` while running; the exit code after.
    pub exited: Option<i32>,
    /// An exit nobody saw (the window unfocused, or the card not selected): the attention colour
    /// and the project's glow until the card is selected.
    pub attention: bool,
    /// Where the operator dropped the card (relative to its project); memory only.
    pub position: Option<Position>,
    pub spec: SpawnSpec,
}

#[derive(Debug, Default)]
struct Inner {
    /// Newest first.
    runs: Vec<AgentRun>,
    /// The agent card the operator has selected now (`agent_acknowledge`), if any.
    selected: Option<String>,
}

/// Every agent run of this app's life (in `AppState`). Memory only.
#[derive(Debug, Default)]
pub struct AgentRuns {
    inner: Mutex<Inner>,
}

impl AgentRuns {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A copy of run `id`.
    pub fn get(&self, id: &str) -> Option<AgentRun> {
        self.lock().runs.iter().find(|r| r.id == id).cloned()
    }

    /// Every run, newest first.
    pub fn list(&self) -> Vec<AgentRun> {
        self.lock().runs.clone()
    }

    /// Whether `id` names a run.
    pub fn contains(&self, id: &str) -> bool {
        self.lock().runs.iter().any(|r| r.id == id)
    }

    /// Add a run (newest first).
    fn insert(&self, run: AgentRun) {
        self.lock().runs.insert(0, run);
    }

    /// Drop run `id`; true when there was one.
    fn take(&self, id: &str) -> bool {
        let mut inner = self.lock();
        let before = inner.runs.len();
        inner.runs.retain(|r| r.id != id);
        if inner.selected.as_deref() == Some(id) {
            inner.selected = None;
        }
        inner.runs.len() != before
    }

    /// Drop every run of `project_id` (it left the canvas); their ids.
    pub fn forget_project(&self, project_id: &str) -> Vec<String> {
        let mut inner = self.lock();
        let gone: Vec<String> = inner.runs.iter().filter(|r| r.project_id == project_id).map(|r| r.id.clone()).collect();
        inner.runs.retain(|r| r.project_id != project_id);
        gone
    }

    /// Run `id` exited with `code`: recorded, with attention unless the operator saw it (the
    /// window `focused` and the card selected). Returns the run as it is now, or `None` for an
    /// unknown id (removed meanwhile) or a run already marked exited.
    pub fn exited(&self, id: &str, code: i32, focused: bool) -> Option<AgentRun> {
        let mut inner = self.lock();
        let seen = focused && inner.selected.as_deref() == Some(id);
        let run = inner.runs.iter_mut().find(|r| r.id == id && r.exited.is_none())?;
        run.exited = Some(code);
        run.attention = exit_attention(seen);
        Some(run.clone())
    }

    /// The operator selected agent card `id` (`None`: something else, or nothing): remembered for
    /// the exit's attention rule, and that card's attention is acknowledged. True when a card's
    /// attention was cleared.
    pub fn acknowledge(&self, id: Option<&str>) -> bool {
        let mut inner = self.lock();
        inner.selected = id.map(str::to_string);
        let Some(id) = id else {
            return false;
        };
        match inner.runs.iter_mut().find(|r| r.id == id && r.attention) {
            Some(run) => {
                run.attention = false;
                true
            }
            None => false,
        }
    }

    /// Store a dragged card's position. An unknown id is `unknown agent card`.
    pub fn set_position(&self, id: &str, position: Position) -> Result<(), String> {
        let mut inner = self.lock();
        let run = inner.runs.iter_mut().find(|r| r.id == id).ok_or_else(|| UNKNOWN_AGENT_CARD.to_string())?;
        run.position = Some(position);
        Ok(())
    }

    /// Story 12.3: store several dragged positions under one lock: every id must be known, or
    /// nothing is stored and the reply is `unknown agent card`.
    pub fn set_positions(&self, moves: &[(String, Position)]) -> Result<(), String> {
        let mut inner = self.lock();
        if moves.iter().any(|(id, _)| !inner.runs.iter().any(|r| &r.id == id)) {
            return Err(UNKNOWN_AGENT_CARD.to_string());
        }
        for (id, position) in moves {
            if let Some(run) = inner.runs.iter_mut().find(|r| &r.id == id) {
                run.position = Some(*position);
            }
        }
        Ok(())
    }

    /// Put every agent card of `project_id` back in its slot (`project.relayout`).
    pub fn clear_positions(&self, project_id: &str) {
        for run in self.lock().runs.iter_mut().filter(|r| r.project_id == project_id) {
            run.position = None;
        }
    }

    /// Mark run `id` running again from `started_at` (a Restart), keeping the rest.
    fn restarted(&self, id: &str, started_at: i64) {
        if let Some(run) = self.lock().runs.iter_mut().find(|r| r.id == id) {
            run.exited = None;
            run.attention = false;
            run.started_at = started_at;
        }
    }

    /// Put back what a failed Restart changed.
    fn restore(&self, previous: AgentRun) {
        if let Some(run) = self.lock().runs.iter_mut().find(|r| r.id == previous.id) {
            *run = previous;
        }
    }

    /// The cards of every run, newest first ([`child_node`]).
    pub fn children(&self) -> Vec<ChildNode> {
        self.lock().runs.iter().map(child_node).collect()
    }
}

/// An exit's attention: set unless the operator saw it happen.
pub fn exit_attention(seen: bool) -> bool {
    !seen
}

/// The card of `run`: an `agent` child of its project, labelled with its name.
pub fn child_node(run: &AgentRun) -> ChildNode {
    ChildNode {
        id: run.id.clone(),
        project_id: run.project_id.clone(),
        kind: ChildKind::Agent,
        label: run.name.clone(),
        detail: None,
        position: run.position,
        session: None,
        branch_id: None,
        forked_from: None,
        has_transcript: false,
        branch: None,
        cleared_count: 0,
        earlier: Vec::new(),
        current_id: None,
        agent: Some(AgentMeta {
            agent: run.agent.clone(),
            started_at: crate::claude::transcript::format_iso_ms(run.started_at),
            exited: run.exited,
            attention: run.attention,
        }),
    }
}

// ---------------------------------------------------------------------------------------
// The pure parts of a start
// ---------------------------------------------------------------------------------------

/// The variable an env value names when it is written exactly `${env:NAME}` (NAME a valid
/// env name); `None` for any other value, which is used as written.
pub fn env_reference(value: &str) -> Option<&str> {
    value
        .strip_prefix("${env:")
        .and_then(|rest| rest.strip_suffix('}'))
        .filter(|name| crate::settings::store::is_env_name(name))
}

/// The agent's env as the child gets it: each `${env:NAME}` value read through `lookup` (from
/// Switchboard's own environment at start), every other value as written. A reference to a
/// variable that is not set refuses the start: `agent <name>: $NAME is not set`.
pub fn resolve_env(agent: &str, env: &BTreeMap<String, String>, lookup: impl Fn(&str) -> Option<String>) -> Result<Vec<(String, String)>, String> {
    env.iter()
        .map(|(key, value)| match env_reference(value) {
            Some(name) => lookup(name)
                .map(|found| (key.clone(), found))
                .ok_or_else(|| format!("agent {agent}: ${name} is not set")),
            None => Ok((key.clone(), value.clone())),
        })
        .collect()
}

/// Where `command` runs from, found like `claude.path` and the shell are: a path (or `~/…`) taken
/// as given when it is a file, a bare name on PATH with `PATHEXT` ([`ipc::locate_program`]). Not
/// found: `could not start <command>: not found on PATH` (`…: it does not exist` for a path that
/// is not a file, an extensionless one included). On Windows (`windows`) a bare name takes the
/// first native `.exe` / `.com` on the search, so a `.cmd` shim earlier on PATH does not hide a
/// later `kimi.exe`; a `.cmd` / `.bat` it does resolve to (a shim alone, or a path naming one) is
/// refused: `agent <name>: <path> is a batch file; point command at the .exe`, so `cmd.exe`
/// never re-parses the arguments.
pub fn resolve_command(agent: &str, command: &str, search: &Search, windows: bool) -> Result<PathBuf, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(format!("agent {agent}: command is blank"));
    }
    let expanded = detect::expand_home(command);
    let bare = !Path::new(&expanded).is_absolute() && Path::new(&expanded).components().count() <= 1;
    if windows
        && bare
        && let Some(native) = search.locate_native(command, true)
    {
        return Ok(native.path);
    }
    let found = ipc::locate_program(command, search).map_err(|missing| match missing {
        Missing::File => format!("could not start {command}: it does not exist"),
        Missing::OnPath => format!("could not start {command}: not found on PATH"),
    })?;
    if windows {
        let target = launch::pathext_target(&found, &search.extensions);
        if detect::is_batch(&target) {
            return Err(format!("agent {agent}: {} is a batch file; point command at the .exe", target.display()));
        }
    }
    Ok(found)
}

/// What an agent run spawns: `program` with `args` (separate argv entries) in `cwd`. The
/// environment, in order: the inherited one minus `PARENT_SESSION_VARS`, then `TERM` and
/// `COLORTERM` (both from [`SpawnSpec::command`]), then the agent's `env`, then
/// `SWITCHBOARD_NODE=<node id>`, which comes last and so cannot be overridden.
pub fn spawn_spec(program: &Path, args: &[String], cwd: &str, env: Vec<(String, String)>, node_id: &str) -> SpawnSpec {
    let mut spec = SpawnSpec::new(program, args.to_vec(), cwd);
    spec.env = env;
    spec.env.push((launch::NODE_ENV.to_string(), node_id.to_string()));
    spec
}

/// The node id a start runs under: the id the sheet was given when it is a uuid, else a fresh
/// v4 one.
pub fn node_id_for(proposed: &str) -> String {
    uuid::Uuid::parse_str(proposed.trim())
        .map(|id| id.to_string())
        .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string())
}

/// The `settings.agents` entry named `name`.
pub fn find_setting<'a>(agents: &'a [AgentSetting], name: &str) -> Result<&'a AgentSetting, String> {
    agents.iter().find(|a| a.name == name).ok_or_else(|| format!("unknown agent {name}"))
}

// ---------------------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------------------

/// Rebuild the agent cards from the registry and emit the workspace snapshot.
pub fn sync<R: Runtime>(app: &AppHandle<R>) -> WorkspaceSnapshot {
    graph::set_agents(app, &app.state::<AppState>().agents)
}

/// The hooks of an agent terminal: nothing on the first output; the exit records the code.
fn hooks<R: Runtime>(app: &AppHandle<R>, id: &str) -> SessionHooks {
    let (app, id) = (app.clone(), id.to_string());
    SessionHooks {
        first_output: Box::new(|| {}),
        exit: Box::new(move |code| on_exit(&app, &id, code)),
    }
}

/// Run `id`'s process exited with `code`: the card reads `exited (<code>)`, with attention when
/// the exit went unseen; a toast follows the `finished` rule (window unfocused, the
/// `notifications.finished` toggle on).
pub fn on_exit<R: Runtime>(app: &AppHandle<R>, id: &str, code: i32) {
    let state = app.state::<AppState>();
    let focused = crate::notify::main_window_focused(app);
    let Some(run) = state.agents.exited(id, code, focused) else {
        return;
    };
    sync(app);
    let (label, cwd) = {
        let ws = state.read_workspace();
        let project = ws.workspace.projects.iter().find(|p| p.id == run.project_id);
        (project.map(|p| p.label.clone()), project.map(|p| p.path.clone()).unwrap_or_default())
    };
    let transition = crate::claude::live::Transition {
        session_id: run.id.clone(),
        state: crate::claude::live::SessionState::Finished,
        project_id: Some(run.project_id.clone()),
        cwd,
        name: Some(run.name.clone()),
        project_label: label,
        title: None,
    };
    crate::notify::on_transitions(app, &[transition]);
}

/// Start agent `agent` from the launch sheet (`session_launch` with `agent` set): under project
/// `project_id`, named `name`, as node `proposed` (the id the sheet was given). The command is
/// resolved and the `${env:}` values read now; any refusal is an `Err` the sheet shows, with
/// nothing spawned. The project remembers the choice. Replies with the node id and its terminal.
pub fn start<R: Runtime>(app: &AppHandle<R>, project_id: &str, agent: &str, name: &str, proposed: &str, size: (u16, u16)) -> Result<(String, TermInfo), String> {
    let state = app.state::<AppState>();
    let cwd = {
        let ws = state.read_workspace();
        ws.workspace
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.path.clone())
            .ok_or_else(|| "unknown project".to_string())?
    };
    let setting = find_setting(&state.read().settings.agents, agent)?.clone();
    let name = launch::validate_name(name)?;
    let id = node_id_for(proposed);
    let term_id = pty::agent_id(&id);
    if state.agents.contains(&id) || state.terms.get(&term_id).is_some() {
        return Err(launch::ID_IN_USE.to_string());
    }
    // PATH as a shell spawned now sees it.
    let program = resolve_command(&setting.name, &setting.command, &Search::from_env(Vec::new()), cfg!(windows))?;
    let env = resolve_env(&setting.name, &setting.env, |var| std::env::var(var).ok())?;
    let spec = spawn_spec(&program, &setting.args, &cwd, env, &id);
    // In the registry before the spawn, so an exit at once still finds the run.
    state.agents.insert(AgentRun {
        id: id.clone(),
        project_id: project_id.to_string(),
        agent: setting.name.clone(),
        name: name.clone(),
        started_at: crate::claude::live::now_ms(),
        exited: None,
        attention: false,
        position: None,
        spec: spec.clone(),
    });
    let opened = state
        .terms
        .open_kind(TermKind::Agent, &term_id, project_id, &name, &cwd, size, spec, ipc::event_sink(app), hooks(app, &id));
    let term = match opened {
        Ok(term) => term,
        Err(message) => {
            state.agents.take(&id);
            return Err(message);
        }
    };
    sync(app);
    if let Err(err) = graph::set_launch_agent(app, project_id, Some(setting.name.clone())) {
        eprintln!("agents: could not remember the choice: {err}");
    }
    Ok((id, term))
}

/// Stop (Story 12.2) a running agent: Ctrl+C, a second Ctrl+C 300 ms later, then a kill 5 s
/// later if it still runs; a second Stop kills at once. Replies with the terminal's info.
pub fn stop<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<TermInfo, String> {
    let state = app.state::<AppState>();
    let run = state.agents.get(id).ok_or_else(|| UNKNOWN_AGENT_CARD.to_string())?;
    if run.exited.is_some() {
        return Err(NOT_RUNNING.to_string());
    }
    state
        .terms
        .stop(&pty::agent_id(id), launch::stop_writes(launch::StopPlan::Interrupt), launch::STOP_KILL_AFTER)
        .map_err(|_| NOT_RUNNING.to_string())
}

/// Restart an exited agent: the same agent, args and env, in the same tab (the terminal
/// `agent:<id>` is replaced in its place) and under the same node id. Refused while it runs.
pub fn restart<R: Runtime>(app: &AppHandle<R>, id: &str, size: (u16, u16)) -> Result<TermInfo, String> {
    let state = app.state::<AppState>();
    let run = state.agents.get(id).ok_or_else(|| UNKNOWN_AGENT_CARD.to_string())?;
    let term_id = pty::agent_id(id);
    if run.exited.is_none() || state.terms.get(&term_id).is_some_and(|t| t.is_running()) {
        return Err(STILL_RUNNING.to_string());
    }
    let size = state.terms.get(&term_id).map(|t| t.size()).unwrap_or(size);
    let cwd = run.spec.cwd.display().to_string();
    state.agents.restarted(id, crate::claude::live::now_ms());
    let opened = state
        .terms
        .open_kind(TermKind::Agent, &term_id, &run.project_id, &run.name, &cwd, size, run.spec.clone(), ipc::event_sink(app), hooks(app, id));
    let term = match opened {
        Ok(term) => term,
        Err(message) => {
            state.agents.restore(run);
            return Err(message);
        }
    };
    sync(app);
    // A pop-out showing the earlier run returns to the pane; every window learns it runs again.
    crate::windows::return_to_pane(app, &term.id);
    let _ = app.emit(pty::INFO_EVENT, &term);
    Ok(term)
}

/// Remove an exited agent: its card and its terminal go (every window forgets the terminal).
/// Refused while it runs.
pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<WorkspaceSnapshot, String> {
    let state = app.state::<AppState>();
    let run = state.agents.get(id).ok_or_else(|| UNKNOWN_AGENT_CARD.to_string())?;
    let term_id = pty::agent_id(id);
    if run.exited.is_none() || state.terms.get(&term_id).is_some_and(|t| t.is_running()) {
        return Err(STILL_RUNNING.to_string());
    }
    let closed = state.terms.close(&term_id).is_ok();
    state.agents.take(id);
    if closed {
        crate::windows::return_to_pane(app, &term_id);
        let _ = app.emit(pty::CLOSED_EVENT, pty::ClosedPayload { id: term_id });
    }
    Ok(sync(app))
}

/// The operator selected agent card `id` (`None`: something else): its attention is acknowledged
/// (the card and the glow go back to normal) and an exit while it stays selected is seen.
/// Replies whether a card's attention was cleared.
pub fn acknowledge<R: Runtime>(app: &AppHandle<R>, id: Option<&str>) -> bool {
    let cleared = app.state::<AppState>().agents.acknowledge(id);
    if cleared {
        sync(app);
    }
    cleared
}

/// Project `project_id` left the canvas: its runs go (before its terminals are killed, so their
/// exits find nothing to mark).
pub fn forget_project<R: Runtime>(app: &AppHandle<R>, project_id: &str) {
    if !app.state::<AppState>().agents.forget_project(project_id).is_empty() {
        sync(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, project: &str) -> AgentRun {
        AgentRun {
            id: id.into(),
            project_id: project.into(),
            agent: "kimi".into(),
            name: format!("kimi-{}", &id[..id.len().min(4)]),
            started_at: 1_763_892_000_000,
            exited: None,
            attention: false,
            position: None,
            spec: SpawnSpec::new("kimi", Vec::new(), "/p"),
        }
    }

    #[test]
    fn env_references_are_exactly_the_dollar_env_form() {
        assert_eq!(env_reference("${env:KIMI_KEY}"), Some("KIMI_KEY"));
        assert_eq!(env_reference("${env:_a1}"), Some("_a1"));
        for literal in ["KIMI_KEY", "$KIMI_KEY", "${env:}", "${env:1X}", "x${env:A}", "${env:A}x", "${ENV:A}", "${env:A-B}"] {
            assert_eq!(env_reference(literal), None, "{literal}");
        }
    }

    #[test]
    fn resolve_env_reads_references_and_keeps_literals() {
        let env: BTreeMap<String, String> =
            [("KEY".to_string(), "${env:KIMI_KEY}".to_string()), ("MODE".to_string(), "fast".to_string())].into_iter().collect();
        let set = |name: &str| (name == "KIMI_KEY").then(|| "sk-1".to_string());
        assert_eq!(
            resolve_env("kimi", &env, set),
            Ok(vec![("KEY".to_string(), "sk-1".to_string()), ("MODE".to_string(), "fast".to_string())])
        );
        assert_eq!(resolve_env("kimi", &env, |_| None), Err("agent kimi: $KIMI_KEY is not set".to_string()));
        assert_eq!(resolve_env("kimi", &BTreeMap::new(), |_| None), Ok(Vec::new()));
    }

    fn search_in(dir: &Path) -> Search {
        Search {
            path_dirs: vec![dir.to_path_buf()],
            extra_dirs: Vec::new(),
            extensions: if cfg!(windows) { vec![".com".into(), ".exe".into(), ".bat".into(), ".cmd".into()] } else { Vec::new() },
        }
    }

    fn make_exec(path: &Path) {
        std::fs::write(path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn resolve_command_finds_a_bare_name_on_path_and_a_path_as_given() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join(detect::with_platform_ext("kimi"));
        make_exec(&exe);
        let search = search_in(dir.path());
        assert_eq!(resolve_command("kimi", "kimi", &search, cfg!(windows)), Ok(exe.clone()));
        assert_eq!(resolve_command("kimi", &exe.display().to_string(), &search, cfg!(windows)), Ok(exe.clone()));
        assert_eq!(
            resolve_command("nope", "nope", &search, cfg!(windows)),
            Err("could not start nope: not found on PATH".to_string())
        );
        let gone = dir.path().join("gone").join("kimi.exe");
        assert_eq!(
            resolve_command("kimi", &gone.display().to_string(), &search, cfg!(windows)),
            Err(format!("could not start {}: it does not exist", gone.display()))
        );
        assert_eq!(resolve_command("kimi", "  ", &search, cfg!(windows)), Err("agent kimi: command is blank".to_string()));
    }

    #[test]
    fn resolve_command_refuses_a_batch_file_on_windows_only() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = dir.path().join("kimi.cmd");
        make_exec(&cmd);
        let mut search = search_in(dir.path());
        search.extensions = vec![".exe".into(), ".cmd".into()];
        // A bare name that resolves to the shim, and the shim's path.
        for command in ["kimi".to_string(), cmd.display().to_string()] {
            assert_eq!(
                resolve_command("kimi", &command, &search, true),
                Err(format!("agent kimi: {} is a batch file; point command at the .exe", cmd.display())),
                "{command}"
            );
        }
        // An extensionless path is taken as given: not a file.
        let bare = dir.path().join("kimi");
        assert_eq!(
            resolve_command("kimi", &bare.display().to_string(), &search, true),
            Err(format!("could not start {}: it does not exist", bare.display()))
        );
        // Elsewhere a `.cmd` is just a file.
        assert_eq!(resolve_command("kimi", &cmd.display().to_string(), &search, false), Ok(cmd.clone()));
    }

    #[test]
    fn on_windows_a_native_exe_later_on_path_wins_over_an_earlier_shim() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        make_exec(&first.path().join("kimi.cmd"));
        let exe = second.path().join("kimi.exe");
        make_exec(&exe);
        let search = Search {
            path_dirs: vec![first.path().to_path_buf(), second.path().to_path_buf()],
            extra_dirs: Vec::new(),
            extensions: vec![".exe".into(), ".cmd".into()],
        };
        assert_eq!(resolve_command("kimi", "kimi", &search, true), Ok(exe));
    }

    #[test]
    fn the_spawn_spec_passes_args_separately_and_puts_the_node_last() {
        let env = vec![("SWITCHBOARD_NODE".to_string(), "spoofed".to_string()), ("KEY".to_string(), "v".to_string())];
        let args = vec!["--a b".to_string(), "c;d".to_string()];
        let spec = spawn_spec(Path::new("/bin/kimi"), &args, "/p", env, "node-1");
        assert_eq!(spec.program, PathBuf::from("/bin/kimi"));
        assert_eq!(spec.args, args, "each argument its own entry, never a shell string");
        assert_eq!(spec.cwd, PathBuf::from("/p"));
        assert_eq!(spec.env.last(), Some(&("SWITCHBOARD_NODE".to_string(), "node-1".to_string())));
    }

    #[test]
    fn a_proposed_uuid_is_kept_and_anything_else_replaced() {
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(node_id_for(&id), id);
        let fresh = node_id_for("not-a-uuid");
        assert_eq!(uuid::Uuid::parse_str(&fresh).unwrap().get_version_num(), 4);
    }

    #[test]
    fn an_exit_has_attention_unless_seen() {
        assert!(exit_attention(false));
        assert!(!exit_attention(true));
        let runs = AgentRuns::default();
        runs.insert(run("a1", "p"));
        runs.insert(run("a2", "p"));
        // Unselected, focused: unseen.
        assert!(runs.exited("a1", 0, true).unwrap().attention);
        // A second exit report changes nothing.
        assert!(runs.exited("a1", 3, true).is_none());
        // Selected but the window unfocused: unseen.
        runs.acknowledge(Some("a2"));
        assert!(runs.exited("a2", 0, false).unwrap().attention);
        // Selected and focused: seen.
        runs.restarted("a2", 2);
        assert!(!runs.exited("a2", 1, true).unwrap().attention);
        assert_eq!(runs.get("a2").unwrap().exited, Some(1));
        assert!(runs.exited("gone", 0, false).is_none());
    }

    #[test]
    fn selecting_a_card_acknowledges_its_attention() {
        let runs = AgentRuns::default();
        runs.insert(run("a1", "p"));
        runs.exited("a1", 0, false);
        assert!(!runs.acknowledge(Some("other")));
        assert!(runs.get("a1").unwrap().attention);
        assert!(runs.acknowledge(Some("a1")));
        assert!(!runs.get("a1").unwrap().attention);
        assert!(!runs.acknowledge(Some("a1")), "once");
        assert!(!runs.acknowledge(None));
    }

    #[test]
    fn cards_are_agent_children_newest_first_with_memory_positions() {
        let runs = AgentRuns::default();
        runs.insert(run("a1", "p"));
        runs.insert(run("a2", "q"));
        runs.set_position("a1", Position { x: 4.0, y: 8.0 }).unwrap();
        assert_eq!(runs.set_position("nope", Position { x: 0.0, y: 0.0 }), Err(UNKNOWN_AGENT_CARD.to_string()));
        let kids = runs.children();
        assert_eq!(kids.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a2", "a1"]);
        let a1 = &kids[1];
        assert_eq!(a1.kind, ChildKind::Agent);
        assert_eq!(a1.label, "kimi-a1");
        assert_eq!(a1.position, Some(Position { x: 4.0, y: 8.0 }));
        assert!(a1.session.is_none() && !a1.has_transcript);
        let meta = a1.agent.as_ref().unwrap();
        assert_eq!((meta.agent.as_str(), meta.exited, meta.attention), ("kimi", None, false));
        assert!(meta.started_at.ends_with('Z'), "{}", meta.started_at);
        runs.clear_positions("p");
        assert_eq!(runs.get("a1").unwrap().position, None);
        assert_eq!(runs.forget_project("p"), ["a1"]);
        assert!(!runs.contains("a1") && runs.contains("a2"));
    }

    #[test]
    fn find_setting_names_an_unknown_agent() {
        let agents = vec![AgentSetting {
            name: "kimi".into(),
            ..AgentSetting::default()
        }];
        assert_eq!(find_setting(&agents, "kimi").unwrap().name, "kimi");
        assert_eq!(find_setting(&agents, "qwen").unwrap_err(), "unknown agent qwen");
    }
}
