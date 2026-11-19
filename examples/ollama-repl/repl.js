#!/usr/bin/env qjsm
/**
 * A Claude-Code-style REPL that talks to a local Ollama model (default:
 * qwen2.5-coder, over a kept-alive HTTP connection - lib/ollama-client.js,
 * built on the `httpClient` protocol adapter, lib/lws/protocols.js),
 * Google's Gemini API (lib/gemini-client.js), or any OpenAI-compatible API
 * (lib/openai-client.js, same `httpClient`-based structure as GeminiClient
 * - works with OpenAI, Mistral, Together, Groq, local servers, etc.) -
 * `--provider` selects which. All three clients expose the same
 * `chat()`/`chatStream()` shape, so everything below this point is
 * provider-agnostic.
 *
 * File/glob references typed into a prompt ("fix the bug in src/foo.js",
 * "review *.md") are detected, read, and attached to the outgoing message
 * (lib/file-refs.js); files the model sends back using the "File: path"
 * convention below are parsed out of its reply and written into the
 * project tree (lib/file-blocks.js), same as Claude Code applying an edit.
 *
 * Run (Ollama must already be running locally with the model pulled; for
 * `--provider gemini`, GEMINI_API_KEY must be exported instead, and for
 * `--provider openai`, OPENAI_API_KEY):
 *   qjsm repl.js [--provider ollama|gemini|openai|bridge] [--model NAME|list] [--host localhost] [--port 11434] [--root .]
 * Or, once installed (see CMakeLists.txt - installs to bin/ollama-repl,
 * lib/ollama-client.js's cross-tree imports rewritten to the installed
 * `lws/*.js` module path):
 *   ollama-repl [--model ...] [...]
 *
 * `--failsafe` drops all of the above scaffolding: no system prompt, no
 * project scan, no file-ref attachment, no tool-calling loop, no
 * "File:" auto-write - just the conversation, sent to the model as-is, for
 * when the normal prompt/tooling machinery itself is what's under
 * suspicion (or simply unwanted).
 *
 * Three separate logs, not one - each answers a different question:
 *   - `<model>.log` (lib/session-log.js) - the conversation transcript
 *     (prompts/replies/tool calls/files written), always on.
 *   - `<provider>-repl-debug.log` (lib/logger.js's `RequestLogger`, one
 *     per client) - the raw request/response JSON each provider actually
 *     sent/received, turned on by `-x`/`--debug` here or by setting the
 *     `DEBUG` env var to any non-empty value (not a numeric "level" -
 *     `DEBUG=1` and `DEBUG=anything` behave identically).
 *   - `TRAFFIC=<path>` (an env var, not a flag - read once by
 *     lib/lws/context.js, shared by every client) - native-level socket
 *     RX/TX bytes for the underlying HTTP connection itself (connects,
 *     writes, reads, closes), for when the JSON traffic above looks fine
 *     but something at the socket/HTTP layer is suspect. Setting `DEBUG`
 *     also prints lws's own ERR/WARN/USER lines straight to the terminal,
 *     independent of `TRAFFIC`.
 */
import { exit, getenv, loadFile, open as fopen, popen, out as stdout, err as stderr } from 'std';
import { clearTimeout, exec, getcwd, getpid, isatty, kill, realpath, setTimeout, stat, readdir, S_IFDIR, ttyGetWinSize } from 'os';
import { rmSync } from 'fs';
import { OllamaClient } from './lib/ollama-client.js';
import { GeminiClient } from './lib/gemini-client.js';
import { OpenAIClient } from './lib/openai-client.js';
import { Failover, failoverNote, skipNote } from './lib/failover.js';
import { buildHandoff, HANDOFF_MODEL } from './lib/handoff.js';
import { startBridge, pickModel } from './lib/bridge-process.js';
import { extractFileRefs, formatFileBlocks, SOURCE_EXT } from './lib/file-refs.js';
import { saveAllBlocks } from './lib/file-blocks.js';
import { TOOLS, executeTool, resetJournal, undoJournal, writeCount } from './lib/tool-requests.js';
import { looksLikeBindingPrompt, bindingContext } from './lib/binding-context.js';
import { fileMode, SKIP_DIRS } from './lib/match.js';
import { ChatREPL } from './lib/chat-repl.js';
import { ControlSocket, controlDir, listSessions } from './lib/control-socket.js';
import { SessionLog } from './lib/session-log.js';
import { SessionStore } from './lib/session-store.js';
import { SentFiles } from './lib/sent-files.js';
import { FileExchange } from './lib/file-exchange.js';
import { runCommand } from './lib/run-command.js';
import { extractTextToolCalls } from './lib/text-tool-calls.js';
import { formatUsage } from './lib/usage.js';
import { UsageStats, routeLine, routeName, formatMeta, formatTable, fmtNum, fmtMs } from './lib/usage-stats.js';
import { MODES, DEFAULT_MODE, MODE_INFO, MODE_COLOR, PLAN_NOTE, nextMode, toolAllowed, needsApproval, describeWrite, WRITE_TOOLS } from './lib/modes.js';
import { expandHome, unquote } from './lib/paths.js';
import { Gateway, FREELLM_URL } from './lib/freellm.js';
import { pickNext, probeModel, isTransient } from './lib/standby.js';
import { SETTINGS, configDir, settingsPath, globalSettings, setSetting, unsetSetting } from './lib/config.js';
import { findPeers, askPeer, peerAnswer } from './lib/peer.js';
import { listSkills, findSkill, skillMessage, skillMarker, skillDirs } from './lib/skills.js';
import { Delegates, KINDS, DELEGATE_NOTES, discoverGateway, memoryLines } from './lib/delegates.js';
import { loadAvailability, kindsText, limitsText, limitedText, backText } from './lib/availability.js';
import { Tui } from './lib/tui.js';
import { exitIp, measure, newExit, proxied, proxySettings, setProxyEnabled } from './lib/proxy-probe.js';
import { PORT_NAMES, ownSockets, processInfo } from './lib/resources.js';
import { MarkdownStream } from './lib/markdown.js';
import { done as doneQuip, quip } from './lib/quips.js';
import { colorArgs, colorContent, colorJson, colorMeta } from './lib/rawcolor.js';
import { replyMark, waveNote, banner, gradientRule, helpPanel, numberedDiff, toolLine, toolResult, meter, modeBadge, panel, reportPanel, shortPath, WARN as WARN_BORDER } from './lib/look.js';
import { keyValue, statusBar, stripAnsi } from 'terminal';
import { piped, dim, red, green, wrapHanging } from './lib/ansi.js';

/* rmSync throws on a missing file, os.remove did not */
const removeFile = path => rmSync(path, { force: true });

/* Bounds the tool-calling loop (see TOOLS/lib/tool-requests.js and
   runToolLoop() below) - a tool-call round costs a real network round trip
   to the model, so this caps both latency and (if the model gets stuck
   re-requesting) runaway cost, not just literal infinite loops. */
const DEFAULT_MAX_ROUNDS = 40;

const THINK_VALUES = ['detect', 'on', 'off', 'true', 'false', 'auto', 'low', 'medium', 'high'];

const USAGE = [
  'Usage: qjsm repl.js [OPTIONS]',
  '',
  'A Claude-Code-style REPL for a local Ollama model, Gemini, any OpenAI-compatible API or the chat-bridge.',
  '',
  '@Provider and model',
  ['--provider NAME', 'ollama (default), gemini, openai, freellm or bridge. freellm is a freellmapi gateway (FREELLMAPI_URL, else http://localhost:3001/v1, key FREELLMAPI_KEY, else OPENAI_API_KEY), model auto. bridge starts examples/chat-bridge itself on a free port and uses it (models = the chat sites).'],
  ['--model NAME', 'model to talk to; with bridge one is picked in turn unless given.'],
  ['--model list', 'list the available chat models and exit (gemini, openai-compatible /models incl. chat-bridge; ollama via `ollama list`).'],
  ['--host HOST', 'API host (default localhost).'],
  ['--port PORT', 'API port (default 11434).'],
  ['--root DIR', 'project directory the model works in (default .).'],
  '',
  '@Conversation',
  ['--stream', 'print the reply as it arrives.'],
  ['--temperature T', 'sampling temperature (default 0.2).'],
  ['--num-ctx N', 'context window requested from Ollama (default 16384; Ollama itself defaults to 4096).'],
  [
    '--think [MODE]',
    'ollama: let the model think before answering. MODE is detect (default: on if `ollama show` lists the "thinking" capability, else off), on (default when the flag has no MODE), off, auto (send nothing, the model decides) or low|medium|high (gpt-oss). `on` errors on models without that capability; thinking is much slower on a model running partly on the CPU.',
  ],
  ['--max-rounds N', 'tool-calling rounds per prompt (default 40).'],
  ['--no-system', 'start without the built-in system prompt (tools and project scan stay); set one later with /system. For controllers that bring their own.'],
  ['--no-tui', 'plain scrolling output instead of the full-terminal interface (input box and status line at the bottom). The TUI is used only when stdin and stdout are a terminal.'],
  ['--failsafe', 'no system prompt, project scan, file attachment, tool loop or File: auto-write: just the bare conversation.'],
  ['--mode MODE', `what the model may do without asking: ${MODES.join(', ')} (default ${DEFAULT_MODE}). plan: read-only, answers with a plan. auto: nothing asks. manual: every file change and command asks. edits: file changes run, commands ask. Shift-Tab (or Alt-Tab) cycles them.`],
  ['--yes, -y', 'same as --mode auto: run_command and file changes without asking (unattended agents).'],
  ['--fallback-model NAME', 'model to switch to when the current one fails (also /fallback).'],
  ['--resume FILE', 'continue the session saved in FILE by /restart or the restart_harness tool (the file is deleted after loading).'],
  ['--verbose', 'start with the verbose view on (Ctrl-O toggles it): reasoning text, full tool results, every request and response with the gateway headers.'],
  '',
  '@Chat sites (--provider bridge)',
  ['--no-tools', 'offer the model no tools: files named in the prompt are attached as text and the model answers with whole `File: path` blocks, which are written to disk. For chat sites that ignore tool calls (chatgpt, duck, deepai).'],
  ['--scan', 'also send the project scan at session start (off by default, the chat sites take limited messages).'],
  ['--allow-paid', 'also use pay-as-you-go sites (openrouter); refused and skipped by default, they can cost money.'],
  ['--cdp-host HOST', 'browser to drive (default 127.0.0.1).'],
  ['--cdp-port PORT', 'browser debugging port (default 9222).'],
  '',
  '@Failover (when a chat model hits its limit)',
  ['--no-failover', 'stay on the chosen model instead of switching to another.'],
  ['--self-edit', 'let the model change ollama-repl\'s own files (when it runs from the source tree) without asking, even in auto mode; without it every such edit asks and is never remembered.'],
  ['--worker', 'run as a worker for other ollama-repl instances: listens (--listen), never delegates itself; a session on the same --root may hand it tasks (spawn_agent kind ..., /delegate), so jobs can run on another --provider'],
  ['--no-delegate', 'do not tell the model it may hand documentation, build wiring, summaries and repetitive jobs to weaker sub-agent models (/delegate)'],
  ['--standby', 'with a freellmapi gateway: keep the model the gateway would use next probed and warm, as a switch-over target and sub-agent model (/standby)'],
  ['--compact-at PCT', 'compact the conversation (older turns summarized by a local model, as for a failover) when it uses this percent of the context window (default 80, 0 = never). /compact does it at once.'],
  ['--no-handoff', 'replay the whole conversation to the next model instead of compacting it.'],
  ['--handoff-turns N', 'turns kept verbatim when compacting (default 3); older ones are summarized.'],
  ['--handoff-model NAME', 'local ollama model that writes the summary (default qwen3:4b-instruct).'],
  '',
  '@Control and debugging',
  ['--listen [PATH]', 'open a control socket so another process (ollama-repl-ctl, Claude Code) can type into this session and read its output.'],
  ['--name NAME', 'session name for --listen (default: the model name, made unique); ollama-repl-ctl -s NAME picks it among several.'],
  ['-x, --debug', 'log raw request/response JSON to <provider>-repl-debug.log (same as setting DEBUG=1).'],
  ['-h, --help', 'show this help and exit.'],
  '',
  '@Environment',
  ['DEBUG=1', 'same as --debug; also prints lws ERR/WARN/USER lines to the terminal.'],
  ['TRAFFIC=PATH', 'log native socket-level RX/TX traffic to that file.'],
  ['GEMINI_API_KEY', 'API key for --provider gemini.'],
  ['OPENAI_API_KEY', 'API key for --provider openai (and freellm, unless FREELLMAPI_KEY is set).'],
  ['OPENAI_API_URL', 'base URL for --provider openai.'],
  ['FREELLMAPI_KEY, FREELLMAPI_URL', 'unified key and base URL of a freellmapi gateway, for --provider freellm.'],
  ['FREELLMAPI_DASHBOARD_TOKEN', 'dashboard session token of the gateway; with it /gateway quota and the status line show per-model quotas (requests and tokens per minute/day, monthly budget). FREELLMAPI_EMAIL + FREELLMAPI_PASSWORD log in instead.'],
  '',
  '@Examples',
  ['qjsm repl.js', 'chat with the default local Ollama model.'],
  ['qjsm repl.js --provider gemini --stream', 'Gemini, replies printed as they arrive.'],
  ['qjsm repl.js --provider freellm --model auto:smart', 'free models behind a local freellmapi; /usage and /gateway show where each request went.'],
  ['qjsm repl.js --provider bridge --no-tools', 'free chat sites through chat-bridge.'],
];

function parseArgs(argv) {
  const opts = { ...{ mode: DEFAULT_MODE, provider: 'ollama', model: undefined, host: 'localhost', port: 11434, root: '.', stream: false, debug: false, failsafe: false, numCtx: 16384, temperature: 0.2, maxRounds: DEFAULT_MAX_ROUNDS, yes: false, listen: undefined, noSystem: false, name: undefined, think: 'detect', resume: undefined, fallbackModel: undefined, compactAt: 80, sessionId: undefined }, ...globalSettings() };

  for(let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if(arg === '--provider') opts.provider = argv[++i];
    else if(arg === '--model') opts.model = argv[++i]?.trim(); // trim() also drops a pasted no-break space
    else if(arg === '--host') opts.host = argv[++i];
    else if(arg === '--port') opts.port = +argv[++i];
    else if(arg === '--root') opts.root = argv[++i];
    else if(arg === '--no-failover') opts.noFailover = true;
    else if(arg === '--no-delegate') opts.noDelegate = true;
    else if(arg === '--worker') opts.worker = true;
    else if(arg === '--no-tools') opts.noTools = true;
    else if(arg === '--no-tui') opts.noTui = true;
    else if(arg === '--scan') opts.scan = true;
    else if(arg === '--allow-paid') opts.allowPaid = true;
    else if(arg === '--no-handoff') opts.noHandoff = true;
    else if(arg === '--self-edit') opts.selfEdit = true;
    else if(arg === '--compact-at') opts.compactAt = +argv[++i];
    else if(arg === '--standby') opts.standby = true;
    else if(arg === '--handoff-turns') opts.handoffTurns = +argv[++i];
    else if(arg === '--handoff-model') opts.handoffModel = argv[++i];
    else if(arg === '--cdp-host') opts.cdpHost = argv[++i];
    else if(arg === '--cdp-port') opts.cdpPort = +argv[++i];
    else if(arg === '--stream') opts.stream = true;
    else if(arg === '-x' || arg === '--debug') opts.debug = true;
    else if(arg === '--failsafe') opts.failsafe = true;
    else if(arg === '--no-system') opts.noSystem = true;
    else if(arg === '--name') opts.name = argv[++i]?.trim();
    else if(arg === '--think') {
      const v = argv[i + 1];
      if(v !== undefined && THINK_VALUES.includes(v)) i++;
      opts.think = v !== undefined && THINK_VALUES.includes(v) ? (v === 'on' || v === 'true' ? true : v === 'off' || v === 'false' ? false : v) : true;
    } else if(arg === '--num-ctx') opts.numCtx = +argv[++i];
    else if(arg === '--temperature') opts.temperature = +argv[++i];
    else if(arg === '--max-rounds') opts.maxRounds = +argv[++i];
    else if(arg === '--yes' || arg === '-y') opts.mode = 'auto';
    else if(arg === '--mode') opts.mode = argv[++i];
    else if(arg === '--verbose') ui.verbose = true;
    else if(arg === '--listen') opts.listen = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
    else if(arg === '--resume') opts.resume = argv[++i];
    else if(arg === '--fallback-model') opts.fallbackModel = argv[++i];
    else if(arg === '--help' || arg === '-h') {
      console.log(formatUsage(USAGE));
      exit(0);
    }
  }

  if(!['ollama', 'gemini', 'openai', 'freellm', 'bridge'].includes(opts.provider)) {
    console.log(red(`error: --provider must be "ollama", "gemini", "openai", "freellm" or "bridge", got "${opts.provider}"`));
    exit(1);
  }

  if(!MODES.includes(opts.mode)) {
    console.log(red(`error: --mode must be one of ${MODES.join(', ')}, got "${opts.mode}"`));
    exit(1);
  }

  if(opts.worker) {
    opts.noDelegate = true;
    opts.listen ??= '';
    opts.name ??= `worker-${opts.provider}`;
  }

  opts.modelGiven = opts.model !== undefined;
  if(opts.resume) opts.resume = expandHome(opts.resume);

  /* freellm: an OpenAI-compatible endpoint, found out to be a gateway in main() */
  if(opts.provider === 'freellm') {
    opts.provider = 'openai';
    opts.label = 'freellm';
    opts.baseUrl = getenv('FREELLMAPI_URL') ?? FREELLM_URL; // OPENAI_API_URL may name another service
    if(getenv('FREELLMAPI_KEY')) opts.apiKeyEnv = 'FREELLMAPI_KEY';
    opts.model ??= 'auto';
  }

  /* bridge: undefined = picked from the bridge's models, see main() */
  opts.model ??= opts.provider === 'gemini' ? 'gemini-flash-latest' : opts.provider === 'openai' ? 'gpt-4o-mini' : opts.provider === 'bridge' ? undefined : 'qwen2.5-coder';

  return opts;
}

const NOTOOLS_PROMPT = `You are a coding assistant that changes the code in the user's project.
You have no tools and cannot run anything. The files the user names are
attached to their message; work only from those.

To change or create a file, answer with the COMPLETE new content of that
file in this exact form, and nothing else inside the block:

File: path/to/file.js
\`\`\`js
...whole file...
\`\`\`

Rules: one File: block per changed file, the path exactly as the user
wrote it. Keep everything you were not asked to change exactly as it was
(same indentation, comments, order). Do not add explanations before the
block; one short sentence after it is fine. If you cannot do the task from
the attached files, say what is missing.`;

/* a chat site takes one message at a time and some cap it (duck.ai: 16000
   characters): the long default prompt and the project scan would eat that,
   so --provider bridge starts with this short one and no scan (--scan
   brings the scan back) */
const BRIDGE_PROMPT = `You are a coding assistant working in the user's project directory. Act with
the tools you are given instead of describing changes: read_file a file
before you change it, change it with edit_file (exact old text) or
insert_above, keep the existing style, change only what was asked, and end
with one short sentence saying what you did.`;

const SYSTEM_PROMPT = `You are a coding assistant that maintains and refactors the code in the
current project directory, like Claude Code. You act through tools: you do
not just describe changes, you make them.

Tools: list_directory, read_file (optionally start/end lines), grep,
insert_above (add lines above an existing line), edit_file (replace exact
existing text), write_file (new files),
for_each (same task over a list of items), run_command (shell; the user
approves it), ask_user.

How to work:
- Look before you change anything: read_file the file you will edit and
  any file whose contents you need to know. Never guess what code does -
  read it. Attached files in the user's message are already read.
- Change files with insert_above (adding lines, e.g. a comment above a
  function) or edit_file (replacing text), in small steps, one change per
  call, with anchor/old_string copied exactly from what you just read.

- A job that repeats over many things is ALWAYS a for_each call, never
  something you do yourself one by one: you only list the items and
  write the task once, for_each does the work. Example - "document every
  function in lib/foo.h from lib/foo/<name>.c": read lib/foo.h (if not
  attached), then call for_each(items=["foo_a", "foo_b", ...], task="In
  lib/foo.h add a 1-2 line comment above the declaration of {item}, based
  on what its source lib/foo/{item}.c does").
- Make only the change that was asked for. Keep the existing code and
  its style as it is: same indentation, same comment style as the
  neighbouring code, no reformatting, no renaming.
- If an edit_file call returns an error, read the file again and retry
  with corrected text.
- When finished, check with run_command (\`git diff\`, build, tests) if
  that is possible, then reply with a short summary of what you changed.
  Do not paste the whole file into your reply.
- Ask the user (ask_user) only if something genuinely cannot be found out
  by looking.

Attached file contents in the user's messages look like:

File: path/to/file.ext
\`\`\`language
...current contents...
\`\`\`
(imports/includes: ../lib/foo.js - read_file any of these you actually need)

The project's top-level layout and README are given below, gathered when
the session started.`;

/* Only appended for QuickJS projects (see main()) - it is noise, and costs
   context a small model needs, anywhere else. */
const QJS_NOTES = `

This project runs on QuickJS (qjs/qjsm), not Node.js - don't assume Node's
globals, module system ("require", "node_modules"), or built-ins ("path",
"crypto", "buffer", "process.nextTick") are available. Before writing code
that touches the filesystem, environment, process, or child processes,
check (read_file/run_command - e.g. grep for "from 'process'"/"from 'fs'"/
"from 'util'"/"from 'child_process'") whether the file/project you're
editing already imports one of qjs-modules' own built-ins (process/fs/
util/child_process) - if so, match that existing convention; otherwise
default to QuickJS's own std/os modules, since those are always present
with no extra dependency (quickjs.md, one read_file away, is the
reference). This only constrains code meant to run inside qjs/qjsm itself
- write ordinary browser-side JS when that's what's actually being asked
for.

Writing a new native (C) QuickJS binding is a common request here - when
one of examples/fib.c, examples/point.c, and the quickjs-binding-api.md
cheat sheet are attached below, they're the reference for it, already
picked for you; otherwise read_file an existing one for the real shape of
the boilerplate (a sibling "qjs-*" project's own .c file, or
list_directory one of them if you don't know which - qjs-ffi and
qjs-modules are the most representative), and read_file quickjs.h for any
exact JS_* signature the cheat sheet doesn't cover, rather than recalling
it from memory. Before writing any C, sketch the JS-facing API in one or
two lines as plain text (argument/return types, sync vs. async, e.g.
\`deflate(data: ArrayBuffer|Uint8Array): ArrayBuffer\`) - catches a bad
shape before code exists for it, and gives the human a checkpoint to
redirect at. Verify the binding compiles/links and a quick JS-side smoke
test actually works via run_command - compile it standalone, not through
this project's own build (that pulls in libwebsockets and a multi-minute
link for something that needs none of it):
\`gcc -shared -fPIC -I<quickjs-source-dir> -o binding.so binding.c
-DJS_SHARED_LIBRARY [-lwhatever]\`, then \`qjsm -e '<smoke test importing
./binding.so>'\` - before presenting it as done, don't just describe code that should work.`;

/** @returns {{ text: string, attached: string[] }} */
const NUDGE = `You have not changed anything yet. Do not print file contents or code in your reply - make the change with a tool call now: for_each if the job repeats over many things, otherwise insert_above or edit_file (read_file first if you need to see the code).`;

/** True if the conversation's latest user request (not a nudge) asks to modify code or files. */
function asksForChange(messages) {
  const users = messages.filter(m => m.role === 'user' && m.content !== NUDGE);
  const last = users[users.length - 1];
  /* `request` is what was typed; `content` also carries attached file
     contents, whose code ("add", "update", ...) must not read as a request */
  return /\b(add|insert|change|fix|refactor|rename|remove|delete|write|create|update|implement|replace|document|comment|convert|rewrite)\b/i.test(last?.request ?? last?.content ?? '');
}

/* Least privilege for a batch item: a task that is only about adding comments
   gets insert_above but not edit_file/write_file. Measured with qwen3.5:4b:
   given edit_file it "inserts" by replacing a multi-line span and silently
   drops or duplicates the declarations in it (path_parentlen/path_dirlen
   vanished from a header); insert_above cannot destroy anything. */
function omitToolsFor(task) {
  const commentOnly = /\b(comment|document|documentation)\b/i.test(task) && !/\b(replace|rename|change|fix|remove|delete|refactor|rewrite|update|convert)\b/i.test(task);
  return commentOnly ? ['edit_file', 'write_file', 'run_command'] : [];
}

/** Absolute, normalised directory for `/cd arg`: ~ is the home directory, a relative arg is taken from the current root (not the process cwd), . and .. are folded. */
function resolveDir(root, arg) {
  arg = expandHome(unquote(arg));

  const cwd = getcwd()[0];
  const base = root.startsWith('/') ? root : root === '.' ? cwd : `${cwd}/${root}`;
  const parts = [];

  for(const part of (arg.startsWith('/') ? arg : `${base}/${arg}`).split('/')) {
    if(part === '' || part === '.') continue;
    if(part === '..') parts.pop();
    else parts.push(part);
  }

  return '/' + parts.join('/');
}

/** True if the project's top-level build files mention QuickJS. */
function isQuickJsProject(root) {
  for(const f of ['CMakeLists.txt', 'README.md', 'package.json']) {
    const text = loadFile(root === '.' ? f : `${root}/${f}`);
    if(text && /quickjs|qjsm?\b/i.test(text)) return true;
  }
  return false;
}

function attachFiles(prompt, root, fileExchange) {
  const { files, skipped } = extractFileRefs(prompt, root);

  if(skipped.length) console.log(dim(`(skipped, too large or unreadable: ${skipped.join(', ')})`));
  if(!files.length) return { text: prompt, attached: [] };

  const attached = files.map(f => f.path);

  console.log(dim(`(attached: ${attached.join(', ')})`));
  fileExchange.recordSent(attached);

  return { text: `${prompt}\n\n${formatFileBlocks(files)}`, attached };
}

/** @returns {string[]} paths actually written (named "File:" blocks and auto-named anonymous ones alike) */
async function applyFileBlocks(reply, root, sentFiles, fileExchange) {
  const { written, rejected } = await saveAllBlocks(reply, { root, sentFiles, fileExchange });

  for(const path of written) console.log(green(`modified: ${path}`));
  for(const path of rejected) console.log(red(`refused to write (unsafe path): ${path}`));

  return written;
}

/* Unicode "quadrant" block glyphs (U+2596/2598/259D/2597 - each literally
   named QUADRANT LOWER-LEFT/UPPER-LEFT/UPPER-RIGHT/LOWER-RIGHT in the
   Unicode block-elements table), cycled to animate a spinner while
   waiting for the model - stopped the moment there's something to show
   for it (the first streamed token, or the whole non-streamed reply). */
const SPINNER_FRAMES = ['▘', '▝', '▗', '▖'];
const SPINNER_MS = 120;

/** "1m 5s"/"42s" - only shown once a call has been running long enough
    (see startSpinner() below) that knowing it's still alive, not stuck,
    actually matters. */
function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/* How long a call runs before the spinner starts showing elapsed time -
   the TCP connection can legitimately sit open and idle for minutes
   (Ollama cold-loading a model, a long generation) with nothing else to
   show for it; below this, "Thinking..." alone is enough and a timer
   would just be noise for the common fast-reply case. Same idea as
   Claude Code's own "still working" indicator. */
const SPINNER_ELAPSED_THRESHOLD_MS = 60_000;

/* how long one quip stays in the spinner before the next */
const QUIP_MS = 4000;

/** Starts an animated "<glyph> Thinking...(1m 5s)" line - the elapsed-time
    suffix only appears past SPINNER_ELAPSED_THRESHOLD_MS - and returns a
    function that stops it and clears the line. */
function startSpinner(label) {
  if(tui?.active) return tuiSpinner(label);

  const t0 = Date.now();
  const seed = Math.floor(Math.random() * 1e6);
  let i = 0;
  let timer;
  let lastLen = 0;

  const tick = () => {
    const elapsed = Date.now() - t0;
    const suffix = elapsed >= SPINNER_ELAPSED_THRESHOLD_MS ? ` (${formatElapsed(elapsed)})` : '';
    const text = `${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${label ?? quip(phase.name, seed + Math.floor(elapsed / QUIP_MS))}...${suffix}`;

    stdout.puts(`\r${text}${' '.repeat(Math.max(0, lastLen - text.length))}`);
    stdout.flush();
    lastLen = text.length;
    timer = setTimeout(tick, SPINNER_MS);
  };

  tick();

  /* Idempotent - safe to call more than once (chatRound() below always
     calls this in a `finally`, on top of whichever call site already
     stopped it on success) - a second call is a harmless no-op instead
     of re-clearing an already-cleared timer or re-printing the blank
     line. Without this, a failed chat()/chatStream() call (the timer was
     never explicitly stopped on that path) left the tick() loop running
     forever - confirmed directly: it kept overwriting the terminal with
     "\r<glyph> Thinking..." every SPINNER_MS, right through the next
     prompt and whatever the user typed into it, garbling both. */
  return () => {
    if(timer == null) return;

    clearTimeout(timer);
    timer = null;
    stdout.puts(`\r${' '.repeat(lastLen)}\r`);
    stdout.flush();
  };
}

/* the TUI shows the spinner in the rule above the input, elapsed time always */
/* what the session does right now: the rule above the input says it, the status pane shows it */
const phase = { name: 'idle', since: Date.now(), meta: null, tool: null };

function setPhase(name, extra = {}) {
  Object.assign(phase, { name, since: Date.now(), tool: null }, extra);
  tui?.drawPane();
}

/** 900 -> '900B', 12345 -> '12.1KB' */
const fmtBytes = n => (n == null ? '-' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);

/** the phase in words, null when idle */
function phaseText() {
  const m = phase.meta ?? {};
  const secs = Math.max(0.001, (Date.now() - phase.since) / 1000);

  switch (phase.name) {
    case 'sending':
      return `sending the request, ${fmtBytes(m.bytesOut)}`;
    case 'waiting':
      return `waiting for the model${proxyInfo.settings?.active ? ', upstream through the proxy' : ''}`;
    case 'headers':
      return `waiting for the first token (headers in, ${m.status ?? '-'}${m.routedVia ? ` from ${m.routedVia}` : ''})`;
    case 'receiving':
      return `receiving the reply${m.routedVia ? ` from ${m.routedVia}` : ''}`;
    case 'reasoning':
      return `model reasoning, ${fmtBytes(m.bytesIn)} in`;
    case 'streaming':
      return `streaming the reply, ${m.chunks} chunks ${(m.chunks / secs).toFixed(1)}/s, ${fmtBytes(m.bytesIn)} in`;
    case 'tool-call':
      return `receiving a tool call, ${fmtBytes(m.bytesIn)} in`;
    case 'tool':
      return `running ${phase.tool}`;
    case 'you':
      return 'waiting for you';
  }

  return null;
}

/* the rule says a quip for the phase (see lib/quips.js), then what really happens */
function tuiSpinner(label) {
  const t0 = Date.now();
  const seed = Math.floor(Math.random() * 1e6);
  let i = 0;
  let timer;

  const tick = () => {
    const elapsed = Date.now() - t0;
    const facts = phaseText() ?? label;
    const joke = quip(phase.name, seed + Math.floor(elapsed / QUIP_MS));
    tui.setActivity(`${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${joke}…${facts ? ` · ${facts}` : ''} ${formatElapsed(elapsed)}`);
    timer = setTimeout(tick, SPINNER_MS);
  };

  tick();
  tui.drawStatus();

  return () => {
    if(timer == null) return;

    clearTimeout(timer);
    timer = null;
    tui.setActivity('');
    tui.drawStatus();
  };
}

/**
 * One chat() or chatStream() call, printed the same way either way -
 * shows a spinner (startSpinner() above) until the first sign of a reply
 * (the first token, or the whole reply for non-streaming), then a
 * quip-and-time line ("Made it so in 3.2s", lib/quips.js) once it's completely done. `abortRef.current` is
 * set to the active client's abort() for the duration of the call (and
 * cleared after) - see main()'s ChatREPL construction below, whose Ctrl-C
 * handler calls it to cancel the in-flight request instead of quitting.
 * The reply line (`<provider>> ...`) is only printed when there's actual
 * text content - a tool-only turn (see runToolLoop() below) has none, and
 * printing an empty "<provider>> " line for it would just be noise.
 * `chatOptions` (`{ tools, toolChoice }` - see API.md) is passed straight
 * through to client.chat()/chatStream().
 * @returns {Promise<{content: string, toolCalls?: object[]}>}
 */
/* set by main() when the endpoint is a chat-bridge: { failover, handoff, onSwitch }; used for a pinned site only */
let failoverHook = null;

/* set by main(): { client(), skip(error) }. A gateway that ran out of models ("All models exhausted") makes the
   round run /model skip itself and ask again, up to AUTO_SKIPS times a round; skipError is the error that command
   works from (the stats may not hold it yet) */
let autoSkipHook = null;
let skipError = null;
const AUTO_SKIPS = 4;

/* lib/tui.js layout, set by main() on a terminal unless --no-tui */
let tui = null;

/* view switches: verbose (Ctrl-O) shows reasoning, full tool results and
   every request/response */
const ui = { verbose: false };

/* set by main(): asks the user to allow a file change (manual mode) */
let approveWrite = null;

/* set by main(): asks before a change to the harness's own files, never remembered */
let approveSelf = null;

/* context window of the model that answers (tokens), set by main(); undefined when unknown */
let ctxWindowNow;

/* set by main(): compacts a conversation when it nears the window (or at once with force) */
let compactHook = null;

/** drops the turn that began with `turnMsg` (an aborted or failed one); a no-op when compaction already folded it away */
function rollbackTurn(messages, turnMsg) {
  const i = messages.indexOf(turnMsg);
  if(i >= 0) messages.length = i;
}

/** tokens a conversation will cost the next request: characters / 3.5 plus the tool schemas */
const estimateTokens = msgs => Math.round(totalChars(msgs) / 3.5) + 1500;

/* the gateway's upstream proxy: settings (dashboard), last measure(), whether one runs */
const proxyInfo = { settings: null, probe: null, measuring: false, exits: [] };

/** the /proxy report: settings, the last measurement, time to first byte per platform */
function proxyText(stats) {
  const p = proxyInfo.settings;
  if(!p) return '(proxy settings need a dashboard session: /gateway login)';

  const out = [
    `proxy:     ${p.url || '(none)'} ${p.active ? 'active' : p.enabled ? 'enabled, not active' : 'off'}${p.mode && p.mode !== 'forward' ? ` (${p.mode})` : ''}`,
    `bypassed:  ${p.bypass.length ? p.bypass.join(', ') : '(no platform, all go through it)'}`,
  ];

  if(p.keyProxies.size) out.push(`own proxy: ${[...p.keyProxies].map(([k, u]) => `${k} ${u}`).join(', ')}`);
  if(proxyInfo.exits.length) out.push(`exit:      ${proxyInfo.exits.join(' -> ')}`);

  const m = proxyInfo.probe;
  if(m) {
    const row = (name, t) => [name, ...(t ? [fmtMs(t.connect), fmtMs(t.tls), fmtMs(t.ttfb), fmtMs(t.total)] : ['failed', '', '', ''])];
    out.push('', `measured ${new Date(m.at).toTimeString().slice(0, 8)} against ${m.url}:`, formatTable([['', 'connect', 'tls', 'first byte', 'total'], row('direct', m.direct), row('proxy', m.proxy)]));
    if(m.overhead != null) out.push(`overhead:  ${signedMs(m.overhead)} to the first byte of each request (proxy connect is the hop to the proxy, the circuit shows in tls)`);
  } else out.push('', proxyInfo.measuring ? '(measuring...)' : '(not measured yet: /proxy probe)');

  /* what the requests of this session saw, per platform */
  const groups = new Map();
  for(const r of stats.records) if(r.platform && r.ttfbMs != null) (groups.get(r.platform) ?? groups.set(r.platform, []).get(r.platform)).push(r);
  if(groups.size) {
    out.push('', 'this session, time to the response headers:');
    out.push(formatTable([['platform', 'proxied', 'requests', 'median', 'max'], ...[...groups].map(([k, rs]) => [k, proxied(p, k) ? 'yes' : 'no', rs.length, fmtMs(median(rs.map(r => r.ttfbMs))), fmtMs(Math.max(...rs.map(r => r.ttfbMs)))])]));
  }

  return out.join('\n');
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** 520 -> '+520ms', -90 -> '-90ms' */
const signedMs = ms => (ms < 0 ? '-' : '+') + fmtMs(Math.abs(ms));

/* every file change of the session, newest last, for the diff pane */
const changes = [];

/* the right-hand pane (/split): mode diff, git or status, and what it shows */
const split = { mode: null, git: '', sockets: [], timer: null };

/** lines of the pane, width cells wide (Tui clips them) */
function paneLines(width, height) {
  const head = t => `\x1b[1;38;2;45;212;191m${t}\x1b[0m`;

  if(split.mode === 'diff') {
    if(!changes.length) return [head('changes'), '', '\x1b[2m(no file changed yet in this session)\x1b[0m'];
    return [head(`changes (${changes.length}), newest first`), ...changes.slice().reverse().flatMap(c => ['', `\x1b[1m${c.title}\x1b[0m \x1b[2m${new Date(c.at).toTimeString().slice(0, 8)}\x1b[0m`, ...c.diff.split('\n')])];
  }

  if(split.mode === 'git') return [head('git diff'), ...(split.git ? split.git.split('\n') : ['', '\x1b[2m(no changes)\x1b[0m'])];

  return statusPane(width);
}

/** the status pane: what happens now, the current request, the sockets and their traffic */
function statusPane(width) {
  const m = phase.meta;
  const p = processInfo();
  const color = { idle: '2', you: '33', tool: '35' }[phase.name] ?? '32';
  const kv = (k, v) => `\x1b[38;2;45;212;191m${k.padEnd(10)}\x1b[0m ${v}`;
  const out = [`\x1b[1;${color}m● ${phaseText() ?? 'idle'}\x1b[0m`, kv('for', fmtMs(Date.now() - phase.since)), ''];

  if(m) {
    out.push(kv('request', `${m.requested ?? '?'}${m.routedVia ? ` → ${m.routedVia}` : ''}`));
    out.push(kv('traffic', `↑ ${fmtBytes(m.bytesOut)}  ↓ ${fmtBytes(m.bytesIn)}  ${m.chunks ?? 0} chunks`));
    if(m.ttfbMs != null) out.push(kv('headers', `after ${fmtMs(m.ttfbMs)}${m.firstTokenMs != null ? `, first token ${fmtMs(m.firstTokenMs)}` : ''}`));
    if(m.proxied != null) out.push(kv('proxy', m.proxied ? `yes${proxyInfo.probe?.overhead != null ? `, ${signedMs(proxyInfo.probe.overhead)} measured` : ''}` : 'no'));
    out.push('');
  }

  out.push(`\x1b[1msockets\x1b[0m \x1b[2m(pid ${getpid()}, ss)\x1b[0m`);
  for(const so of split.sockets) {
    const port = /:(\d+)$/.exec(so.peer)?.[1];
    const name = PORT_NAMES[port] ?? (so.kind === 'unix' && /ollama-repl/.test(so.local) ? 'control' : '');
    out.push(`${so.kind === 'tcp' ? 'tcp ' : 'unix'} ${so.state.padEnd(6)} ${so.peer}${name ? ` \x1b[2m(${name})\x1b[0m` : ''}`);
    if(so.kind === 'tcp') out.push(`     \x1b[2m↑ ${fmtBytes(so.sent)} ↓ ${fmtBytes(so.received)}${so.rtt != null ? ` rtt ${so.rtt}ms` : ''}${so.sendQ || so.recvQ ? ` queued ${so.sendQ}/${so.recvQ}` : ''}\x1b[0m`);
  }
  if(!split.sockets.length) out.push('\x1b[2m(none open)\x1b[0m');

  out.push('', `\x1b[1mprocess\x1b[0m`, kv('memory', p.rssKB ? fmtBytes(p.rssKB * 1024) : '-'), kv('fds', p.fds ?? '-'));
  return out;
}

/* the panels shown in the TUI, full text kept for /view N */
const panels = [];

/** keeps text for the pager, returns its number */
const keepPanel = (title, text) => panels.push({ title: stripAnsi(title), text });

/** a panel at most half the screen high into the transcript, the full text kept */
function showPanel(title, text, { kind = 0, ...opts } = {}) {
  const n = keepPanel(title, text);
  inKind(kind, () => console.log(panel(title, text, tui.width, { max: Math.max(6, Math.floor(tui.rows / 2) - 4), more: k => `… ${k} more lines · /view ${n} shows all`, ...opts })));
}

/** runs `fn` with what it writes to the TUI transcript tagged: 1 shown in the verbose view only, 2 outside it only (Tui.kind) */
function inKind(kind, fn) {
  if(!tui?.active || !kind) return fn();

  tui.kind = kind;
  try {
    return fn();
  } finally {
    tui.kind = 0;
  }
}

/** the verbose switch, applied to the transcript already written, too (the TUI keeps the verbose panels either way) */
function setVerbose(on) {
  ui.verbose = on;
  tui?.setVerbose(on);
}

/* how many messages of a conversation the verbose request panel has shown */
const shownMessages = new WeakMap();

const ROLE_COLOR = { system: '#2dd4bf', user: '#fbbf24', assistant: '#a3e635', tool: '#c084fc' };

/** messages as text for a panel: a colored role line, then the content */
function messagesText(msgs) {
  return msgs
    .map(m => {
      const head = `\x1b[1;38;2;${(ROLE_COLOR[m.role] ?? '#ffffff').match(/\w\w/g).map(h => parseInt(h, 16)).join(';')}m${m.role}${m.name ? ` ${m.name}` : ''}\x1b[0m`;
      const calls = (m.toolCalls ?? m.tool_calls ?? []).map(tc => `\x1b[38;2;192;132;252m→ ${tc.name ?? tc.function?.name}\x1b[0m(${colorJson(JSON.stringify(tc.args ?? tc.function?.arguments ?? {}))})`);
      /* the system prompt is long and known: dim; everything else by what each line is */
      const body = typeof m.content == 'string' ? (m.role === 'system' ? `\x1b[2m${m.content}\x1b[0m` : colorContent(m.content, { code: m.role === 'tool' && m.name === 'read_file' })) : m.content ? colorJson(JSON.stringify(m.content)) : null;
      return [head, ...(body === null ? [] : [body]), ...calls].join('\n');
    })
    .join('\n\n');
}

/** a path the model gave, relative to root */
const underRoot = (root, p) => (String(p ?? '').startsWith('/') ? p : `${root}/${p}`);

async function chatRound(client, messages, opts, abortRef, chatOptions = {}) {
  const tried = new Set([client.model]);
  let skips = 0;

  for(;;) {
    try {
      return await chatRoundOnce(client, messages, opts, abortRef, chatOptions);
    } catch(e) {
      /* nothing can serve the request on this route: skip the spent model(s), switch to the next ready one, retry */
      const text = `${e.message ?? ''}\n${e.detail ?? ''}\n${e.body ?? ''}`;
      if(autoSkipHook && skips < AUTO_SKIPS && !opts.quiet && client === autoSkipHook.client() && isExhaustedError(text)) {
        const from = client.model;
        skips++;
        if(await autoSkipHook.skip(text) && client.model !== from) continue;
      }

      /* a gateway model that fails with a limit or an outage: the warm standby takes the turn */
      if(!failoverHook && standbyHook && standbyReady() && isTransient(e) && !tried.has(standby.id) && client === standbyHook.client()) {
        const to = standby.id;
        tried.add(to);
        if(!opts.quiet) console.log(waveNote(`${client.model} failed (${String(e.detail ?? e.message).split('\n')[0].slice(0, 80)}), the standby ${to} takes over`));
        standbyHook.switchTo(to);
        continue;
      }
      /* a pinned site fails over here; auto is routed by the bridge, and when that ran out nothing is left to pick */
      if(!failoverHook || !Failover.applies(e) || /^auto(:|$)/.test(client.model) || isExhaustedError(text)) throw e;

      const to = await failoverHook.failover.next(tried);
      if(!to) throw e;

      /* the refusal came back before any reply text, so nothing was
         printed for this attempt: switch and ask the same question again */
      if(!opts.quiet) console.log(dim(failoverNote(e, client.model, to)));
      tried.add(to);
      /* the next site starts from nothing: send it a compacted conversation, not all of it */
      if(failoverHook.handoff && !opts.noHandoff) await failoverHook.handoff(messages, opts);
      failoverHook.onSwitch(to);
    }
  }
}

async function chatRoundOnce(client, messages, opts, abortRef, chatOptions = {}) {
  //console.log('chatRound');
  const t0 = Date.now();
  const stopSpinner = piped || opts.quiet ? () => {} : startSpinner();
  /* closing line of a round: time, and with a gateway's metadata where it went and the tokens */
  const cogitated = result => opts.quiet || console.log(dim(`${doneQuip((Date.now() - t0) / 1000)}${result?.meta ? ` - ${routeLine(result.meta)}` : ''}`) + '\n');

  abortRef.current = () => client.abort();

  /* in the TUI the verbose panels are always written, tagged: the verbose view shows the ones of the past, too */
  const panes = !!tui?.active && !opts.quiet;
  const verbose = (ui.verbose || panes) && !opts.quiet;

  /* TUI verbose: what goes out, the messages new since the last request */
  if(panes) {
    const from = shownMessages.get(messages) ?? 0;
    shownMessages.set(messages, messages.length);
    showPanel(`→ ${client.model} · ${messages.length} messages, ${fmtNum(totalChars(messages))} chars, ${chatOptions.tools?.length ?? 0} tools${from ? `, ${messages.length - from} new` : ''}`, messagesText(messages.slice(from)) || '(nothing new)', { border: '#c084fc', kind: 1 });
  } else if(verbose) console.log(dim(`-> ${client.model}: ${messages.length} messages, ${fmtNum(totalChars(messages))} chars, ${chatOptions.tools?.length ?? 0} tools${opts.stream ? ', streamed' : ''}${chatOptions.toolChoice ? `, tool_choice ${chatOptions.toolChoice}` : ''}`));

  /* verbose: reasoning text as it streams, dim, before the reply */
  let thinking = false;
  let reasoning = '';

  /* TUI verbose: the reasoning as one panel, before the reply */
  const showReasoning = () => {
    if(reasoning) showPanel('◌ reasoning', `\x1b[2;3m${reasoning.trim()}\x1b[0m`, { border: '#64748b', kind: 1 });
    reasoning = '';
  };

  if(panes && opts.stream) chatOptions = { ...chatOptions, onReasoning: text => void (reasoning += text) };
  else if(verbose && opts.stream)
    chatOptions = {
      ...chatOptions,
      onReasoning: text => {
        if(!thinking) {
          if(!tui?.active) stopSpinner();
          stdout.puts(dim('\nthinking: '));
          thinking = true;
        }

        stdout.puts(dim(text));
        stdout.flush();
      },
    };

  /* verbose: what came back, with every gateway header */
  const response = result => {
    const m = result?.meta;
    if(!verbose || !m) return;
    if(panes) return showPanel(`← ${m.status ?? '-'} ${routeName(m)}${m.provider ? ` via ${m.provider}` : ''} · ${fmtMs(m.ms)}`, colorMeta(formatMeta({ ...m, reasoning: result.reasoning })), { border: '#c084fc', kind: 1 });
    console.log(dim([`<- ${m.status ?? '-'} ${routeName(m)}${m.provider ? ` (${m.provider})` : ''} ${fmtMs(m.ms)}, finish ${m.finish ?? '-'}${m.usage ? `, ${m.usage.prompt}+${m.usage.completion} tok` : ''}`, ...Object.entries(m.headers ?? {}).map(([k, v]) => `   ${k}: ${v}`)].join('\n')));
  };

  // `finally` (not just the explicit stopSpinner() calls below, which only
  // cover the success path) - client.chat()/chatStream() throwing (a
  // timeout, a dropped connection, ...) must never leave the spinner's
  // timer running; stopSpinner() is idempotent, so this is a harmless
  // no-op on top of an already-stopped spinner.
  try {
    if(opts.stream) {
      let first = true;
      const md = piped ? null : new MarkdownStream();

      const result = await client.chatStream(messages, chatOptions, token => {
        if(first) {
          if(panes) showReasoning();
          if(!tui?.active) stopSpinner(); // in the TUI it runs on in its own row until the round is done
          if(thinking) stdout.puts('\n');
          stdout.puts(`\n${piped ? `${opts.label ?? opts.provider}> ` : replyMark()}`);
          first = false;
        }

        stdout.puts(md ? md.push(token) : token);
        stdout.flush();
      });

      if(md && !first) stdout.puts(md.end());

      if(first) stopSpinner(); // no text token ever arrived to stop it (empty or tool-only reply)
      if(panes) showReasoning();

      if(!first) {
        stdout.puts('\n\n');
        stdout.flush();
      }

      response(result);
      cogitated(result);
      return result;
    }

    const result = await client.chat(messages, chatOptions);
    stopSpinner();
    if(panes) {
      reasoning = result.reasoning ?? '';
      showReasoning();
    } else if(verbose && result.reasoning) console.log(dim(`\nthinking: ${result.reasoning}`));
    if(result.content && !opts.quiet) console.log(`\n${piped ? `${opts.label ?? opts.provider}> ` : replyMark()}${piped ? result.content : new MarkdownStream().push(result.content + '\n')}\n`);
    response(result);
    cogitated(result);
    return result;
  } finally {
    abortRef.current = null;
    stopSpinner();
  }
}

/* Keeps the conversation inside the context window: old tool results (file
   reads, grep output) are what grows it, and the model has already acted on
   them - once the history outgrows ~2.5 chars/token of `numCtx` minus room
   for the tool schemas and the reply, the oldest results are replaced by a
   one-line stub, oldest first, until it fits again. */
function elideOldToolResults(messages, numCtx) {
  const budget = numCtx * 2.5 - 8000;
  let total = totalChars(messages);

  for(const m of messages) {
    if(total <= budget) return;
    if(m.role !== 'tool' || m.content.length < 200) continue;

    const stub = `(output elided to save context: ${m.content.length} chars - run the tool again if needed)`;
    total -= m.content.length - stub.length;
    m.content = stub;
  }
}

/* the running harness (script as a realpath, directory, whether that is the source tree: smoke.sh sits next to it,
   the installed copy in bin/ has none), and its `target`: the source tree edits and restarts are about. That is
   the running one when it is a source tree, else the examples/ollama-repl found at or above the project root
   (the installed copy is run from a checkout to work on it). `snap` is the startup snapshot. */
const harness = { script: '', dir: '', source: false, target: null, snap: null, snapDir: null };

const isSourceTree = dir => stat(`${dir}/smoke.sh`)[1] === 0 && stat(`${dir}/repl.js`)[1] === 0 && stat(`${dir}/lib`)[1] === 0;

/** the source tree of the harness at or above `root`, or null */
function findSourceTree(root) {
  for(let dir = realpath(root)[0] ?? root; dir; dir = dir.replace(/\/[^/]*$/, '')) {
    if(isSourceTree(dir)) return dir;
    if(isSourceTree(`${dir}/examples/ollama-repl`)) return `${dir}/examples/ollama-repl`;
    if(!dir.includes('/', 1)) break;
  }

  return null;
}

function initHarness(root) {
  harness.script = realpath(scriptArgs[0])[0] ?? scriptArgs[0];
  harness.dir = harness.script.replace(/\/[^/]*$/, '') || '.';
  harness.source = isSourceTree(harness.dir);
  retargetHarness(root);
}

/** also called after /cd: the tree the edits and restarts concern */
function retargetHarness(root) {
  harness.target = harness.source ? harness.dir : findSourceTree(root);
}

/**
 * Copies what runs (source: repl.js, ctl.js and lib/ next to .ollama-repl-snap-PID beside the harness
 * directory, the same depth so lib/'s ../../../lib/lws imports still resolve; installed: the script and its
 * lib/ into the control directory) as the version a restart falls back to when the edited one dies at
 * startup. Snapshots of dead processes are removed.
 */
function snapshotHarness() {
  purgeSnapshots();

  const snap = harness.source ? `${harness.dir.replace(/\/[^/]*$/, '') || '.'}/.ollama-repl-snap-${getpid()}` : `${controlDir()}/snap-${getpid()}`;
  const files = harness.source ? `'${harness.dir}/repl.js' '${harness.dir}/ctl.js' '${harness.dir}/lib'` : `'${harness.script}' '${harness.dir}/lib'`;
  const pipe = popen(`mkdir -p '${snap}' && cp -r ${files} '${snap}/' 2>&1`, 'r');
  if(!pipe) return;
  pipe.readAsString();

  if(pipe.close() === 0) {
    harness.snapDir = snap;
    harness.snap = `${snap}/${harness.source ? 'repl.js' : harness.script.replace(/^.*\//, '')}`;
  }
}

/** removes the snapshots of processes that are gone (a crash does not clean up) */
function purgeSnapshots() {
  for(const [dir, re] of [
    [harness.dir.replace(/\/[^/]*$/, '') || '.', /^\.ollama-repl-snap-(\d+)$/],
    [controlDir(), /^snap-(\d+)$/],
  ]) {
    const [names] = readdir(dir);

    for(const n of names ?? []) {
      const pid = +(re.exec(n)?.[1] ?? 0);
      if(pid && pid !== getpid() && kill(pid, 0) !== 0) rmSync(`${dir}/${n}`, { recursive: true, force: true });
    }
  }
}

function removeSnapshot() {
  if(harness.snapDir) rmSync(harness.snapDir, { recursive: true, force: true });
  harness.snap = harness.snapDir = null;
}

/** an absolute path without . and .. segments (the file need not exist) */
function normalizePath(path) {
  const out = [];
  for(const part of path.split('/')) if(part === '..') out.pop(); else if(part && part !== '.') out.push(part);
  return `/${out.join('/')}`;
}

/** whether a write tool call would change a file of the running harness (only when it runs from source) */
function touchesHarness(root, args) {
  if(!harness.target || typeof args?.path !== 'string') return false;

  const full = normalizePath(args.path.startsWith('/') ? args.path : `${realpath(root)[0] ?? root}/${args.path}`);
  return full === harness.target || full.startsWith(`${harness.target}/`);
}

/** whether the project the model works in contains the harness (it is then told how to restart it safely) */
function editsHarness(root) {
  if(!harness.target) return false;

  const r = realpath(root)[0] ?? root;
  return harness.target === r || harness.target.startsWith(`${r}/`) || r.startsWith(`${harness.target}/`);
}

const SELF_NOTES = () => `

The program that runs you is part of this project: ${harness.target}. Changes to it take effect only after a restart. After editing it, run \`sh ${harness.target}/smoke.sh\` (it must end with "smoke ok") and fix what it reports, then call restart_harness. A restart is refused when that check fails, so a broken edit never costs the session. Change it with edit_file or insert_above in small steps; a write_file that truncates a file breaks the next start.`;

/* how a freellmapi gateway reads the `model` of a request (server/src/services/router.ts, resolveRoutingChain):
   auto = its active fallback chain, auto:AXIS = every enabled model sorted by one axis, auto:NAME = a named
   profile (chain), anything else = that one model, pinned */
const ROUTE_AXES = [
  ['smart', 'most capable first (intelligence)'],
  ['fast', 'fastest first (latency, tokens/s)'],
  ['cheap', 'budget-leaning, all of it is free tier anyway'],
  ['reliable', 'models that fail least first'],
  ['balanced', 'a blend of all axes'],
];

/** `/route` argument -> the model string sent: smart -> auto:smart, auto -> auto, profile NAME -> auto:NAME */
function routeTarget(arg) {
  const a = arg.trim();
  if(a === 'auto' || a === 'fusion') return a;
  if(ROUTE_AXES.some(([name]) => name === a)) return `auto:${a}`;
  if(a.startsWith('profile ')) return `auto:${a.slice(8).trim()}`;
  return a;
}

/** QUICKJS notes and, when the harness itself is in the project, how to change it safely */
/* the memory of which sub-agent models did well (lib/delegates.js), and whether the primary is told it may delegate */
const delegates = new Delegates();
let delegateNotesOn = false;
let statsRef = null; /* main()'s stats, for the helpers outside it */
let lastDelegate = null; /* { id, kind } of the newest delegated run, for /delegate good|bad */
let delegateCache = { at: 0, ids: [] };

const systemNotes = root => (isQuickJsProject(root) ? QJS_NOTES : '') + (editsHarness(root) ? SELF_NOTES() : '') + (delegateNotesOn && delegates.enabled ? DELEGATE_NOTES : '');

/** the memory's key of a model: the provider keeps a gateway's name apart from an Ollama one */
const delegateKey = (opts, id) => `${opts.label ?? opts.provider}:${id}`;

/** models that may take a delegated job, best discovered first (cached 10 minutes): the gateway's reliable and fast ones, or the installed Ollama models that are no stronger than the primary */
async function delegateCandidates(opts) {
  if(Date.now() - delegateCache.at < STANDBY_TTL_MS && delegateCache.provider === opts.provider) return delegateCache.ids;

  let ids = [];
  const exclude = [opts.model, statsRef?.last()?.routedVia, statsRef?.last()?.model].filter(Boolean);

  try {
    if(opts.provider === 'openai' && gatewayRef?.enabled) {
      if(gatewayRef.hasLimits) availability = await loadAvailability(gatewayRef).catch(() => availability);
      ids = await discoverGateway(gatewayRef, gatewayRef.hasLimits ? availability : null, { exclude });
    } else if(opts.provider === 'ollama') {
      const mine = modelStrength(opts.model).tier;
      ids = (ollamaModels() ?? []).filter(m => m !== opts.model && !/embed/i.test(m) && modelStrength(m).tier >= mine);
    }
  } catch(e) {}

  delegateCache = { at: Date.now(), provider: opts.provider, ids };
  return ids;
}

/**
 * Prepares a restart: validates the harness (`qjsm SCRIPT --help`), writes
 * the session state to a temp file and builds the command line of the new
 * process - the arguments this one was started with (minus an earlier
 * --resume, and --model when the provider changes) plus `overrides`
 * (e.g. { provider: 'gemini' }) and --resume FILE.
 *
 * @returns {Promise<string | { argv: string[] }>} an error message, or the argv for qjsm
 */
/** the prompts waiting in the queue (main() points this at the REPL), kept across a restart */
let queuedPrompts = () => [];

async function prepareRestart(opts, messages, baseMessageCount, overrides = {}) {
  /* the source tree (running, or found next to the project when the installed copy runs): the real check, the
     REPL starts and runs commands (smoke.sh); with no source tree the running script only has to load */
  const script = harness.target ? `${harness.target}/repl.js` : harness.script;
  const check = harness.target ? `sh '${harness.target}/smoke.sh' '${script}'` : `qjsm '${script}' --help`;
  const { output, status } = await runCommand(check, { cwd: opts.root, timeout: harness.target ? 180000 : 10000 });
  if(status !== 0) return `error: the harness failed its check (${harness.target ? 'smoke.sh' : '--help'}), so it was not restarted and this session is unchanged:\n${output}`;

  const tempPath = `${getenv('TMPDIR') || '/tmp'}/ollama-repl-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const now = Date.now();
  const skipped = [];
  for(const [name, info] of skippedModels) if(info.until > now) skipped.push({ name, until: info.until, reason: info.reason });

  /* the original command line decides provider, endpoint and options again;
     the state only carries what changed while running */
  const providerChange = overrides.provider !== undefined;
  const state = {
    messages,
    model: providerChange ? undefined : opts.model,
    fallbackModel: opts.fallbackModel,
    root: opts.root,
    mode: opts.mode,
    temperature: opts.temperature,
    numCtx: opts.numCtx,
    maxRounds: opts.maxRounds,
    stream: opts.stream,
    think: opts.think,
    noSystem: opts.noSystem,
    noTools: opts.noTools,
    noFailover: opts.noFailover,
    noHandoff: opts.noHandoff,
    handoffTurns: opts.handoffTurns,
    handoffModel: opts.handoffModel,
    scan: opts.scan,
    allowPaid: opts.allowPaid,
    cdpHost: opts.cdpHost,
    cdpPort: opts.cdpPort,
    baseMessageCount,
    sessionName: opts.name,
    sessionId: opts.sessionId,
    skippedModels: skipped,
    queue: queuedPrompts(),
  };

  const f = fopen(tempPath, 'w');
  if(!f) return `error: cannot write temp file ${tempPath}`;
  f.puts(JSON.stringify(state, null, 2));
  f.close();

  /* the new process deletes its --resume file once it has loaded it; this copy is for the fallback */
  const backup = `${tempPath}.bak`;
  const g = fopen(backup, 'w');
  g?.puts(JSON.stringify(state, null, 2));
  g?.close();

  const args = [];
  const given = scriptArgs.slice(1);
  for(let i = 0; i < given.length; i++) {
    if(given[i] === '--resume' || (providerChange && (given[i] === '--model' || given[i] === '--provider'))) i++;
    else args.push(given[i]);
  }
  if(providerChange) args.push('--provider', overrides.provider);
  const rest = args.slice();
  args.push('--resume', tempPath);

  return {
    argv: ['qjsm', script, ...args],
    moved: script !== harness.script ? script : null,
    /* the startup snapshot, resuming from the backup: when the edited harness dies right away */
    fallback: harness.snap ? ['qjsm', `${harness.snap}/repl.js`, ...rest, '--resume', backup] : null,
    backup,
  };
}

/* set by main(): ends this process and runs the restarted one in its place;
   resolves only with an error message (success never returns) */
let restartHook = null;
let restarting = false;

/**
 * Spawns a sub-agent with isolated conversation history.
 * Returns the sub-agent's final summary.
 */
async function spawnAgent(parentClient, parentMessages, opts, log, confirmRun, askUser, abortRef, forEach, args) {
  const { task, max_turns = 10, read_only = false } = args;
  const kind = KINDS.includes(args.kind) ? args.kind : 'other';
  /* "standby" names the warm standby model, when there is one */
  let subModel = args.model === 'standby' ? (standbyReady() ? standby.id : undefined) : args.model;
  let chosen = null;

  let peer = null;

  /* no model named: the one that worked best for this kind of job, among the discovered and the set ones;
     workers (other ollama-repl instances, maybe on another provider) come first in the order of discovery */
  if((!subModel || subModel === 'auto') && delegates.enabled && delegateNotesOn) {
    const prefix = delegateKey(opts, '');
    const peers = findPeers({ root: opts.root, selfPid: getpid() }).filter(p => !p.busy);
    const ranked = delegates.rank(kind, [...peers.map(p => `peer:${p.name}`), ...(await delegateCandidates(opts)).map(id => delegateKey(opts, id))]).filter(r => r.id.startsWith(prefix) || r.id.startsWith('peer:'));
    const best = ranked[0]?.id;

    if(best?.startsWith('peer:')) peer = peers.find(p => `peer:${p.name}` === best) ?? null;
    else subModel = best?.slice(prefix.length);
    if(subModel && subModel !== opts.model) chosen = delegateKey(opts, subModel);
  } else if(typeof subModel === 'string' && subModel.startsWith('peer:')) {
    peer = findPeers({ root: opts.root, selfPid: getpid(), all: true }).find(p => `peer:${p.name}` === subModel);
    if(!peer) return `Sub-agent failed: no ollama-repl session "${subModel.slice(5)}" listens on this project (ollama-repl-ctl list)`;
  } else if(subModel && subModel !== opts.model) chosen = delegateKey(opts, subModel);
  if(subModel === 'auto') subModel = undefined;
  const t0 = Date.now();

  /* another ollama-repl instance does the job: its own provider, model and tools, isolated by /reset when it is a worker */
  if(peer) {
    const id = `peer:${peer.name}`;
    if(tui?.active) setPhase('sub-agent', { tool: `spawn_agent via ${peer.name}: ${task.slice(0, 40)}` });

    try {
      const pre = [...(peer.worker ? ['/reset'] : []), ...(read_only && peer.mode !== 'plan' ? ['/mode plan'] : [])];
      const line = `[task delegated by ollama-repl ${opts.name ?? 'primary'}: do it yourself, never delegate it further, finish with a short summary of what you did and changed] ${read_only ? '(read-only: change nothing) ' : ''}${task}`;
      const r = await askPeer(peer, pre, line, { timeoutMs: (max_turns * 90 + 120) * 1000 });
      if(read_only && peer.mode !== 'plan') await askPeer(peer, [], `/mode ${peer.mode}`, { timeoutMs: 20000 });

      /* the peer waiting for its user, or busy: not the model's fault, nothing is remembered */
      if(r.waiting || r.busy) return `Sub-agent not run (${peer.name}): ${r.error}. Do the task yourself or use another model.`;

      const answer = peerAnswer(r.text);
      const ok = r.ok && answer.length > 0;
      delegates.record(id, kind, { ok, ms: Date.now() - t0 });
      lastDelegate = { id, kind };
      if(!ok) return `Sub-agent failed (${peer.name}): ${r.error ?? 'empty answer'}`;
      return `Sub-agent (${peer.name}: ${peer.provider}/${peer.model}, ${kind}, ${((Date.now() - t0) / 1000).toFixed(0)}s) completed task "${task}":\n\n${answer}\n\n(Another instance did this, possibly a weaker model: check it before relying on it.)`;
    } finally {
      if(tui?.active) setPhase('idle');
    }
  }
  
  // Create a new client for the sub-agent (or reuse parent if same model)
  let subClient = parentClient;
  let originalModel = opts.model;
  
  if(subModel && subModel !== opts.model) {
    // Need to create a new client with the specified model
    const subOpts = { ...opts, model: subModel };
    if(opts.provider === 'gemini') subClient = new (await import('./lib/gemini-client.js')).GeminiClient(subOpts);
    else if(opts.provider === 'openai') subClient = new (await import('./lib/openai-client.js')).OpenAIClient(subOpts);
    else subClient = new (await import('./lib/ollama-client.js')).OllamaClient(subOpts);
  }

  // Build isolated messages for sub-agent
  const systemPrompt = parentMessages[0]?.role === 'system' ? parentMessages[0].content : SYSTEM_PROMPT + systemNotes(opts.root);
  
  const subMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `You are a sub-agent handling this task: ${task}\n\n${read_only ? 'You are in READ-ONLY mode. You may only use inspection tools (list_directory, read_file, grep). Do not make any changes.' : 'You have full access to all tools. Complete the task and provide a summary.'}` }
  ];

  // Filter tools if read_only
  const subOpts = { 
    ...opts, 
    maxRounds: max_turns,
    /* a sub-agent never spawns agents or restarts the harness itself */
    omitTools: ['spawn_agent', 'restart_harness', ...(read_only ? ['edit_file', 'write_file', 'insert_above', 'run_command', 'for_each', 'ask_user'] : [])]
  };

  // Update status to show sub-agent activity
  if(tui?.active) setPhase('sub-agent', { tool: `spawn_agent: ${task.slice(0, 50)}` });

  try {
    const reply = await runToolLoop(subClient, subMessages, subOpts, log, confirmRun, askUser, abortRef, forEach);
    /* a model that finished and said something did its job; whether the work was good is for the user's /delegate good|bad */
    if(chosen) {
      delegates.record(chosen, kind, { ok: String(reply ?? '').trim().length > 0, ms: Date.now() - t0 });
      lastDelegate = { id: chosen, kind };
    }
    return `Sub-agent (${subModel ?? opts.model}, ${kind}, ${((Date.now() - t0) / 1000).toFixed(0)}s) completed task "${task}":\n\n${reply}${chosen ? '\n\n(A weaker model did this: check it before relying on it.)' : ''}`;
  } catch(e) {
    if(chosen) {
      delegates.record(chosen, kind, { ok: false, ms: Date.now() - t0 });
      lastDelegate = { id: chosen, kind };
    }
    return `Sub-agent failed (${subModel ?? opts.model}): ${e.message}`;
  } finally {
    // Restore original model if we switched
    if(subClient !== parentClient) {
      subClient.destroy();
    }
    if(tui?.active) setPhase('idle');
  }
}

/* tools whose repeat is never short-circuited by the duplicate-call guard: they act on the session */
const NEVER_CACHED = new Set(['restart_harness', 'spawn_agent']);

/* rounds made only of already-seen tool calls before tools are withdrawn */
const MAX_REPEAT_ROUNDS = 2;

/**
 * Drives the tool-calling loop (see SYSTEM_PROMPT/TOOLS): runs one
 * chat round with TOOLS (lib/tool-requests.js) offered, and if the reply
 * asks for one or more tool calls, executes each one (executeTool()) and
 * feeds its result back as a `tool`-role message, then repeats - up to
 * MAX_TOOL_ROUNDS - until a reply with no tool calls (or the round cap) is
 * reached. On the capping round, `tools` is omitted and `toolChoice:
 * 'none'` passed instead, forcing a real text answer rather than silently
 * dropping a request the model still wanted to make. `messages` is mutated
 * in place (a user turn, then one assistant turn - and any `tool` turns -
 * per round); callers that want to roll back an aborted turn should
 * snapshot `messages.length` before calling this.
 *
 * @returns {Promise<string>} the final reply shown to the user
 */
async function runToolLoop(client, messages, opts, log, confirmRun, askUser, abortRef, forEach) {
  if(opts.noTools) {
    /* chat-only model: one plain round, the reply carries File: blocks */
    const result = await chatRound(client, messages, opts, abortRef, {});
    messages.push({ role: 'assistant', content: result.content });
    log.reply(result.content);
    return result.content;
  }

  const tools = (forEach ? TOOLS : TOOLS.filter(t => t.name !== 'for_each' && t.name !== 'ask_user')).filter(t => !opts.omitTools?.includes(t.name) && toolAllowed(opts.mode, t.name));

  let nudges = 0;
  /* loop guard: calls already made this turn (name+args -> times seen) and
     how many rounds in a row consisted only of repeats */
  const seenCalls = new Map();
  /* cache of tool call results (sig -> { output, round }) for returning on duplicates */
  const toolCache = new Map();
  let repeatRounds = 0;
  const writesAtStart = writeCount; // this loop's own changes, not an earlier item's

  for(let round = 0; ; round++) {
    const final = round >= opts.maxRounds - 1 || repeatRounds >= MAX_REPEAT_ROUNDS;
    await compactHook?.(messages);
    elideOldToolResults(messages, ctxWindowNow ?? opts.numCtx);
    const result = await chatRound(client, messages, opts, abortRef, final ? { toolChoice: 'none' } : { tools });

    /* models that write the call as text (qwen2.5-coder) - see lib/text-tool-calls.js */
    if(!result.toolCalls?.length && !final) {
      const text = extractTextToolCalls(result.content, tools);
      if(text.toolCalls) Object.assign(result, text);
    }

    messages.push({ role: 'assistant', content: result.content, ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}) });
    log.reply(result.content);

    if(!result.toolCalls?.length) {
      /* A change was asked for, but the model answered in prose (typically by
         printing the "updated" file) without touching anything - qwen2.5-coder
         does this. Send it back to work, twice at most. */
      if(!final && opts.mode !== 'plan' && nudges < 2 && writeCount === writesAtStart && asksForChange(messages)) {
        nudges++;
        if(!opts.quiet) console.log(dim(`(nudge: ${NUDGE})`));
        messages.push({ role: 'user', content: NUDGE });
        continue;
      }

      return result.content;
    }

    if(!opts.quiet && !tui?.active) console.log(dim(result.toolCalls.map(tc => `(${tc.name} ${JSON.stringify(tc.args).slice(0, 160)})`).join('\n')));

    let repeats = 0;

    for(const tc of result.toolCalls) {
      const sig = tc.name + JSON.stringify(tc.args);
      const seen = seenCalls.get(sig) ?? 0;
      seenCalls.set(sig, seen + 1);

      if(seen > 0 && !NEVER_CACHED.has(tc.name)) {
        repeats++;
        const cached = toolCache.get(sig);
        const output = cached
          ? `(cached result from earlier ${tc.name} call): ${cached.output}`
          : `error: you already made this exact ${tc.name} call (${seen}x) - repeating it will not change the result. Try a different approach (different arguments, read_file to re-check the current contents first) or stop and explain what is blocking you.`;
        if(!opts.quiet) console.log(dim(`(repeated ${tc.name} call - ${cached ? 'returned cached result' : 'skipped'})`));
        log.toolResults(`${tc.name}(${JSON.stringify(tc.args)})\n${output}`);
        messages.push({ role: 'tool', name: tc.name, toolCallId: tc.id, content: output });
        continue;
      }

      let output;
      const selfEdit = WRITE_TOOLS.has(tc.name) && !opts.selfEdit && opts.mode !== 'plan' && touchesHarness(opts.root, tc.args);
      const asked = needsApproval(opts.mode, tc.name) || selfEdit;

      if(tui?.active && !opts.quiet) {
        showPanel(`⚙ ${tc.name}`, colorArgs(tc.args), { border: '#c084fc', kind: 1 });
        inKind(2, () => console.log(toolLine(tc.name, tc.args ?? {})));
      }

      /* Handle special tools that need access to repl.js context */
      if(tc.name === 'restart_harness') {
        output = (await restartHook?.()) ?? 'error: restart is not available here';
        toolCache.set(sig, { output, round });
        // a successful restart exits the process, only an error gets here
        messages.push({ role: 'tool', name: tc.name, toolCallId: tc.id, content: output });
        continue;
      }

      if(tc.name === 'spawn_agent') {
        setPhase('tool', { tool: tc.name });
        const stop = tui?.active && !opts.quiet ? tuiSpinner(`spawning agent for: ${tc.args.task.slice(0, 60)}`) : () => {};
        try {
          output = await spawnAgent(client, messages, opts, log, confirmRun, askUser, abortRef, forEach, tc.args);
          toolCache.set(sig, { output, round });
        } finally {
          stop();
          setPhase('idle');
        }
        messages.push({ role: 'tool', name: tc.name, toolCallId: tc.id, content: output });
        continue;
      }

      /* the mode may have changed since the tools were offered (Shift-Tab mid-turn) */
      if(!toolAllowed(opts.mode, tc.name)) output = `error: ${tc.name} is not available in ${opts.mode} mode - only read the code and answer with a plan`;
      else if(selfEdit && !(await approveSelf?.(describeWrite(tc.name, tc.args ?? {}), tc.name, tc.args ?? {}))) output = '(declined by the user - nothing was changed)';
      else if(!selfEdit && needsApproval(opts.mode, tc.name) && tc.name !== 'run_command' && !(await approveWrite?.(describeWrite(tc.name, tc.args ?? {}), tc.name, tc.args ?? {}))) output = '(declined by the user - nothing was changed)';
      else {
        setPhase('tool', { tool: tc.name });
        const stop = tui?.active && !opts.quiet ? tuiSpinner(`running ${tc.name}`) : () => {};
        try {
          output = await executeTool(tc.name, tc.args, opts.root, confirmRun, askUser, forEach);
          // cache the result for duplicate detection
          toolCache.set(sig, { output, round });
        } finally {
          stop();
          setPhase('idle');
        }
      }

      /* an edit or a command may have changed what earlier reads and runs returned: the same call is a new call again
         (edit, run smoke.sh, edit, run smoke.sh) - only an immediate repeat of the command itself is still caught */
      if((WRITE_TOOLS.has(tc.name) && !/^(error|\(declined)/.test(output ?? '')) || tc.name === 'run_command') {
        seenCalls.clear();
        toolCache.clear();
        if(tc.name === 'run_command') {
          seenCalls.set(sig, 1);
          toolCache.set(sig, { output, round });
        }
      }

      if(WRITE_TOOLS.has(tc.name) && !/^(error|\(declined)/.test(output ?? '')) {
        changes.push({ title: `${tc.name} ${tc.args?.path ?? ''}`, diff: numberedDiff(tc.name, tc.args ?? {}, loadFile(underRoot(opts.root, tc.args?.path)), true), at: Date.now() });
        if(split.mode === 'diff') tui?.drawPane();
      }

      /* TUI: a file change as a numbered diff, anything else as one summary line */
      if(tui?.active && !opts.quiet) {
        if(WRITE_TOOLS.has(tc.name) && !asked && !/^(error|\(declined)/.test(output)) showPanel(`✔ ${tc.name} ${tc.args?.path ?? ''}`, numberedDiff(tc.name, tc.args ?? {}, loadFile(underRoot(opts.root, tc.args?.path)), true), { border: '#4ade80', kind: 2 });
        else inKind(2, () => console.log(toolResult(output)));
      }

      if(!opts.quiet && tui?.active) showPanel(`⎿ ${tc.name} result · ${output.split('\n').length} lines, ${output.length} chars`, output ? colorContent(output, { code: tc.name === 'read_file' }) : '(empty)', { border: /^error/.test(output) ? '#f87171' : '#c084fc', kind: 1 });
      else if(ui.verbose && !opts.quiet) {
        const lines = output.split('\n');
        const shown = lines.slice(0, 200).join('\n');
        console.log(dim(`[${tc.name} result, ${output.length} chars]`));
        console.log(piped ? shown : colorContent(shown, { code: tc.name === 'read_file' }));
        if(lines.length > 200) console.log(dim(`... (${lines.length - 200} more lines)`));
      }
      log.toolResults(`${tc.name}(${JSON.stringify(tc.args)})\n${output}`);
      messages.push({ role: 'tool', name: tc.name, toolCallId: tc.id, content: output });
    }

    repeatRounds = repeats === result.toolCalls.length ? repeatRounds + 1 : 0;
  }
}

/**
 * Top-level (first path segment) names under `root` that .gitignore would
 * exclude, via `git ls-files --others --ignored --exclude-standard
 * --directory` - reused so gatherProjectContext()'s layout listing below
 * skips the same build/log/cache noise a git checkout already knows to
 * ignore (CMakeCache.txt, *.log, core dumps, ...) instead of guessing at
 * or hardcoding those patterns itself. Empty Set, not an error, for a
 * root that isn't a git repo at all.
 */
async function gitIgnoredTopLevel(root) {
  const { output, status } = await runCommand('git ls-files --others --ignored --exclude-standard --directory -- .', { cwd: root });
  if(status !== 0) return new Set();

  return new Set(
    output
      .split('\n')
      .filter(Boolean)
      .map(p => (p.indexOf('/') === -1 ? p : p.slice(0, p.indexOf('/')))),
  );
}

/**
 * Runs an automatic list + read of the project root's own layout - a
 * shallow, top-level-only directory listing, plus the root README.md and
 * CMakeLists.txt if the project has them (via executeTool(), the same
 * read_file the model itself calls) - seeded into `messages` once at
 * startup (see main()) so the model always starts a session already
 * knowing the project's shape, the same way Claude Code auto-reads
 * project context rather than waiting to be asked.
 *
 * Deliberately shallow: this used to run a full recursive listing (every
 * listable file in the whole tree, up to 300 entries) and read every
 * README* found anywhere under root, not just the top-level one - on this
 * project alone that came to a ~80KB first-turn payload before a single
 * word had been exchanged, which is what actually triggered
 * BUGS:tls-client-large-body-hangs-or-closes against a real API. A
 * top-level listing plus the project's own README/CMakeLists.txt is
 * enough to know the project's shape; anything deeper is exactly what the
 * tool-calling loop (runToolLoop() above) is for. Files are further
 * filtered to SOURCE_EXT (file-refs.js) - directories always stay (needed
 * to see the layout at all), but a top-level file with no source
 * extension (a cert, a lockfile, a build cache stray SKIP_DIRS/.gitignore
 * didn't already catch) is noise for "what does this project look like",
 * not signal.
 */
async function gatherProjectContext(root) {
  const [names] = readdir(root);
  const ignored = await gitIgnoredTopLevel(root);

  const layout = (names ?? [])
    .filter(name => name !== '.' && name !== '..' && !SKIP_DIRS.has(name) && !ignored.has(name))
    .map(name => ({ name, isDir: fileMode(root === '.' ? name : `${root}/${name}`) === S_IFDIR }))
    .filter(({ name, isDir }) => isDir || SOURCE_EXT.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase()))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, isDir }) => (isDir ? `${name}/` : name))
    .join('\n');

  /* Capped per file: a small model's context is precious, and the full
     text is one read_file away. */
  const reads = [];

  for(const [name, cap] of [['README.md', 3000], ['CLAUDE.md', 3000], ['AGENTS.md', 3000], ['CMakeLists.txt', 1500]]) {
    const text = loadFile(root === '.' ? name : `${root}/${name}`);
    if(text) reads.push(`${name}${text.length > cap ? ` (first ${cap} of ${text.length} chars)` : ''}\n${text.slice(0, cap)}`);
  }

  return `Project layout (top-level only):\n${layout || '(empty)'}${reads.length ? `\n\n${reads.join('\n\n')}` : ''}`;
}

/** One line per message: index, role, char count, and a truncated preview - the
    non-debug ("summary") view for /context and /log below. */
function summarizeMessages(msgs) {
  return msgs
    .map((m, i) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const preview = content.replaceAll('\n', ' ').slice(0, 80);
      return `[${i}] ${m.role} (${content.length} chars): ${preview}${content.length > 80 ? '...' : ''}`;
    })
    .join('\n');
}

/* A clean, plain-text full transcript of the conversation for /export -
   each message with its speaker label and any tool calls alongside, no
   clipping (unlike handoff's renderTranscript, which truncates for a
   context summary). */
function renderExport(msgs) {
  const out = [];

  for(const m of msgs) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    const calls = (m.toolCalls ?? []).map(tc => `  [called ${tc.name} ${JSON.stringify(tc.args ?? {})}]`);
    const label = m.role === 'user' ? 'You' : m.role === 'tool' ? `Tool${m.name ? ` (${m.name})` : ''}` : `${m.role[0].toUpperCase()}${m.role.slice(1)}`;
    out.push(`${label}: ${content}`);
    if(calls.length) out.push(calls.join('\n'));
  }

  return out.join('\n\n');
}

/** Total char count across `msgs` - a rough proxy for outgoing request
    size (see DEMO.md 5 on why this is a diagnostic, not a target), shown
    alongside the message count in /context. */
/** The first installed clipboard tool (`wl-copy`, `xclip`, `xsel`,
    `pbcopy`), or null if none - for /export's "Copy to clipboard". */
function pickClipboardTool() {
  for(const n of ['wl-copy', 'xclip', 'xsel', 'pbcopy']) {
    const probe = popen(`command -v ${n} 2>/dev/null`, 'r');
    const found = probe?.readAsString().trim();
    probe?.close();
    if(found) return n;
  }
  return null;
}

function totalChars(msgs) {
  return msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
}

const HELP_TEXT = `/reset          - clear conversation history (keeps the initial project scan)
/clear          - wipe conversation history completely, including the initial project scan
/cd DIR         - change the project directory (~, ~user, - for the previous one) the model works in (file refs, writes, run_command all follow it)
/exit, /quit    - quit
/help           - this text
/split [diff|git|status|off] - a pane right of the transcript: this session's file changes as diffs (default), git diff of the project, or the live status (what happens now, the request, sockets with their traffic, memory). /split alone toggles
/proxy [on|off|probe|exit] - the socks proxy the gateway sends upstream requests through: settings, latency it adds (probe measures direct vs proxied, 3 runs each), time to first byte per platform; on/off switches it for the gateway's upstream requests (the URL stays saved); exit asks for a new exit (tor-change-exitnode.sh) and measures again
/view [N]       - panel N (the last one) full-screen in a pager: arrows, PgUp/PgDn, Home/End, mouse wheel, q back
/mouse [on|off] - the mouse wheel scrolls the transcript (on, the default: select text with Shift-drag) or the terminal handles the mouse (off)
/about          - the session panel shown at startup: version, model, endpoint, gateway, mode, root, log
/run <command>  - run a shell command yourself, right now (no model round trip, no approval prompt - it's you asking, not the model)
/undo           - restore every file the model changed during the last prompt
/diff           - git diff of the project (what has been changed so far)
/each <cmd> :: <task> - run <task> once per output line of <cmd> ({} = the item), each in a fresh conversation
/binding <text> - force-attach the native-binding reference (fib.c/point.c/cheat sheet) for this prompt, even if it doesn't sound like a binding request
/mode [NAME]    - show or set the mode: ${MODES.map(m => `${m} (${MODE_INFO[m]})`).join(', ')}. Shift-Tab or Alt-Tab cycles it
/verbose [on|off] - show reasoning, full tool results, every request and response with all gateway headers (Ctrl-O toggles)
/remote-control [PATH|off] - open the control socket now (like --listen), so ollama-repl-ctl or Claude Code can type into this session; off closes it
/queue [list|clear|drop N] - the prompts waiting behind the running request (Enter queues one while the model works, Ctrl-X Ctrl-S sends the typed one now and cancels the running request); the queue is saved with the session and runs again after a restart
/rename NAME    - rename the session (ollama-repl-ctl -s NAME picks it)
/model [NAME|list [all]|skip|unskip] - show provider/model/endpoint; list hides the models the endpoint calls unavailable (no key, disabled), list all shows them; switch model by #, name, or pattern; /model skip marks current as skipped (10m cooldown), /model unskip removes skip
/provider [NAME] - show or switch the provider (ollama, gemini, openai, freellm, bridge)
/fallback [NAME|off] - show or set fallback model for auto-failover
/route [list|smart|fast|cheap|reliable|balanced|auto|profile NAME|MODEL|new] - freellmapi routing: show what the gateway does with this session, pick a sort axis, a named chain or one pinned model; new restarts sticky routing
/compact [N]    - summarize the older turns now with a local model and keep the last N (default 3) verbatim; also done automatically at --compact-at percent of the context window
/standby [on|off|probe|switch|MODEL|auto] - the warm standby model: what the gateway would use next, probed with a tool call (--standby starts it on); switch takes it over, MODEL pins one, spawn_agent with model "standby" runs a sub-agent on it
/config [set KEY VALUE|unset KEY] - the global settings in ~/.config/ollama-repl/settings.json: defaults for options (provider, model, mode, compactAt, standby, ...), a command-line option wins; without arguments shows saved and current values
/skill [NAME [request]|off [NAME]|loaded] - load a skill (SKILL.md from ~/.config/ollama-repl/skills/ or ~/.claude/skills/) into the conversation, then answer the request if one follows; without arguments lists the skills; off unloads one (or all)
/delegate [on|off|add MODEL [KIND..]|remove MODEL|pin KIND [MODEL]|ban MODEL|unban MODEL|good|bad|forget] - sub-agent delegation: the model is told it may hand docs, build wiring, summaries and repetitive jobs to weaker models; the harness discovers candidates (gateway or Ollama), picks per kind by what worked before and remembers it; good/bad rates the last delegated run
/restart        - restart the harness with current session state (serializes to temp file and re-execs)
/usage          - tokens and requests of this session, per routed model and platform
/last [N]       - everything known about the last request (or request #N of /requests): route, provider, request id, tokens, timings, fallbacks
/requests [N]   - the last N (10) requests of this session, one line each
/gateway [usage|providers|forecast|quota [FILTER]|limits [FILTER]|limited [FILTER]|models [FILTER]|login] - ask the freellmapi gateway: month usage of all clients, upstream health, provider quotas, per-model quotas (dashboard session), models ready now; limits shows tokens and requests used per minute/day/month and when each limit ends, limited lists the models that cannot serve a request now and when they are back (/model list shows them too, not selectable). login fetches the dashboard token from the browser (CDP, --cdp-port), opening a dashboard tab if needed
/tools          - list the tools the model can call
/system         - print the system prompt
/system default [N[-M]] - (re)set it to the default prompt, or only its lines N..M
/system <text>, /system +<text>, /system file <path>, /system off - replace, append, load from a file, or remove it
/stream [on|off] - show or set token streaming
/js <code>      - evaluate JavaScript in the REPL
/status         - show model/connection/session info
/files          - dump this session's file exchange (sent, received, diffs)
/context        - inspect the full context about to be sent to the model (system prompt + project scan + conversation) - raw, inspect()-colored, with -x; a one-line-per-message summary without it
/log            - inspect just the conversation so far (no system prompt/project scan) - same raw-with--x/summary-without split as /context
/export         - export the conversation: copy it to the clipboard or save it to a file (<YYYY-MM-DD-HHMMSS>-<session>.txt in the working directory)
Anything else is sent to the model as a prompt.`;

/** /help sections in the TUI: title, the commands under it (the rest go under "more") */
const HELP_SECTIONS = [
  ['conversation', ['/reset', '/clear', '/undo', '/each', '/binding', '/system', '/context', '/log', '/files']],
  ['project', ['/cd', '/run', '/diff']],
  ['model and gateway', ['/model', '/route', '/provider', '/fallback', '/compact', '/standby', '/delegate', '/config', '/skill', '/restart', '/stream', '/tools', '/usage', '/last', '/requests', '/gateway', '/proxy', '/status']],
  ['session', ['/mode', '/verbose', '/view', '/split', '/mouse', '/remote-control', '/queue', '/rename', '/about', '/js', '/help', '/exit', '/export']],
];

/** commands whose output the TUI shows as a panel (/js writes past std.out, /each and /binding talk to the model) */
const REPORT_COMMANDS = new Set(['/queue', '/mouse', '/proxy', '/reset', '/clear', '/undo', '/diff', '/cd', '/status', '/mode', '/verbose', '/remote-control', '/rename', '/model', '/provider', '/fallback', '/compact', '/route', '/standby', '/delegate', '/config', '/restart', '/usage', '/last', '/requests', '/gateway', '/tools', '/system', '/stream', '/files', '/context', '/log', '/run']);

const TIPS = ['Ask questions, edit files, or run commands. Name files or globs (src/*.js) to attach them.', 'Shift-Tab cycles the modes plan, auto, manual, edits. Ctrl-O shows everything the model gets and says.', '/help lists the commands, /about shows this panel again.'];

/** @returns {string[]|null} names `ollama list` shows, null if it cannot be run */
function ollamaModels() {
  const pipe = popen('ollama list', 'r');
  if(!pipe) return null;

  const out = pipe.readAsString();
  pipe.close();
  return out.split('\n').slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
}

/* Pattern-cycling state for /model: the last glob used, the model names it
   matched (in /model list order), and which one is selected, so repeating
   `/model qwen*` steps through every match. Reset on any non-glob switch. */
let modelCycle = null;

/* Skipped models: Map<modelName, { until: timestamp, reason: string }>
   Models in this map are excluded from auto-selection and marked in /model list. */
const skippedModels = new Map();
const SKIP_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/* Model strength tiers for sorting (strongest to weakest).
   Based on common model naming patterns - can be extended. */
const MODEL_STRENGTH_PATTERNS = [
  { pattern: /opus|gpt-4[o0]|claude-3-5-sonnet|gemini-1\.5-pro|gemini-2\.0/, tier: 0, label: 'Opus/GPT-4o+' },
  { pattern: /sonnet|gpt-4-turbo|claude-3-sonnet|gemini-1\.5-flash/, tier: 1, label: 'Sonnet/GPT-4T' },
  { pattern: /haiku|gpt-3\.5|gemini-1\.0|qwen-max|llama-3-70b/, tier: 2, label: 'Haiku/GPT-3.5' },
  { pattern: /qwen2\.5-72b|llama-3-8b|mistral-large|command-r\+/, tier: 3, label: '72B/Large' },
  { pattern: /qwen2\.5-32b|codestral|phi-3|gemma-2-27b/, tier: 4, label: '32B/Medium' },
  { pattern: /qwen2\.5-14b|llama-3\.1-8b|gemma-2-9b|phi-3-mini/, tier: 5, label: '14B/Small' },
  { pattern: /qwen2\.5-7b|llama-3\.2-3b|gemma-2-2b|smollm/, tier: 6, label: '7B/Tiny' },
  { pattern: /qwen2\.5-3b|llama-3\.2-1b|gemma-1\.1-2b/, tier: 7, label: '3B/Micro' },
  { pattern: /qwen2\.5-1\.5b|llama-3\.2-0\.5b|gemma-1\.1-1b/, tier: 8, label: '1.5B/Nano' },
];

/** Returns strength tier (0=strongest, 9=weakest/unknown) and label for a model name. */
function modelStrength(modelName, intelligence = null) {
  /* the gateway scores every model it routes to (0..1): that beats guessing from the name */
  if(typeof intelligence === 'number') return { tier: Math.min(8, Math.floor((1 - intelligence) * 10)), label: `${Math.round(intelligence * 100)}%` };

  const lower = modelName.toLowerCase();
  for(const { pattern, tier, label } of MODEL_STRENGTH_PATTERNS) {
    if(pattern.test(lower)) return { tier, label };
  }
  return { tier: 9, label: 'unknown' };
}

/** Rainbow gradient colors for model strength: purple (strongest) through red (weakest). */
const STRENGTH_COLORS = [
  '#8b5cf6', // violet (tier 0)
  '#a855f7', // purple
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green (tier 9)
];

/** ANSI color for a model's strength tier. */
function strengthColor(tier) {
  const clamped = Math.max(0, Math.min(9, tier));
  return STRENGTH_COLORS[clamped];
}

/** True if `name` is a glob pattern (`*`/`?`/`[...]`), like a file glob. */
function isModelGlob(name) {
  return /[*?[]/.test(name);
}

/* Glob pattern -> RegExp matched against a full model name. `*` matches any
   run of characters (model names may contain `/` and `:`), `?` any one. */
function modelGlobRe(pattern) {
  let re = '';

  for(let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if(c === '*') re += '.*';
    else if(c === '?') re += '.';
    else if('.+^$()|{}[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }

  return new RegExp('^' + re + '$');
}

/** The model names in `known` matching glob `pattern`, in `known`'s order. */
function modelsForGlob(pattern, known) {
  const re = modelGlobRe(pattern);
  return (known ?? []).filter(m => re.test(m) && !unavailableModels.has(m) && !availability?.byModel.get(m)?.blocked);
}

/* what the gateway limits right now (lib/availability.js), loaded by /model and /gateway; null without a dashboard session */
let availability = null;
let unavailableModels = new Set(); /* names the endpoint lists as unavailable (no key, disabled): hidden, not selectable */
let gatewayRef = null;

/* the standby model (lib/standby.js): probed and warm, ready to take over or to run a sub-agent */
const standby = { on: false, id: null, name: '', state: 'off', ms: 0, toolOk: false, servedBy: '', error: '', at: 0, busy: false, pinned: null, bad: new Map(), switchedAt: 0 };
const STANDBY_TTL_MS = 10 * 60_000;
let standbyHook = null; /* set by main(): { switchTo(id) } */
const standbyReady = () => standby.on && standby.state === 'ready' && standby.id; /* main()'s gateway, for the helpers outside it */

/** runs fn on fresh availability data of the gateway (needs a dashboard session) */
async function withAvailability(fn) {
  if(!gatewayRef?.hasLimits) return '(limits need a dashboard session: /gateway login)';
  availability = await loadAvailability(gatewayRef);
  return fn(availability);
}

/** the providers behind a model id: the gateway's platforms (a unified id may have several), else the owner it names */
function providerText(m, avail) {
  const p = avail?.byModel.get(m.name)?.platforms ?? [];
  if(p.length) return p.length > 2 ? `${p.slice(0, 2).join(',')}+${p.length - 2}` : p.join(',');
  return m.ownedBy && m.ownedBy !== 'freellmapi' ? m.ownedBy : m.provider || '-';
}

/** Returns all available models with metadata, filtering out skipped ones. */
function getFilteredModels(known, remote, avail = availability) {
  const now = Date.now();
  const models = [];
  
  if(remote) {
    for(const m of remote) {
      const skipped = skippedModels.get(m.name);
      if(skipped && skipped.until > now) continue;
      const strength = modelStrength(m.name, avail?.byModel.get(m.name)?.intelligence);
      models.push({
        name: m.name,
        displayName: m.displayName || '',
        provider: providerText(m, avail),
        available: m.available !== false,
        status: m.status,
        tools: m.tools,
        limited: avail?.byModel.get(m.name),
        strength: strength.tier,
        strengthLabel: strength.label,
        inputTokens: m.inputTokenLimit,
        outputTokens: m.outputTokenLimit,
        skipped: skipped ? true : false,
        skipUntil: skipped ? skipped.until : null,
      });
    }
  } else if(known) {
    for(const name of known) {
      const skipped = skippedModels.get(name);
      if(skipped && skipped.until > now) continue;
      const strength = modelStrength(name);
      models.push({
        name,
        displayName: '',
        provider: 'ollama',
        available: true,
        strength: strength.tier,
        strengthLabel: strength.label,
        inputTokens: null,
        outputTokens: null,
        skipped: skipped ? true : false,
        skipUntil: skipped ? skipped.until : null,
      });
    }
  }
  
  // Sort by strength (strongest first), then by name
  return models.sort((a, b) => a.strength - b.strength || a.name.localeCompare(b.name));
}

/** Resolves a model pattern (exact, glob, or number) to a model name. */
function resolveModel(pattern, known, remote) {
  if(/^\d+$/.test(pattern)) {
    const idx = +pattern - 1;
    const models = getFilteredModels(known, remote).filter(m => m.available && !m.limited?.blocked);
    return models[idx]?.name;
  }
  
  if(isModelGlob(pattern)) {
    const matches = modelsForGlob(pattern, known);
    return matches[0];
  }
  
  // Exact match
  const models = getFilteredModels(known, remote);
  return models.find(m => m.name === pattern)?.name;
}

/** Marks a model as skipped with cooldown. */
function skipModel(name, reason = 'manual') {
  const until = Date.now() + SKIP_COOLDOWN_MS;
  skippedModels.set(name, { until, reason });
}

/** the providers named in a gateway's "all models exhausted" error (its attempt trail), [] for any other error */
/** a gateway error that says no model could serve the request (429 routing_exhausted and the like) */
function isExhaustedError(error) {
  return /all models (rate-limited|exhausted|unavailable)|routing_exhausted/i.test(error ?? '');
}

function exhaustedPlatforms(error) {
  if(!isExhaustedError(error)) return [];
  const trail = /Attempt trail:([^]*?)(?:\. Last error|$)/.exec(error)?.[1] ?? '';
  return [...new Set([...trail.matchAll(/(?:^|;)\s*([\w.-]+)\/\S+ key\d+:/g)].map(m => m[1]))];
}

/** Skips every model whose name matches `pattern` (exact or glob). Returns the
    number skipped - used by `/model skip <pattern>` to batch-skip a failing
    provider family. */
function skipModels(pattern, reason = 'manual', known = null) {
  const re = isModelGlob(pattern) ? modelGlobRe(pattern) : null;
  let n = 0;

  for(const name of allModelNames(known)) {
    if(re ? re.test(name) : name === pattern) {
      skipModel(name, reason);
      n++;
    }
  }
  return n;
}

/** Removes a model from the skipped list, or every model matching a pattern. */
function unskipModels(pattern) {
  const re = isModelGlob(pattern) ? modelGlobRe(pattern) : null;
  let n = 0;

  for(const name of [...skippedModels.keys()]) {
    if(re ? re.test(name) : name === pattern) {
      skippedModels.delete(name);
      n++;
    }
  }
  return n;
}

/** every model name known to this session: the installed/remote list plus the
    ones already skipped (so a pattern can hit them even after they left the
    filtered list) */
function allModelNames(known = null) {
  const names = new Set(skippedModels.keys());
  for(const m of getFilteredModels(known ?? ollamaModels() ?? null, null)) names.add(m.name);
  return names;
}

/** Clears expired skips. */
function cleanupSkips() {
  const now = Date.now();
  for(const [name, info] of skippedModels) {
    if(info.until <= now) skippedModels.delete(name);
  }
}

/** window width in columns minus the panel border, 80 when it cannot be asked */
function listWidth() {
  try {
    return Math.max(30, (ttyGetWinSize(1)?.[0] ?? 80) - 4);
  } catch(e) {
    return 76;
  }
}

/** 38;2;r;g;b text from a #rrggbb color */
const fgHex = (hex, text) => `\x1b[38;2;${hex.slice(1).match(/.{2}/g).map(h => parseInt(h, 16)).join(';')}m${text}\x1b[0m`;

/**
 * Lines of a table that fits `width` columns: every column as wide as its widest cell up to its cap
 * (0 = no cap), column `flex` takes what is left and its cells end in an ellipsis when cut. `paint(row,
 * col, text)` colors an already padded cell.
 */
function compactTable(rows, width, flex, caps, paint) {
  const n = rows[0].length;
  const w = rows[0].map((_, c) => Math.min(...[caps[c] || Infinity, Math.max(...rows.map(r => r[c].length))]));
  const fixed = w.reduce((a, x, c) => a + (c === flex ? 0 : x), 0) + (n - 1);
  w[flex] = Math.max(10, Math.min(w[flex], width - fixed));

  return rows.map((row, r) =>
    row
      .map((cell, c) => {
        const t = cell.length > w[c] ? `${cell.slice(0, w[c] - 1)}…` : cell;
        return c === n - 1 ? paint(r, c, t) : paint(r, c, t.padEnd(w[c]));
      })
      .join(' ')
      .trimEnd(),
  );
}

/* Tab completion of a slash command's arguments (ChatREPL.argCompleter): the words a command takes, not file names.
   Returns the candidates, [] when the command takes no more words, null to leave the word to the file completion. */
let modelNamesCache = null; /* names of /model list or the Ollama host, for the ones the gateway does not catalog */

/** model names that can be chosen now: the gateway's ready models, else what /model last listed, else the Ollama host */
function completionModels() {
  if(gatewayRef?.enabled) return gatewayRef.modelsCached().filter(m => (m.execution_status ?? 'ready') === 'ready' && !availability?.byModel.get(m.id)?.blocked).map(m => m.id);
  if(modelNamesCache) return modelNamesCache;
  return completionOllama ? (ollamaModelsCache ??= ollamaModels() ?? []) : [];
}
let completionOllama = false;
let ollamaModelsCache = null;

function completeArgs(cmd, args, word) {
  const n = args.length;
  const MODE_NAMES = MODES;
  const onoff = ['on', 'off'];
  const kinds = KINDS;

  switch(cmd) {
    case '/mode':
      return n === 0 ? MODE_NAMES : [];
    case '/verbose':
    case '/stream':
    case '/mouse':
      return n === 0 ? onoff : [];
    case '/proxy':
      return n === 0 ? ['on', 'off', 'probe', 'exit'] : [];
    case '/split':
      return n === 0 ? ['diff', 'git', 'status', 'off'] : [];
    case '/provider':
      return n === 0 ? ['ollama', 'gemini', 'openai', 'freellm', 'bridge'] : [];
    case '/fallback':
      return n === 0 ? ['off', ...completionModels()] : [];
    case '/model':
      if(n === 0) return ['list', 'skip', 'unskip', ...completionModels()];
      if(n === 1 && args[0] === 'list') return ['all'];
      if(n === 1 && (args[0] === 'skip' || args[0] === 'unskip')) return completionModels();
      return [];
    case '/route':
      if(n === 0) return ['list', ...ROUTE_AXES.map(a => a[0]), 'auto', 'profile', 'new', ...completionModels()];
      return [];
    case '/standby':
      return n === 0 ? ['on', 'off', 'probe', 'switch', 'auto', ...completionModels()] : [];
    case '/delegate':
      if(n === 0) return ['on', 'off', 'add', 'remove', 'pin', 'ban', 'unban', 'good', 'bad', 'forget'];
      if(n === 1 && ['add', 'remove', 'ban', 'unban', 'good', 'bad'].includes(args[0])) return completionModels();
      if(n === 1 && args[0] === 'pin') return kinds;
      if(n === 2 && args[0] === 'pin') return completionModels();
      if(n >= 2 && (args[0] === 'add' || args[0] === 'good' || args[0] === 'bad')) return kinds;
      return [];
    case '/config':
      if(n === 0) return ['set', 'unset'];
      if(n === 1) return Object.keys(SETTINGS);
      if(n === 2 && args[0] === 'set') {
        const type = SETTINGS[args[1]];
        if(args[1] === 'mode') return MODE_NAMES;
        if(args[1] === 'provider') return ['ollama', 'gemini', 'openai', 'freellm', 'bridge'];
        if(type === 'boolean') return ['true', 'false'];
      }
      return [];
    case '/skill':
      if(n === 0) return ['off', 'loaded', ...listSkills().map(sk => sk.name)];
      if(n === 1 && args[0] === 'off') return listSkills().map(sk => sk.name);
      return [];
    case '/gateway':
      return n === 0 ? ['usage', 'providers', 'forecast', 'quota', 'limits', 'limited', 'models', 'login'] : [];
    case '/system':
      if(n === 0) return ['default', 'file', 'off'];
      return n === 1 && args[0] === 'file' ? null : [];
    case '/remote-control':
      return n === 0 && !/^[/.~]/.test(word) ? ['off'] : null;
    case '/help':
      return n === 0 ? HELP_TEXT.match(/^\/[a-z-]+/gm).map(c => c.slice(1)) : [];
    case '/compact':
    case '/last':
    case '/requests':
    case '/view':
    case '/queue':
      return n === 0 ? ['list', 'clear', 'drop'] : [];
    case '/rename':
    case '/restart':
    case '/undo':
    case '/diff':
    case '/status':
    case '/usage':
    case '/tools':
    case '/about':
    case '/reset':
    case '/clear':
    case '/exit':
    case '/quit':
    case '/files':
    case '/context':
    case '/log':
    case '/export':
      return [];
    default:
      return null; /* /cd, /run, /each, /js, /binding, an unknown command: file names */
  }
}

/** Shows the model list with strength coloring and skip status. */
async function showModelList(remote, known, provider, showAll = false) {
  cleanupSkips();
  if(gatewayRef?.hasLimits) availability = await loadAvailability(gatewayRef).catch(() => availability);
  const all = getFilteredModels(known, remote);
  const models = all.filter(m => m.available && !m.limited?.blocked);
  const hidden = all.filter(m => !m.available && !m.limited?.blocked);
  const limited = all.filter(m => m.limited?.blocked).sort((a, b) => (a.limited.until ?? Infinity) - (b.limited.until ?? Infinity) || a.name.localeCompare(b.name));
  
  if(!models.length) {
    return console.log('(no models available)');
  }
  
  console.log(`Models for ${provider} (${models.length} available${limited.length ? `, ${limited.length} limited` : ''}${hidden.length ? `, ${hidden.length} ${showAll ? 'without key or disabled' : 'hidden: /model list all'}` : ''}):`);

  /* one line per model: a column is as wide as its longest cell (up to its cap), the name takes what is left,
     so a window of 80 columns or more never wraps */
  const width = listWidth();
  const hasCaps = models.some(m => m.inputTokens || m.outputTokens) && width >= 100;
  const mark = m => (m.skipped ? `⏸ ${Math.ceil((m.skipUntil - Date.now()) / 60000)}m` : m.available ? '✓' : '✗');
  const caps = m => [m.inputTokens && `${m.inputTokens} in`, m.outputTokens && `${m.outputTokens} out`].filter(Boolean).join(' ');

  /* narrow windows lose columns, strength first, then the provider; the name and the mark stay */
  const spec = [
    ['#', m => 0, 4, true],
    ['name', m => m.name, 0, true],
    ['provider', m => m.provider, 14, width >= 56],
    ['strength', m => m.strengthLabel, 14, width >= 72],
    ['limits', caps, 16, hasCaps],
    ['', mark, 8, true],
  ].filter(c => c[3]);

  const idx = spec.findIndex(c => c[0] === 'name');
  const lines = compactTable(
    [spec.map(c => c[0]), ...models.map((m, i) => spec.map(c => (c[0] === '#' ? String(i + 1) : c[1](m))))],
    width,
    idx,
    spec.map(c => c[2]),
    (r, c, text) => (r === 0 ? `\x1b[1m${text}\x1b[0m` : c === idx ? fgHex(strengthColor(models[r - 1].strength), text) : spec[c][0] === '#' || spec[c][0] === 'provider' ? dim(text) : text),
  );
  for(const l of lines) console.log(l);

  if(limited.length) {
    const now = availability.at;
    console.log(`\n${waveNote(`${limited.length} limited right now, not selectable until they recover`)}`);
    const wide = width >= 70;
    const rows = limited.map(m => [m.name, ...(wide ? [m.provider] : []), kindsText(m.limited), backText(m.limited, now)]);
    for(const l of compactTable([['name', ...(wide ? ['provider'] : []), 'limit', 'back'], ...rows], width, 0, [0, ...(wide ? [14] : []), 13, 18], (r, c, text) => (r === 0 ? `\x1b[1m${text}\x1b[0m` : c === 0 ? dim(text) : text))) console.log(l);
  }

  if(showAll && hidden.length) {
    console.log(`\n${waveNote(`${hidden.length} without a key or disabled in the gateway, not selectable`)}`);
    const wide = width >= 56;
    for(const l of compactTable([['name', ...(wide ? ['provider'] : [])], ...hidden.map(m => [m.name, ...(wide ? [m.provider] : [])])], width, 0, [0, 14], (r, c, text) => (r === 0 ? `\x1b[1m${text}\x1b[0m` : dim(text)))) console.log(l);
  }

  console.log('\nUsage: /model <number|name|pattern|skip|unskip>  (list all: also the unavailable ones)');
}

/** --name, else the model name; made unique among the live sessions (name, name-2, ...). */
function sessionName(opts) {
  const base = opts.name ?? opts.model;
  const taken = new Set(listSessions().filter(s => s.pid !== getpid()).map(s => s.name));
  let name = base;
  for(let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/** One line telling which `think` value the client will send for its model, and why. */
async function thinkNote(client) {
  const mode = client.think;
  const value = await client.resolveThink();
  const why = mode === 'detect' ? ((await client.canThink()) ? 'model has the thinking capability' : 'model has no thinking capability') : `--think ${mode}`;
  return `(think: ${mode === 'auto' ? 'not sent' : value} - ${why})`;
}

/**
 * the three status rows of the TUI, cols wide
 *
 *   ───────────────────────────── (gradient)
 *    edits  ~/src/x          qwen3-coder via Cerebras        ctx ███····· 34% 44k/128k
 *   last 1.2k+300 · session 5 req 20k tok · req/min ██·· 3/10 · ... · Shift-Tab mode
 */
function statusLines(opts, stats, messages, ctxWindow, busy, gateway, remote, cols, queued = 0) {
  const t = stats.totals();
  const last = stats.last();
  const effective = last && !last.error ? routeName(last) : null;
  const routedVia = last?.routedVia ?? last?.model ?? null;
  const dimmed = s => `\x1b[2m${s}\x1b[22m`;

  const left = `${modeBadge(opts.mode, MODE_COLOR[opts.mode])} ${dimmed(shortPath(realpath(opts.root)[0] ?? opts.root, Math.max(12, Math.floor(cols / 4))))}${ui.verbose ? ' \x1b[33mverbose\x1b[0m' : ''}${remote ? ` \x1b[36mremote:${remote}\x1b[0m` : ''}`;
  const center = effective
    ? `\x1b[1m${effective}\x1b[22m${routedVia && routedVia !== effective ? dimmed(` → ${routedVia}`) : ''}${last.provider ? dimmed(` via ${last.provider}`) : ''}${effective !== opts.model && !effective.endsWith(opts.model) ? dimmed(` (asked ${opts.model})`) : ''}`
    : `${opts.label ?? opts.provider}/${opts.model}${dimmed(' (no reply yet)')}`;

  /* context in use after the last reply: its prompt plus its answer, else a chars/4 estimate */
  const used = last?.usage ? (last.usage.prompt ?? 0) + (last.usage.completion ?? 0) : Math.round(totalChars(messages ?? []) / 4);
  const right = ctxWindow ? `ctx ${meter(used / ctxWindow, 8)} ${Math.round((100 * used) / ctxWindow)}% ${dimmed(`${fmtNum(used)}/${fmtNum(ctxWindow)}`)}` : `ctx ${last?.usage ? '' : '~'}${fmtNum(used)} tok${dimmed(' (window ?)')}`;

  const two = [];
  if(last?.usage) two.push(`last ${fmtNum(last.usage.prompt)}+${fmtNum(last.usage.completion)}${last.usage.reasoning ? ` (${fmtNum(last.usage.reasoning)} reasoning)` : ''}${last.usage.cached ? ` ${fmtNum(last.usage.cached)} cached` : ''}`);
  if(last?.error) two.push(`\x1b[31mlast failed: ${last.error.slice(0, 60)}\x1b[39m`);
  two.push(`session ${t.requests} req ${fmtNum(t.total)} tok`);

  /* a quota as a small meter, used/limit */
  const quota = (name, x) => (x?.limit ? `${name} ${meter(x.used / x.limit, 4)} ${fmtNum(x.used)}/${fmtNum(x.limit)}` : null);
  const q = gateway?.modelQuota(last);
  if(q) two.push(...[quota('req/min', q.rpm), quota('req/day', q.rpd), quota('tok/min', q.tpm), quota('month', q.month)].filter(Boolean));

  const u = gateway?.state.usage;
  const b = gateway?.state.budget;
  if(u) two.push(b?.totalBudget ? `gateway ${meter(b.totalUsed / b.totalBudget, 4)} ${Math.round((100 * b.totalUsed) / b.totalBudget)}% of ${fmtNum(b.totalBudget)}` : `gateway month ${fmtNum(u.tokens)} tok ${fmtNum(u.requests)} req`);
  if(last?.rateLimit) two.push(`gw ${last.rateLimit.remaining}/${last.rateLimit.limit}/min`);
  if(proxyInfo.settings?.active) {
    const o = proxyInfo.probe?.overhead;
    two.push(`proxy ${proxyInfo.measuring ? 'measuring…' : o == null ? 'on' : `${o > 1000 ? '\x1b[33m' : ''}${signedMs(o)}\x1b[39m`}${last && last.proxied === false ? ' (last direct)' : ''}`);
  }
  if(standby.on) two.push(standby.state === 'ready' ? `standby ${standby.id} ✓ ${fmtMs(standby.ms)}${standby.toolOk ? '' : ' (no tools)'}` : standby.state === 'probing' ? 'standby probing…' : `\x1b[33mstandby ${standby.state}\x1b[39m`);
  if(last?.fallbacks) two.push(`\x1b[33m${last.fallbacks} fallback${last.fallbacks > 1 ? 's' : ''}\x1b[39m`);
  if(queued) two.push(`\x1b[33m${queued} queued\x1b[39m`);
  two.push(busy ? 'Esc cancels · Ctrl-X Ctrl-S sends now' : 'Shift-Tab mode · Ctrl-O verbose · /help');

  return [gradientRule(cols), statusBar([left, center, right], cols - 1), dimmed(two.join(' · '))];
}

async function main() {
  const opts = parseArgs(scriptArgs.slice(1));
  completionOllama = opts.provider === 'ollama';
  initHarness(opts.root);
  snapshotHarness();

  /* --provider bridge: run examples/chat-bridge ourselves and talk to it
     as an OpenAI endpoint (everything below sees provider 'openai') */
  let bridgeProc = null;
  if(opts.provider === 'bridge') {
    try {
      bridgeProc = await startBridge({ scriptPath: scriptArgs[0], cdpHost: opts.cdpHost, cdpPort: opts.cdpPort, allowPaid: opts.allowPaid });
    } catch(e) {
      console.log(red(`error: ${e.message}`));
      exit(1);
    }

    opts.provider = 'openai';
    opts.label = 'bridge';
    opts.baseUrl = bridgeProc.url;
    opts.apiKey = 'bridge';
    opts.streamUsage = false; // the bridge emulates OpenAI, extra fields are not checked there
  }

  let client;
  try {
    client = opts.provider === 'gemini' ? new GeminiClient(opts) : opts.provider === 'openai' ? new OpenAIClient(opts) : new OllamaClient(opts);
  } catch(e) {
    console.log(red(`error: ${e.message}`));
    exit(1);
  }

  /* every request's route and tokens, for /usage, /last and the status line */
  const stats = (statsRef = new UsageStats());
  /* context window of the model that answered last, for the status line */
  let ctxWindow;

  if('onPhase' in client) client.onPhase = (name, meta) => setPhase(name, { meta });

  if('onMeta' in client)
    client.onMeta = meta => {
      meta.proxied = proxied(proxyInfo.settings, meta.platform);
      stats.add(meta);
      if(standby.on && standbyHook) standbyHook.refresh().catch(() => {});
      tui?.drawStatus();

      /* the gateway's quota counters moved, and the model that answered may have another window */
      gateway?.refresh().then(async () => {
        if(!meta.error) ctxWindowNow = ctxWindow = (await gateway.effectiveContext(meta, opts.model)) ?? ctxWindow;
        tui?.drawStatus();
      });
    };

  /* a freellmapi gateway answers /v1/usage: its extra queries become available */
  let gateway = null;

  /* the gateway's upstream proxy and its measured latency; the first probe runs in the background */
  const loadProxy = async probe => {
    try {
      proxyInfo.settings = await proxySettings(gateway);
    } catch(e) {
      proxyInfo.settings = null;
      return;
    }

    if(probe && proxyInfo.settings.active && proxyInfo.settings.url && !proxyInfo.measuring) {
      proxyInfo.measuring = true;
      measure(proxyInfo.settings.url, { runs: 1 })
        .then(m => (proxyInfo.probe = m))
        .catch(() => {})
        .finally(() => ((proxyInfo.measuring = false), tui?.drawStatus()));
    }
  };

  /* the standby: probes the model the gateway would use next, in the background, after turns */
  const makeClient = model => {
    const c = new OpenAIClient({ ...opts, model });
    c.extraHeaders = { 'x-session-id': `${opts.sessionId ?? 'ollama-repl'}-standby` };
    return c;
  };

  const currentIds = () => [opts.model, stats.last()?.routedVia, stats.last()?.model].filter(Boolean);

  async function refreshStandby(force = false) {
    if(!standby.on || !gateway?.enabled || standby.busy) return;

    const now = Date.now();
    const lim = availability?.byModel.get(standby.id);
    const good = standby.state === 'ready' && now - standby.at < STANDBY_TTL_MS && !currentIds().includes(standby.id) && !lim?.blocked;
    if(!force && good) return;

    standby.busy = true;
    standby.state = 'probing';
    tui?.drawStatus();

    try {
      if(gateway.hasLimits) availability = await loadAvailability(gateway).catch(() => availability);

      for(const [id, until] of standby.bad) if(until < now) standby.bad.delete(id);

      /* the candidates in the gateway's order; one that fails its probe is set aside for 10 minutes */
      for(let attempt = 0; attempt < 3; attempt++) {
        const av = gateway.hasLimits ? availability : null;
        const exclude = [...currentIds(), ...standby.bad.keys()];

        /* nothing routed yet on auto: the gateway's first choice is what the first request will use, the standby is the one after it */
        if(!standby.pinned && !stats.last()?.routedVia && /^auto(:|$)/.test(opts.model)) {
          const first = await pickNext(gateway, av, { exclude });
          if(first) exclude.push(first.id);
        }

        const pick = standby.pinned ? { id: standby.pinned, name: standby.pinned } : await pickNext(gateway, av, { exclude });

        if(!pick) {
          Object.assign(standby, { id: null, name: '', state: 'none', error: 'no other usable model', at: Date.now() });
          return;
        }

        const c = makeClient(pick.id);
        const r = await probeModel(c, pick.id);
        c.destroy();

        if(r.ok) {
          Object.assign(standby, { id: pick.id, name: pick.name ?? pick.id, state: 'ready', ms: r.ms, toolOk: r.toolOk, servedBy: r.servedBy ?? '', error: '', at: Date.now() });
          return;
        }

        standby.bad.set(pick.id, Date.now() + STANDBY_TTL_MS);
        Object.assign(standby, { id: pick.id, name: pick.name ?? pick.id, state: 'failed', error: r.error ?? 'no answer', at: Date.now() });
        if(standby.pinned) return;
      }
    } catch(e) {
      Object.assign(standby, { state: 'failed', error: String(e.message).split('\n')[0] });
    } finally {
      standby.busy = false;
      tui?.drawStatus();
    }
  }

  standbyHook = {
    client: () => client,
    refresh: refreshStandby,
    switchTo: name => {
      opts.model = name;
      client.model = name;
      repl.setPromptName?.(name);
      control?.update({ model: name });
      standby.state = 'used';
      updateCtxWindow?.();
    },
  };

  if(opts.provider === 'openai') {
    gateway = gatewayRef = new Gateway(client);

    if((await gateway.detect()) && gateway.isBridge) {
      /* a chat-bridge: usage, health and limits per site, auto and auto:AXIS routing, no named profiles, dashboard or proxy */
      opts.sessionId ??= `ollama-repl-${Date.now().toString(36)}-${getpid().toString(36)}`;
      client.extraHeaders = { 'x-session-id': opts.sessionId };
      await gateway.refresh(true);
      if(gateway.hasLimits) availability = await loadAvailability(gateway).catch(() => null);
      if(opts.standby) {
        standby.on = true;
        refreshStandby().catch(() => {});
      }
    } else if(gateway.enabled) {
      if(!opts.modelGiven) opts.model = client.model = 'auto';
      /* sticky routing and the gateway's context handoff are keyed by this id: it lives as long as the
         conversation (kept over /restart), not as long as the process */
      opts.sessionId ??= `ollama-repl-${Date.now().toString(36)}-${getpid().toString(36)}`;
      client.extraHeaders = { 'x-session-id': opts.sessionId };
      if(await gateway.login({ cdp: { host: opts.cdpHost, port: opts.cdpPort } })) await loadProxy(true);
      await gateway.refresh(true);
      if(opts.standby) {
        standby.on = true;
        refreshStandby().catch(() => {});
      }
    } else if(opts.label === 'freellm' && !gateway.enabled) console.log(dim(`(${client.baseUrl} does not answer /v1/usage - no freellmapi gateway there, /gateway is off)`));
  }

  /* a plain OpenAI-compatible endpoint (a chat-bridge): its model names for Tab completion */
  if(opts.provider === 'openai' && !gateway?.enabled) client.listModels().then(r => (modelNamesCache = r.filter(m => m.available !== false).map(m => m.name))).catch(() => {});

  if(bridgeProc && opts.model === undefined) {
    const models = await client.listModels().catch(() => []);
    opts.model = models.some(m => m.name === 'auto') ? 'auto' : pickModel(models);

    if(!opts.model) {
      console.log(red('error: no model available on the bridge right now (all rate limited?), try again later'));
      bridgeProc.stop();
      exit(1);
    }

    client.model = opts.model;
  }

  if(opts.model === 'list') {
    if(opts.provider === 'ollama') {
      const pipe = popen('ollama list', 'r');
      if(!pipe) {
        console.log(red('error: cannot run "ollama list"'));
        exit(1);
      }

      stdout.puts(pipe.readAsString());
      stdout.flush();
      client.destroy();
      exit(pipe.close() === 0 ? 0 : 1);
    }

    if(opts.provider !== 'gemini' && opts.provider !== 'openai') {
      console.log(red(`error: --model list is only implemented for --provider gemini, openai and ollama (not ${opts.provider})`));
      exit(1);
    }

    try {
      for(const m of await client.listModels()) console.log(`${m.name.padEnd(44)} ${String(m.inputTokenLimit ?? '').padStart(8)} in ${String(m.outputTokenLimit ?? '').padStart(6)} out  ${m.displayName ?? ''}`);
    } catch(e) {
      console.log(red(`error: ${e.message}`));
      bridgeProc?.stop();
      exit(1);
    }

    client.destroy();
    bridgeProc?.stop();
    exit(0);
  }

  if(opts.provider === 'ollama') console.log(dim(await thinkNote(client)));

  const log = new SessionLog(`${opts.model.replaceAll(':', '-')}.log`);
  let sentFiles = new SentFiles(opts.model, opts.root);
  let fileExchange = new FileExchange(opts.model, opts.root);
  const store = new SessionStore(opts.model);

  /* Handle --resume: load serialized state from temp file */
  let saved = store.load();
  let pendingQueue = [];
  let messages;
  let baseMessageCount = 0;

  if(opts.resume) {
    const stateText = loadFile(opts.resume);
    if(!stateText) {
      console.log(red(`error: cannot read resume file ${opts.resume}`));
      exit(1);
    }
    try {
      const state = JSON.parse(stateText);
      messages = state.messages;
      baseMessageCount = state.baseMessageCount ?? 0;
      /* from here on this is the saved session: the store of the working directory must not stand in for it */
      saved = { messages, baseMessageCount };
      
      /* Restore opts from state, but keep CLI args */
      opts.provider = state.provider ?? opts.provider;
      opts.model = state.model ?? opts.model;
      opts.fallbackModel = state.fallbackModel ?? opts.fallbackModel;
      opts.root = state.root ?? opts.root;
      retargetHarness(opts.root);
      opts.mode = state.mode ?? opts.mode;
      opts.temperature = state.temperature ?? opts.temperature;
      opts.numCtx = state.numCtx ?? opts.numCtx;
      opts.maxRounds = state.maxRounds ?? opts.maxRounds;
      opts.stream = state.stream ?? opts.stream;
      opts.think = state.think ?? opts.think;
      opts.noSystem = state.noSystem ?? opts.noSystem;
      opts.noTools = state.noTools ?? opts.noTools;
      opts.noFailover = state.noFailover ?? opts.noFailover;
      opts.noHandoff = state.noHandoff ?? opts.noHandoff;
      opts.handoffTurns = state.handoffTurns ?? opts.handoffTurns;
      opts.handoffModel = state.handoffModel ?? opts.handoffModel;
      opts.scan = state.scan ?? opts.scan;
      opts.allowPaid = state.allowPaid ?? opts.allowPaid;
      opts.cdpHost = state.cdpHost ?? opts.cdpHost;
      opts.cdpPort = state.cdpPort ?? opts.cdpPort;
      opts.name = state.sessionName ?? opts.name;
      opts.sessionId = state.sessionId ?? opts.sessionId;
      pendingQueue = Array.isArray(state.queue) ? state.queue.filter(q => typeof q === 'string') : [];
      for(const m of state.skippedModels ?? []) if(m.until > Date.now()) skippedModels.set(m.name, { until: m.until, reason: m.reason });
      
      console.log(dim(`(resumed session from ${opts.resume}: ${messages.length} messages)`));
      
      // Clean up temp file
      removeFile(opts.resume);
    } catch(e) {
      console.log(red(`error: failed to parse resume file: ${e.message}`));
      exit(1);
    }
  } else {
    saved = store.load();
    pendingQueue = saved?.queue ?? [];
    delegateNotesOn = !opts.noDelegate && !opts.failsafe && !opts.noSystem && !opts.noTools && (opts.provider === 'openai' || opts.provider === 'ollama');
    messages = saved ? saved.messages : opts.failsafe || opts.noSystem ? [] : [{ role: 'system', content: opts.noTools ? NOTOOLS_PROMPT : opts.label === 'bridge' ? BRIDGE_PROMPT : SYSTEM_PROMPT + systemNotes(opts.root) }];
    baseMessageCount = saved ? saved.baseMessageCount : messages.length;
    /* a resumed session carries the system prompt of the run that saved it */
    if(opts.noSystem && messages[0]?.role === 'system') {
      messages.shift();
      if(saved) saved.baseMessageCount = Math.max(0, saved.baseMessageCount - 1);
    }
  }

  const saveSession = () => store.save(messages, baseMessageCount, repl?.queue ?? []);

  /* context window of the model, for the status line */
  const updateCtxWindow = async () => (ctxWindowNow = ctxWindow = gateway?.enabled ? await gateway.contextWindow(opts.model) : opts.provider === 'ollama' ? opts.numCtx : undefined);
  await updateCtxWindow();

  /* the facts of /about and the startup panel */
  const commit = (() => {
    const pipe = popen(`git -C '${scriptArgs[0].replace(/[^/]*$/, '') || '.'}' log -1 --format='%h %cs' 2>/dev/null`, 'r');
    const out = pipe?.readAsString().trim();
    pipe?.close();
    return out || null;
  })();
  const aboutRows = () => [
    ['version', commit ? `qjs-lws ${commit}` : null],
    ['model', `${opts.label ?? opts.provider}/${opts.model}`],
    ['endpoint', endpoint],
    ['gateway', gateway?.enabled ? `${gateway.isBridge ? 'chat-bridge' : 'freellmapi'}${gateway.tokenSource ? `, dashboard via ${gateway.tokenSource}` : ''}` : null],
    ['mode', `${opts.mode} - ${MODE_INFO[opts.mode]}`],
    ['root', shortPath(realpath(opts.root)[0] ?? opts.root)],
    ['session', `${opts.name ?? opts.model}${control ? ' (remote control on)' : ''}`],
    ['log', shortPath(log.path)],
    ['failsafe', opts.failsafe ? 'no system prompt, project scan or tools' : null],
  ];

  /* the control socket (--listen, /remote-control), see startControl() */
  let control = null;
  let startControl;

  /* full-terminal layout when a person types into a terminal */
  let repl;
  if(!piped && !opts.noTui && isatty(0) && isatty(1)) {
    tui = new Tui({
      status: () => statusLines(opts, stats, messages, ctxWindow, repl?.busy, gateway, control && opts.name, tui.cols, repl?.queue.length),
      statusRows: 3,
      paintRule: (cols, label) => gradientRule(cols, label),
      onResize: cols => repl && ((repl.columns = cols), repl.render()),
    });
    tui.verbose = ui.verbose;
    tui.start();
  }

  const endpoint = opts.provider === 'gemini' ? 'generativelanguage.googleapis.com' : opts.provider === 'openai' ? client.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '') : `${opts.host}:${opts.port}`;
  if(tui) {
    console.log(banner(aboutRows(), TIPS, tui.width));
  } else {
    console.log(`ollama-repl: ${opts.provider}/${opts.model} @ ${endpoint}  (root: ${opts.root})${opts.failsafe ? '  [failsafe: no system prompt/project scan/tools]' : ''}`);
    if(gateway?.enabled) console.log(dim(gateway.isBridge ? '(chat-bridge: /gateway usage|providers|forecast|limits|limited, /model list shows the sites with their limits)' : '(freellmapi gateway: each reply names the model that served it, /usage /last /requests /gateway for the rest)'));
    console.log(`/help for commands.`);
    console.log(`Logging this session to ${log.path}`);
    console.log(`History persists (^R to search, up/down to recall).`);
  }

  if(saved) {
    if(!opts.resume) console.log(dim(`(resumed session from ${store.path}: ${messages.length} messages)`));
  } else if(!opts.failsafe && (opts.label !== 'bridge' || opts.scan)) {
    console.log(dim(`(scanning project layout...)`));

    const projectContext = await gatherProjectContext(opts.root);

    //console.log('projectContext', console.config({ maxStringLength: 32, maxArrayLength: 32 }), projectContext.length, projectContext.replaceAll(/\n/g, '\\n').slice(0, 50));

    messages.push(
      { role: 'user', content: `(automatic project scan at session start)\n\n${projectContext}` },
      { role: 'assistant', content: "Got it - I have the project's layout and README/CMakeLists.txt contents above." },
    );
    log.toolResults(projectContext);
  }

  console.log('ready!');

  // /reset clears conversation history, not the auto-loaded project scan.
  baseMessageCount = saved ? saved.baseMessageCount : messages.length;
  saveSession();
  const startedAt = Date.now();

  /* Set to the active client's abort() (see chatRound() above) for the
     duration of whatever chat()/chatStream() call is currently in flight,
     null otherwise - the ChatREPL constructed below calls it on Ctrl-C
     instead of quitting, when there's actually something to cancel. */
  const abortRef = { current: null };

  let prevRoot = null;

  const setMode = mode => {
    opts.mode = mode;
    control?.update({ mode });
    tui?.drawStatus();
  };

  /* asked per call, so a mode change (Shift-Tab) applies to the next one */
  /* tools the user allowed for the rest of the session ("Yes, always") */
  const allowedAlways = new Set();

  /* what is about to happen (a panel in the TUI), then a choice: once, always, no */
  const approve = async (name, title, detail, question, options) => {
    if(allowedAlways.has(name)) return true;

    if(tui?.active) showPanel(title, detail, { border: WARN_BORDER });
    else console.log(`${title}\n  ${stripAnsi(detail).split('\n').join('\n  ')}`);

    const before = { ...phase };
    setPhase('you');
    const k = await repl.choose(question, options, tui?.active ? { view: () => repl.openPager(title, detail) } : {});
    Object.assign(phase, before, { since: Date.now() });
    if(k === 1) allowedAlways.add(name);
    return k < 2;
  };

  const confirmRun = cmd => (needsApproval(opts.mode, 'run_command') ? approve('run_command', '$ run_command', cmd, 'Run this command?', ['Yes, run it once', 'Yes, and every command this session without asking', 'No']) : Promise.resolve(true));
  approveWrite = (text, name, args) => {
    const [head, ...body] = text.split('\n');
    const detail = tui?.active ? numberedDiff(name, args, loadFile(underRoot(opts.root, args.path)), false) : body.join('\n');

    return approve(name, `✎ ${head}`, detail || head, 'Apply this change?', ['Yes, allow once', `Yes, allow ${name} for the rest of this session`, 'No']);
  };
  approveSelf = async (text, name, args) => {
    const [head, ...body] = text.split('\n');
    const detail = tui?.active ? numberedDiff(name, args, loadFile(underRoot(opts.root, args.path)), false) : body.join('\n');
    const title = `⚠ ${head} - changes ollama-repl itself`;

    if(tui?.active) showPanel(title, detail || head, { border: WARN_BORDER });
    else console.log(`${title}\n  ${stripAnsi(detail || head).split('\n').join('\n  ')}`);

    const before = { ...phase };
    setPhase('you');
    const k = await repl.choose('Change the harness itself?', ['Yes, this edit', 'No'], tui?.active ? { view: () => repl.openPager(title, detail) } : {});
    Object.assign(phase, before, { since: Date.now() });
    return k === 0;
  };
  const askUser = question => repl.ask(question);

  /* Runs `task` once per item, each in its own fresh two-message
     conversation (system prompt + the task for that one item) - a small
     model is far more reliable on "do this one thing" than on "do this to
     all 20 things" in one ever-growing context. Backs both the /each
     command and the model's own for_each tool. */
  const forEach = async (items, task) => {
    const sub = { ...opts, stream: false, quiet: true, maxRounds: Math.min(opts.maxRounds, 12), omitTools: omitToolsFor(task) };
    const hasSlot = /\{item\}|\{\}/.test(task);
    const results = [];

    for(const [i, item] of items.entries()) {
      console.log(`[${i + 1}/${items.length}] ${item}`);

      const text = hasSlot ? task.replaceAll('{item}', item).replaceAll('{}', item) : `${task}\n\nItem: ${item}`;
      const subMessages = [
        { role: 'system', content: SYSTEM_PROMPT + systemNotes(opts.root) },
        { role: 'user', content: `${text}\n\n(This is one item of a batch: do only this item, and nothing else in the file. Make exactly the change asked for, as short as asked, in your own words - do not copy whole comment blocks from other files. Then reply with one short line saying what you did.)` },
      ];

      try {
        let writes = writeCount;
        let reply = await runToolLoop(client, subMessages, sub, log, confirmRun, askUser, abortRef);

        /* nothing was written: a fresh conversation gets a second try (a
           small model's failures here are mostly one-off, not systematic) */
        if(writeCount === writes && asksForChange(subMessages)) {
          console.log(dim('  (no change made - retrying once)'));
          subMessages.length = 2;
          reply = await runToolLoop(client, subMessages, sub, log, confirmRun, askUser, abortRef);
        }

        const summary = (reply || '(no reply)').trim().split('\n')[0].slice(0, 200);
        console.log(dim(`  ${summary}`));
        results.push(`${item}: ${summary}`);
      } catch(e) {
        console.log(red(`  error: ${e.message}`));
        results.push(`${item}: error: ${e.message}`);
      }
    }

    return results.join('\n');
  };


  /* the gateway ran out of models: the round skips and retries by itself (see autoSkipHook) */
  autoSkipHook = {
    client: () => (gateway?.enabled ? client : null),
    skip: async error => {
      skipError = error;
      try {
        console.log(waveNote('no model could serve the request: skipping the spent one and trying the next'));
        await runLine('/model skip');
        return true;
      } finally {
        skipError = null;
      }
    },
  };

  /* one input line: a /command or a prompt for the model */
  const runLine = async line => {
    const prompt = line.trim();
    if(!prompt) return;

    if(!prompt.startsWith('/') || prompt.startsWith('/each ') || prompt.startsWith('/binding ')) resetJournal();

    /* /each <shell command listing the items, one per line> :: <task, {} = the item> */
    if(prompt.startsWith('/each ')) {
      const [listCmd, task] = prompt.slice('/each '.length).split(/\s+::\s+/);
      if(!listCmd || !task) return void console.log('usage: /each <command that prints one item per line> :: <task, with {} where the item goes>');

      const { output, status } = await runCommand(listCmd, { cwd: opts.root });
      const items = output.split('\n').map(l => l.trim()).filter(Boolean);
      if(status !== 0 || !items.length) return void console.log(`(no items: exit ${status})\n${output}`);

      const summary = await forEach(items, task);
      messages.push({ role: 'user', content: `(ran /each over ${items.length} items: ${task})` }, { role: 'assistant', content: summary });
      saveSession();
      return;
    }

    //console.log('ChatREPL', prompt);

    if(prompt === '/exit' || prompt === '/quit') return repl.exit(0);

    if(prompt === '/undo') {
      const undone = undoJournal();
      console.log(undone.length ? `(restored: ${undone.join(', ')})` : '(nothing to undo - no file was changed by the last prompt)');
      return;
    }

    if(prompt === '/diff') {
      const { output } = await runCommand('git diff --stat && git diff', { cwd: opts.root });
      console.log(output || '(no changes)');
      return;
    }

    if(prompt === '/reset') {
      messages.length = baseMessageCount;
      saveSession();
      console.log('(conversation reset)');
      return;
    }

    if(prompt === '/clear') {
      messages.length = 0;
      baseMessageCount = 0;
      saveSession();
      console.log('(context cleared)');
      return;
    }

    if(prompt === '/help') {
      console.log(tui?.active ? helpPanel(HELP_TEXT, HELP_SECTIONS, tui.width) : HELP_TEXT);
      return;
    }

    if(prompt === '/mouse' || prompt === '/mouse on' || prompt === '/mouse off') {
      if(!tui?.active) return void console.log('(the mouse needs the TUI)');
      if(prompt !== '/mouse') tui.setMouse(prompt.endsWith('on'));
      return void console.log(`mouse: ${tui.mouse ? 'on - the wheel scrolls the transcript, Shift-drag selects text' : 'off - the terminal selects text, PgUp/PgDn scroll the transcript'}`);
    }

    if(prompt === '/split' || prompt.startsWith('/split ')) {
      if(!tui?.active) return void console.log('(the split needs the TUI)');

      const arg = prompt.slice('/split'.length).trim() || (split.mode ? 'off' : 'diff');
      if(!['diff', 'git', 'status', 'off'].includes(arg)) return void console.log('usage: /split [diff|git|status|off]');

      clearTimeout(split.timer);
      split.timer = null;
      split.mode = arg === 'off' ? null : arg;

      if(arg === 'git') await refreshGit();
      if(arg === 'status') {
        const poll = async () => {
          if(split.mode !== 'status') return;
          split.sockets = await ownSockets(getpid()).catch(() => []);
          tui.drawPane();
          split.timer = setTimeout(poll, 1000);
        };
        await poll();
      }

      if(!tui.setPane(split.mode ? paneLines : null) && split.mode) {
        split.mode = null;
        return void console.log('(the window is too narrow for a split, 80 columns at least)');
      }
      return;
    }

    if(prompt === '/proxy' || prompt.startsWith('/proxy ')) {
      if(!gateway?.enabled || gateway.isBridge) return void console.log('(no freellmapi gateway: the endpoint does not answer /v1/usage the freellmapi way)');

      const arg = prompt.slice('/proxy'.length).trim();
      await loadProxy(false);
      const url = proxyInfo.settings?.url;

      if(arg === 'on' || arg === 'off') {
        if(!proxyInfo.settings) return void console.log(red('error: proxy settings need a dashboard session: /gateway login'));
        if(arg === 'on' && !url) return void console.log(red('error: the gateway has no proxy URL set (dashboard: Settings, Proxy)'));

        try {
          proxyInfo.settings = await setProxyEnabled(gateway, arg === 'on');
        } catch(e) {
          return void console.log(red(`error: ${e.detail ?? e.message.split('\n')[0]}`));
        }

        tui?.drawStatus();
        return void console.log(`${waveNote(`gateway proxy ${arg === 'on' ? 'on' : 'off'}`)}\n${proxyText(stats)}`);
      }

      if((arg === 'probe' || arg === 'exit') && !url) return void console.log(red('error: the gateway has no proxy set'));

      if(arg === 'exit') {
        const before = await exitIp(url);
        try {
          await newExit();
        } catch(e) {
          return void console.log(red(`error: ${e.message}`));
        }
        const after = await exitIp(url);
        proxyInfo.exits = [before ?? '?', after ?? '?'];
      }

      if(arg === 'probe' || arg === 'exit') {
        proxyInfo.measuring = true;
        tui?.drawStatus();
        try {
          proxyInfo.probe = await measure(url);
        } finally {
          proxyInfo.measuring = false;
        }
        tui?.drawStatus();
      } else if(arg) return void console.log('usage: /proxy [on|off|probe|exit]');

      return void console.log(proxyText(stats));
    }

    if(prompt === '/view' || prompt.startsWith('/view ')) {
      const n = +prompt.slice(5).trim() || panels.length;
      const p = panels[n - 1];
      if(!p) return void console.log(panels.length ? `(panels are 1-${panels.length})` : '(no panel shown yet)');
      return void repl.openPager(`#${n} ${p.title}`, p.text);
    }

    if(prompt === '/about') return void console.log(tui?.active ? banner(aboutRows(), TIPS, tui.width) : keyValue(aboutRows()).join('\n'));

    if(prompt === '/cd' || prompt.startsWith('/cd ')) {
      const arg = prompt.slice('/cd'.length).trim();
      if(!arg) return void console.log(`(root: ${opts.root})`);
      if(arg === '-' && !prevRoot) return void console.log('(no previous directory)');

      const dir = arg === '-' ? prevRoot : resolveDir(opts.root, arg);
      if(fileMode(dir) !== S_IFDIR) return void console.log(red(`error: ${dir}: not a directory`));

      prevRoot = opts.root;
      opts.root = dir;
      retargetHarness(dir);
      sentFiles.setRoot(opts.root);
      fileExchange.setRoot(opts.root);
      control?.update({ root: opts.root });

      /* the system prompt's QuickJS notes and the project scan describe the old root */
      if(messages[0]?.role === 'system' && messages[0].content.startsWith(SYSTEM_PROMPT)) messages[0].content = SYSTEM_PROMPT + systemNotes(opts.root);
      const scan = messages.findIndex(m => m.role === 'user' && m.content.startsWith('(automatic project scan'));
      if(scan >= 0) {
        const projectContext = await gatherProjectContext(opts.root);
        messages[scan].content = `(automatic project scan at session start)\n\n${projectContext}`;
        log.toolResults(projectContext);
      }

      saveSession();
      console.log(`(root: ${opts.root})`);
      return;
    }

    if(prompt === '/status') {
      const uptimeS = Math.round((Date.now() - startedAt) / 1000);
      const t = stats.totals();
      const last = stats.last();
      console.log(
        [
          `model:    ${opts.provider}/${opts.model} @ ${endpoint}${opts.stream ? ' (streaming)' : ''}${gateway?.enabled ? ' (freellmapi gateway)' : ''}`,
          ...(last ? [`last:     ${routeLine(last)}`] : []),
          `usage:    ${t.requests} requests, ${fmtNum(t.total)} tokens (${fmtNum(t.prompt)} prompt, ${fmtNum(t.completion)} completion) - /usage for details`,
          `root:     ${opts.root}`,
          `messages: ${messages.length - baseMessageCount} (${messages.length} incl. system prompt + project scan)`,
          `log:      ${log.path}`,
          `uptime:   ${uptimeS}s`,
        ].join('\n'),
      );
      return;
    }

    if(prompt === '/mode' || prompt.startsWith('/mode ')) {
      const arg = prompt.slice('/mode'.length).trim();
      if(arg && !MODES.includes(arg)) return void console.log(red(`error: no mode "${arg}" (${MODES.join(', ')})`));
      if(arg) setMode(arg);
      return void console.log(`mode: ${opts.mode} - ${MODE_INFO[opts.mode]}`);
    }

    if(prompt === '/verbose' || prompt === '/verbose on' || prompt === '/verbose off') {
      if(prompt !== '/verbose') setVerbose(prompt.endsWith('on'));
      tui?.drawStatus();
      return void console.log(`verbose: ${ui.verbose ? 'on' : 'off'}`);
    }

    if(prompt === '/remote-control' || prompt.startsWith('/remote-control ')) {
      const arg = prompt.slice('/remote-control'.length).trim();

      if(arg === 'off') {
        if(!control) return void console.log('(no control socket open)');
        control.close();
        control = null;
        tui?.drawStatus();
        return void console.log('(control socket closed)');
      }

      if(control) return void console.log(`(control socket already open: ${control.path}, session name: ${opts.name})`);
      startControl(arg ? resolveDir('.', arg) : undefined);
      return;
    }

    if(prompt === '/queue' || prompt.startsWith('/queue ')) {
      const arg = prompt.slice('/queue'.length).trim();
      const q = repl.queue;

      if(arg === 'clear') return void console.log(dim(`dropped ${repl.clearQueue()} queued prompt(s)`));

      const drop = /^drop\s+(\d+)$/.exec(arg);
      if(drop) {
        const gone = repl.dropQueued(+drop[1]);
        return void console.log(gone === undefined ? red(`error: no queued prompt ${drop[1]}`) : dim(`dropped: ${gone.slice(0, 60)}`));
      }

      if(arg && arg !== 'list') return void console.log('usage: /queue [list|clear|drop N]');
      return void console.log(q.length ? q.map((t, i) => `${i + 1}. ${t.length > 100 ? `${t.slice(0, 99)}…` : t}`).join('\n') : '(no prompts queued)');
    }

    if(prompt === '/rename' || prompt.startsWith('/rename ')) {
      const name = prompt.slice('/rename'.length).trim();
      if(!name) return void console.log(`(session name: ${opts.name ?? sessionName(opts)})`);
      if(!/^[\w.:@+-]+$/.test(name)) return void console.log(red('error: a session name is letters, digits and . _ : @ + - only'));
      if(listSessions().some(s => s.name === name && s.pid !== getpid())) return void console.log(red(`error: another session is already called "${name}"`));

      opts.name = name;
      control?.update({ name });
      tui?.drawStatus();
      return void console.log(`(session name: ${name}${control ? '' : ' - takes effect with /remote-control'})`);
    }

    if(prompt === '/usage') return void console.log(stats.summary());

    if(prompt === '/last' || prompt.startsWith('/last ')) {
      const n = +prompt.slice(5).trim() || 0;
      return void console.log(formatMeta(stats.get(n)));
    }

    if(prompt === '/requests' || prompt.startsWith('/requests ')) return void console.log(stats.recent(+prompt.slice(9).trim() || 10));

    if(prompt === '/gateway' || prompt.startsWith('/gateway ')) {
      if(!gateway?.enabled) return void console.log('(no freellmapi gateway: the endpoint does not answer /v1/usage)');

      const [what = 'usage', ...rest] = prompt.slice('/gateway'.length).trim().split(/\s+/).filter(Boolean);

      if(what === 'login' && gateway.isBridge) return void console.log('(a chat-bridge has no dashboard: /gateway usage, providers, forecast, limits, limited and models are its questions)');

      if(what === 'login') {
        const ok = await gateway.login({ cdp: { host: opts.cdpHost, port: opts.cdpPort, open: true } });
        if(ok) await Promise.all([gateway.refresh(true), loadProxy(true)]);
        tui?.drawStatus();
        return void console.log(ok ? `(dashboard session from ${gateway.tokenSource}: per-model quotas on)` : `(${gateway.dashboardNote})`);
      }

      const show = { usage: () => gateway.usageText(), providers: () => gateway.providersText(), forecast: () => gateway.forecastText(), quota: () => gateway.quotaText(rest.join(' ')), models: () => gateway.modelsText(rest.join(' ')), limits: () => withAvailability(av => limitsText(av, rest.join(' '))), limited: () => withAvailability(av => limitedText(av, rest.join(' '))) }[what];
      if(!show) return void console.log('usage: /gateway [usage|providers|forecast|quota [FILTER]|limits [FILTER]|limited [FILTER]|models [FILTER]|login]');

      try {
        console.log(await show());
      } catch(e) {
        console.log(red(`error: ${e.detail ?? e.message}`));
      }
      return;
    }

    if(prompt === '/model' || prompt.startsWith('/model ')) {
      let arg = prompt.slice('/model'.length).trim();

      if(!arg) return void console.log(`${opts.provider}/${opts.model} @ ${endpoint}`);

      /* openai: whatever the endpoint lists, if it lists at all (a
         chat-bridge does, with availability; plain servers may not) */
      const remote = opts.provider === 'openai' ? await client.listModels().catch(() => null) : null;
      const known = opts.provider === 'ollama' ? ollamaModels() : remote ? remote.map(m => m.name) : null;

      unavailableModels = new Set((remote ?? []).filter(m => m.available === false).map(m => m.name));
      if(remote && !gatewayRef?.enabled) modelNamesCache = remote.filter(m => m.available !== false).map(m => m.name);

      if(arg === 'list' || arg === 'list all') {
        if(remote) return void (await showModelList(remote, null, opts.provider, arg === 'list all'));
        if(known) return void (await showModelList(null, known, opts.provider, arg === 'list all'));
        return void console.log('(model list is only available for --provider ollama and openai endpoints that serve /models)');
      }

      /* /model skip [pattern] and /model unskip [pattern]: skip the active or
         last-routed model (no args) or every model matching a pattern, with a
         10m cooldown, and move on to the next non-skipped one. */
      if(arg === 'skip' || arg.startsWith('skip ') || arg === 'unskip' || arg.startsWith('unskip ')) {
        const [verb, pattern] = arg.split(/\s+/);
        const wasAuto = /^auto(:|$)/.test(opts.model);
        let target = pattern || (opts.model !== 'auto' ? opts.model : (stats.last()?.routedVia ?? stats.last()?.model ?? 'auto'));

        /* a route like kilo/nvidia/nemotron-3-ultra-550b-a55b:free names the provider row: the catalog id it belongs to */
        if(!pattern && known && !known.includes(target)) target = known.find(n => target.includes(`/${n}`)) ?? known.find(n => target.split('/').pop().startsWith(n)) ?? target;

        /* the gateway ran out of models ("All models rate-limited ... Attempt trail: kilo/x key1: rate_limit; ..."):
           a bare /model skip then drops every model of the providers that failed, not just the last one */
        let spent = verb === 'skip' && !pattern ? exhaustedPlatforms(skipError ?? stats.last()?.error) : [];

        /* "All models exhausted: 1 route checked" names no trail: the providers behind the pinned (or last routed) model are the spent ones */
        if(verb === 'skip' && !pattern && !spent.length && isExhaustedError(skipError ?? stats.last()?.error)) spent = availability?.byModel.get(target)?.platforms ?? [];
        let byProvider = 0;
        if(spent.length) {
          const names = (known ?? []).filter(m => { const ps = availability?.byModel.get(m)?.platforms ?? []; return ps.length && ps.every(p => spent.includes(p)); });
          for(const m of names) byProvider += skipModels(m, 'provider exhausted', known);
          if(byProvider) console.log(dim(`the gateway ran out of models: skipped the ${byProvider} model(s) of ${spent.join(', ')}`));
        }

        if(verb === 'skip' && byProvider) {
          /* done above */
        } else if(verb === 'skip') {
          const n = skipModels(target, 'manual', known);
          if(!n) return void console.log(red(`error: no model matches "${target}"`));
          console.log(dim(n === 1 ? skipNote(target, 'manual') : `skipped ${n} models matching "${target}": ${[...skippedModels].map(([m]) => m).join(', ')}`));
        } else {
          const n = unskipModels(target);
          if(!n) return void console.log(red(`error: "${target}" is not skipped`));
          console.log(dim(`unskipped ${n} model(s) matching "${target}"`));
          return;
        }

        /* immediately switch to the next highest-ranked non-skipped model */
        cleanupSkips();
        /* what the gateway says now: a stale picture would pin another model of the exhausted provider */
        if(gateway?.hasLimits && (!availability || Date.now() - availability.at > 5000)) availability = await loadAvailability(gateway).catch(() => availability);
        const fresh = gateway?.enabled ? await client.listModels().catch(() => remote) : remote;
        const next = getFilteredModels(known, fresh).find(m => m.name !== opts.model && m.available && !m.limited?.blocked && m.status !== 'exhausted' && (m.tools !== false || opts.noTools));
        if(next) {
          opts.model = next.name;
          client.model = next.name;
          repl.setPromptName(next.name);
          control?.update({ model: next.name });
          console.log(dim(`(switching to ${next.name})`));
        } else {
          console.log(dim('(no other model available to switch to)'));
        }
        if(wasAuto && next) console.log(waveNote('the gateway has no exclusion: skipping pins the next best model, /route auto hands the choice back'));
        return;
      }

      /* glob pattern: /model qwen* cycles through every matching model on each
         repeat, /model qwen* again picks the next one */
      if(isModelGlob(arg)) {
        const matches = modelsForGlob(arg, known);
        if(!matches.length) return void console.log(red(`error: no model matches "${arg}" (/model list shows the installed ones)`));

        /* advance within the same pattern; a fresh pattern (or one now
           matching a different set) restarts at the first match */
        if(!modelCycle || modelCycle.pattern !== arg || modelCycle.matches.join('\0') !== matches.join('\0')) {
          modelCycle = { pattern: arg, matches, index: 0 };
        } else {
          modelCycle.index = (modelCycle.index + 1) % matches.length;
        }
        arg = matches[modelCycle.index];

        const ofN = matches.length === 1 ? ' (only model matching)' : ` (${modelCycle.index + 1} of ${matches.length})`;
        console.log(`(pattern "${modelCycle.pattern}" matched: ${matches.join(', ')} - switching to ${arg}${ofN})`);
      } else {
        if(gateway?.hasLimits && (!availability || Date.now() - availability.at > 30000)) availability = await loadAvailability(gateway).catch(() => null);
        const lim = availability?.byModel.get(arg);
        if(lim?.blocked) return void console.log(red(`error: ${arg} is limited right now (${kindsText(lim)}), back: ${backText(lim, availability.at)} - /model list shows when`));

        if(gatewayRef && unavailableModels.has(arg)) return void console.log(red(`error: ${arg} has no key or is disabled in the gateway - /model list all shows such models`));

        /* only models already installed (or offered): switching never pulls one */
        if(known && !known.includes(arg) && !known.includes(`${arg}:latest`)) return void console.log(red(`error: no such model "${arg}" (/model list shows the installed ones)`));
        modelCycle = null; /* an exact switch resets any pattern cycle */
      }

      opts.model = arg;
      client.model = arg;
      repl.setPromptName(arg);
      control?.update({ model: arg });
      await updateCtxWindow();
      console.log(`(model: ${opts.provider}/${arg} - the conversation so far is kept)`);
      if(opts.provider === 'ollama') console.log(dim(await thinkNote(client)));
      return;
    }

    if(prompt === '/provider' || prompt.startsWith('/provider ')) {
      const arg = prompt.slice('/provider'.length).trim();
      if(!arg) return void console.log(`current provider: ${opts.label ?? opts.provider}`);
      if(!['ollama', 'gemini', 'openai', 'freellm', 'bridge'].includes(arg)) {
        return void console.log(red(`error: unknown provider "${arg}" (ollama, gemini, openai, freellm, bridge)`));
      }
      /* the client, endpoint and key all depend on the provider: start a new process with it */
      console.log(waveNote(`restarting with --provider ${arg}, the conversation is kept`));
      console.log(red(await restartHook({ provider: arg })));
      return;
    }

    if(prompt === '/fallback' || prompt.startsWith('/fallback ')) {
      const arg = prompt.slice('/fallback'.length).trim();
      if(!arg) {
        if(opts.fallbackModel) return void console.log(`fallback model: ${opts.fallbackModel}`);
        return void console.log('no fallback model set');
      }
      if(arg === 'off' || arg === 'none') {
        opts.fallbackModel = undefined;
        return void console.log('fallback model disabled');
      }
      opts.fallbackModel = arg;
      console.log(`fallback model set to: ${arg}`);
      return;
    }

    if(prompt === '/standby' || prompt.startsWith('/standby ')) {
      if(!gateway?.enabled) return void console.log(dim('(/standby needs a freellmapi gateway: --provider freellm)'));
      const arg = prompt.slice('/standby'.length).trim();

      const show = () => {
        const age = standby.at ? `${Math.round((Date.now() - standby.at) / 1000)}s ago` : '-';
        const lines = [waveNote(`standby  ${standby.on ? standby.state : 'off'}${standby.pinned ? ' (pinned)' : ''}`)];
        if(standby.id) lines.push(`  ${dim('model')}    ${standby.id}${standby.name && standby.name !== standby.id ? ` (${standby.name})` : ''}${standby.servedBy ? `, served by ${standby.servedBy}` : ''}`);
        if(standby.state === 'ready') lines.push(`  ${dim('probe')}    answered in ${fmtMs(standby.ms)}, tool calls ${standby.toolOk ? 'work' : 'not seen (usable as a chat model only)'}, ${age}`);
        if(standby.error) lines.push(`  ${dim('error')}    ${standby.error}`);
        if(standby.bad.size) lines.push(`  ${dim('set aside')} ${[...standby.bad.keys()].join(', ')} (failed their probe, retried in 10 min)`);
        lines.push(`  ${dim('use')}      /standby switch, spawn_agent with model "standby"; /standby probe | on | off | MODEL | auto`);
        return lines.join('\n');
      };

      if(!arg) return void console.log(show());

      if(arg === 'off') {
        standby.on = false;
        standby.state = 'off';
        return void console.log(show());
      }

      if(arg === 'switch') {
        if(!standbyReady()) return void console.log(red('error: no standby model is ready (/standby probe)'));
        const from = opts.model;
        standbyHook.switchTo(standby.id);
        console.log(`${waveNote(`switched ${from} -> ${opts.model}, the conversation is kept`)}`);
        refreshStandby(true).catch(() => {});
        return;
      }

      if(arg === 'on' || arg === 'probe' || arg === 'auto' || (arg && !['on', 'probe', 'auto'].includes(arg))) {
        standby.on = true;
        if(arg === 'auto') standby.pinned = null;
        else if(arg !== 'on' && arg !== 'probe') {
          if(unavailableModels.has(arg)) return void console.log(red(`error: ${arg} has no key or is disabled in the gateway`));
          standby.pinned = arg;
          standby.bad.delete(arg);
        }

        console.log(dim('(probing ...)'));
        await refreshStandby(true);
        return void console.log(show());
      }
    }

    if(prompt === '/skill' || prompt.startsWith('/skill ')) {
      const [first = '', ...more] = prompt.slice('/skill'.length).trim().split(/\s+/).filter(Boolean);
      const loadedNames = () => messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('(skill "')).map(m => /^\(skill "([^"]+)"/.exec(m.content)[1]);

      if(!first) {
        const all = listSkills();
        if(!all.length) return void console.log(dim(`(no skills: ${skillDirs().map(d => d.path).join(' or ')} hold SKILL.md directories)`));

        const have = new Set(loadedNames());
        const w = listWidth();
        const lines = compactTable([['skill', 'from', 'description'], ...all.map(sk => [`${have.has(sk.name) ? '● ' : ''}${sk.name}`, sk.source, sk.description || '-'])], w, 2, [28, 6, 0], (r, c, text) => (r === 0 ? `\x1b[1m${text}\x1b[0m` : c === 0 ? fgHex('#2dd4bf', text) : dim(text)));
        console.log(`${waveNote(`${all.length} skills${have.size ? `, ${have.size} loaded (●)` : ''}`)}\n${lines.join('\n')}\n${dim('/skill NAME [request] loads one, /skill off NAME unloads it')}`);
        return;
      }

      if(first === 'loaded') return void console.log(loadedNames().length ? loadedNames().join(', ') : '(no skill loaded)');

      if(first === 'off' || first === 'unload') {
        const marker = more[0] ? skillMarker(more[0]) : '(skill "';
        const before = messages.length;
        for(let i = messages.length - 1; i >= 0; i--) if(messages[i].role === 'user' && typeof messages[i].content === 'string' && messages[i].content.startsWith(marker)) messages.splice(i, 1);
        if(messages.length === before) return void console.log(dim(more[0] ? `(skill "${more[0]}" is not loaded)` : '(no skill loaded)'));
        saveSession();
        return void console.log(waveNote(`unloaded ${before - messages.length} skill${before - messages.length > 1 ? 's' : ''}`));
      }

      const sk = findSkill(first);
      if(!sk) return void console.log(red(`error: no skill "${first}" (/skill lists them)`));
      if(sk.ambiguous) return void console.log(red(`error: "${first}" matches ${sk.ambiguous.join(', ')}`));

      /* the newest copy replaces an older one, so reloading does not pile up */
      for(let i = messages.length - 1; i >= 0; i--) if(messages[i].role === 'user' && typeof messages[i].content === 'string' && messages[i].content.startsWith(skillMarker(sk.name))) messages.splice(i, 1);
      messages.push({ role: 'user', content: skillMessage(sk) });
      saveSession();
      console.log(waveNote(`skill ${sk.name} loaded (${fmtNum(sk.body.length)} chars${sk.cut ? ', cut' : ''}) from ${sk.path}`));

      /* /skill NAME request...: then the request is an ordinary prompt */
      if(more.length) return runLine(more.join(' '));
      return;
    }

    if(prompt === '/config' || prompt.startsWith('/config ')) {
      const [verb = '', key, ...value] = prompt.slice('/config'.length).trim().split(/\s+/).filter(Boolean);

      if(verb === 'set' || verb === 'unset') {
        if(!key) return void console.log(`usage: /config ${verb} KEY${verb === 'set' ? ' VALUE' : ''}   (${Object.keys(SETTINGS).join(', ')})`);
        const err = verb === 'set' ? (value.length ? setSetting(key, value.join(' ')) : `usage: /config set ${key} VALUE`) : unsetSetting(key);
        if(err) return void console.log(red(`error: ${err}`));
        return void console.log(waveNote(`${verb === 'set' ? `${key} = ${value.join(' ')}` : `${key} unset`} in ${settingsPath()}, used by the next start (a command-line option still wins)`));
      }

      if(verb) return void console.log('usage: /config [set KEY VALUE|unset KEY]');

      const saved = globalSettings();
      const rows = Object.keys(SETTINGS).map(k => [k, k in saved ? String(saved[k]) : dim('-'), String(opts[k] ?? '')]);
      return void console.log(`${waveNote(`config  ${configDir()}`)}\n${formatTable([['setting', 'saved', 'now'], ...rows])}\n${dim('settings.json holds defaults for the options, delegates.json what the sub-agent models did')}`);
    }

    if(prompt === '/delegate' || prompt.startsWith('/delegate ')) {
      const [verb = '', ...rest] = prompt.slice('/delegate'.length).trim().split(/\s+/).filter(Boolean);
      const key = id => (id.includes(':') && /^(openai|freellm|ollama|bridge|gemini):/.test(id) ? id : delegateKey(opts, id));
      const plain = id => id.replace(/^[a-z]+:/, '');
      const refreshPrompt = () => {
        if(messages[0]?.role === 'system' && messages[0].content.startsWith(SYSTEM_PROMPT)) messages[0].content = SYSTEM_PROMPT + systemNotes(opts.root);
      };

      if(verb === 'on' || verb === 'off') {
        delegates.enabled = verb === 'on';
        refreshPrompt();
        return void console.log(waveNote(`delegation ${verb}${verb === 'on' ? '' : ': the model is no longer told it may delegate, spawn_agent still works'}`));
      }

      if(verb === 'add') {
        if(!rest[0]) return void console.log('usage: /delegate add MODEL [docs|build|summary|repetitive|other ...]  (the kinds it is pinned for)');
        const kinds = rest.slice(1).filter(k => KINDS.includes(k));
        delegates.add(key(rest[0]), kinds);
        delegateCache.at = 0;
        return void console.log(waveNote(`${rest[0]} is a delegate${kinds.length ? ` for ${kinds.join(', ')}` : ''}`));
      }

      if(verb === 'remove' || verb === 'ban' || verb === 'unban') {
        if(!rest[0]) return void console.log(`usage: /delegate ${verb} MODEL`);
        if(verb === 'remove') delegates.remove(key(rest[0]));
        else delegates.ban(key(rest[0]), verb === 'ban');
        delegateCache.at = 0;
        return void console.log(waveNote(`${rest[0]} ${verb === 'remove' ? 'removed from the delegates set by hand' : verb === 'ban' ? 'will not get delegated work' : 'may get delegated work again'}`));
      }

      if(verb === 'pin') {
        if(!KINDS.includes(rest[0])) return void console.log(`usage: /delegate pin ${KINDS.join('|')} [MODEL]  (no MODEL unpins)`);
        delegates.pin(rest[0], rest[1] ? key(rest[1]) : null);
        return void console.log(waveNote(rest[1] ? `${rest[1]} leads for ${rest[0]}` : `${rest[0]} is chosen by memory again`));
      }

      if(verb === 'good' || verb === 'bad') {
        const target = rest[0] ? { id: key(rest[0]), kind: rest[1] && KINDS.includes(rest[1]) ? rest[1] : lastDelegate?.kind ?? 'other' } : lastDelegate;
        if(!target) return void console.log(red('error: no delegated run yet (or name a model: /delegate good MODEL [KIND])'));
        delegates.vote(target.id, target.kind, verb === 'good' ? 1 : -1);
        return void console.log(waveNote(`noted: ${plain(target.id)} did ${verb} work for ${target.kind}`));
      }

      if(verb === 'forget') {
        delegates.forget();
        return void console.log(waveNote('the memory of delegated runs is cleared (set-by-hand delegates stay)'));
      }

      if(verb) return void console.log('usage: /delegate [on|off|add MODEL [KIND..]|remove MODEL|pin KIND [MODEL]|ban MODEL|unban MODEL|good|bad|forget]');

      const cands = await delegateCandidates(opts);
      const lines = [waveNote(`delegation  ${delegates.enabled ? (delegateNotesOn ? 'on, the model is told it may delegate' : 'on, but off for this provider or mode') : 'off'}`)];

      for(const kind of KINDS) {
        const ranked = delegates.rank(kind, cands.map(id => delegateKey(opts, id))).slice(0, 3);
        lines.push(`  ${dim(kind.padEnd(11))}${ranked.length ? ranked.map(r => `${plain(r.id)}${r.pinned ? ' (pinned)' : ''}${r.tried ? ` ${r.ok}/${r.ok + r.fail}` : ''}`).join(', ') : '(no candidate: the primary model does it itself)'}`);
      }

      const peerList = findPeers({ root: opts.root, selfPid: getpid(), all: true });
      lines.push(`  ${dim('workers'.padEnd(11))}${peerList.length ? peerList.map(p => `${p.name} (${p.provider}/${p.model}${p.worker ? '' : ', not a worker: no /reset'})`).join(', ') : `(none on this project: ollama-repl --worker --provider gemini --root ${opts.root})`}`);

      const mem = memoryLines(delegates, fmtMs);
      if(mem.length) lines.push('', dim('memory:'), ...mem.map(l => `  ${l}`));
      if(delegates.data.banned.length) lines.push('', `${dim('banned')}  ${delegates.data.banned.map(plain).join(', ')}`);
      lines.push('', dim(`candidates are found on the ${opts.provider === 'openai' ? 'gateway' : 'Ollama host'}: reliable, fast, tool-capable, not the strongest; /delegate add MODEL pins your own. File: ${configDir()}/delegates.json`));
      return void console.log(lines.join('\n'));
    }

    if(prompt === '/restart') {
      console.log(waveNote('restarting with the current session state'));
      console.log(red(await restartHook()));
      return;
    }

    if(prompt === '/route' || prompt.startsWith('/route ')) {
      const arg = prompt.slice('/route'.length).trim();
      if(!gateway?.enabled) return void console.log(dim('(/route needs a gateway that routes: --provider freellm, or a chat-bridge)'));

      const last = stats.last();
      const sticky = opts.sessionId ? `x-session-id ${opts.sessionId}` : '-';

      if(!arg) {
        const axis = /^auto:(smart|fast|cheap|reliable|balanced)$/.exec(opts.model)?.[1];
        const mode = opts.model === 'auto' ? 'the active fallback chain' : axis ? `all models, ${ROUTE_AXES.find(([n]) => n === axis)[1]}` : opts.model.startsWith('auto:') ? `profile "${opts.model.slice(5)}"` : 'pinned: only this model, no failover to others';
        return void console.log([
          `${waveNote(`routing  ${opts.model}`)}`,
          `  ${dim('means')}    ${mode}`,
          `  ${dim('last')}     ${last ? `${routeLine(last.meta ?? last)}${last.fallbacks ? ` (${last.fallbacks} fallback${last.fallbacks > 1 ? 's' : ''} before it)` : ''}` : '(no reply yet)'}`,
          `  ${dim('sticky')}   ${sticky}`,
          `  ${dim('change')}   /route list, /route smart|fast|cheap|reliable|balanced|auto, /route profile NAME, /route MODEL`,
        ].join('\n'));
      }

      const remote = await client.listModels().catch(() => []);

      if(arg === 'list') {
        const profiles = remote.filter(m => m.name.startsWith('auto:'));
        const rows = [['route', 'what it does', 'now']];
        rows.push(['auto', 'the gateway\'s active fallback chain', opts.model === 'auto' ? '◀' : '']);
        for(const [name, text] of ROUTE_AXES) rows.push([`/route ${name}`, text, opts.model === `auto:${name}` ? '◀' : '']);
        for(const m of profiles.filter(m => !ROUTE_AXES.some(([n]) => `auto:${n}` === m.name))) rows.push([`/route profile ${m.name.slice(5)}`, `named chain${m.available ? '' : ' (nothing can serve it now)'}`, opts.model === m.name ? '◀' : '']);
        rows.push(['/route MODEL', 'pin one model; no failover to others', !opts.model.startsWith('auto') && opts.model !== 'fusion' ? '◀' : '']);
        return void console.log(formatTable(rows));
      }

      if(arg === 'new') {
        opts.sessionId = `ollama-repl-${Date.now().toString(36)}-${getpid().toString(36)}`;
        client.extraHeaders = { 'x-session-id': opts.sessionId };
        return void console.log(waveNote(`sticky routing restarts: ${opts.sessionId}`));
      }

      const target = routeTarget(arg);
      const ok = target === 'auto' || target === 'fusion' || remote.some(m => m.name === target) || ROUTE_AXES.some(([n]) => `auto:${n}` === target);
      if(!ok) return void console.log(red(`error: the gateway does not list "${target}" (/route list; a profile is /route profile NAME)`));

      opts.model = client.model = target;
      repl.setPromptName(target);
      control?.update({ model: target });
      await updateCtxWindow();
      return void console.log(waveNote(`routing: ${target}${!target.startsWith('auto') && target !== 'fusion' ? ' (pinned, the gateway will not switch to another model)' : ''}`));
    }

    if(prompt === '/compact' || prompt.startsWith('/compact ')) {
      const keep = prompt.slice('/compact'.length).trim();
      await compactHook(messages, { force: true, keepTurns: keep ? +keep : undefined });
      return;
    }

    if(prompt === '/tools') {
      console.log(TOOLS.map(t => wrapHanging((t.function?.name ?? t.name).padEnd(14) + ' ', (t.function?.description ?? t.description ?? '').split('\n')[0])).join('\n'));
      return;
    }

    if(prompt === '/system' || prompt.startsWith('/system ')) {
      const arg = prompt.slice('/system'.length).trim();
      const has = messages[0]?.role === 'system';
      const defaultPrompt = SYSTEM_PROMPT + systemNotes(opts.root);

      if(!arg) return void console.log(has ? messages[0].content : '(no system prompt)');

      let text;
      let m;
      if(arg === 'off') text = null;
      else if((m = /^default(?:\s+(\d+)(?:-(\d+))?)?$/.exec(arg))) {
        /* optionally only lines start[-end] (1-based) of the default prompt */
        const lines = defaultPrompt.split('\n');
        text = m[1] ? lines.slice(m[1] - 1, m[2] ? +m[2] : +m[1]).join('\n') : defaultPrompt;
      } else if(arg.startsWith('file ')) {
        text = loadFile(arg.slice(5).trim());
        if(text === null) return void console.log(red(`error: cannot read ${arg.slice(5).trim()}`));
      } else if(arg.startsWith('+')) text = (has ? messages[0].content + '\n' : '') + arg.slice(1).trim();
      else text = arg;

      if(has) {
        if(text === null) {
          messages.shift();
          baseMessageCount = Math.max(0, baseMessageCount - 1);
        } else messages[0].content = text;
      } else if(text !== null) {
        messages.unshift({ role: 'system', content: text });
        baseMessageCount++;
      }

      saveSession();
      console.log(text === null ? '(system prompt removed)' : `(system prompt set: ${text.length} chars)`);
      return;
    }

    if(prompt === '/stream' || prompt === '/stream on' || prompt === '/stream off') {
      if(prompt !== '/stream') opts.stream = prompt.endsWith('on');
      console.log(`streaming: ${opts.stream ? 'on' : 'off'}`);
      return;
    }

    if(prompt === '/files') {
      console.log(fileExchange.dump());
      return;
    }

    if(prompt === '/context') {
      if(opts.debug) console.log(messages);
      else console.log(`context: ${messages.length} messages, ${totalChars(messages)} chars\n${summarizeMessages(messages)}`);
      return;
    }

    if(prompt === '/log') {
      const turns = messages.slice(baseMessageCount);
      if(opts.debug) console.log(turns);
      else console.log(turns.length ? summarizeMessages(turns) : '(no conversation yet)');
      return;
    }

    if(prompt === '/export') {
      const transcript = renderExport(messages.slice(baseMessageCount)) || '(empty conversation)';

      const k = await repl.choose('Select export method', ['Copy to clipboard', 'Save to file']);

      if(k === 0) {
        const tool = pickClipboardTool();
        if(!tool) return void console.log(red('(no clipboard tool found: install wl-clipboard (wl-copy), xclip, xsel or pbcopy, or pick "Save to file")'));

        const p = popen(tool === 'wl-copy' ? 'wl-copy' : tool === 'xclip' ? 'xclip -selection clipboard' : tool === 'xsel' ? 'xsel --clipboard --input' : 'pbcopy', 'w');
        p.puts(transcript);
        p.close();
        console.log(`\x1b[32m✓ Conversation copied to clipboard\u001b[0m (${tool})`);
        return;
      }

      const ts = new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '');
      const name = sessionName(opts).replaceAll(/[:/]/g, '-');
      const path = `${getcwd()[0]}/${ts}-${name}.txt`;
      const f = fopen(path, 'w');
      if(!f) return void console.log(red(`(cannot write ${path})`));

      f.puts(transcript);
      f.close();
      console.log(`\x1b[32m✓ Conversation exported to:\u001b[0m ${path}`);
      return;
    }

    if(prompt.startsWith('/js ')) {
      repl.evalAndPrintStart(prompt.slice('/js '.length).trim());
      return;
    }

    if(prompt.startsWith('!')) {
      const cmd = prompt.slice(1).trim();
      if(!cmd) return;

      const { output, status, timedOut } = await runCommand(cmd, { cwd: opts.root });
      console.log(`(exit ${status}${timedOut ? ', timed out' : ''})`);
      console.log(output || '(no output)');

      /* Send the output to the model as a tool result, explicitly telling it
         which command was run and that its output (stdout+stderr, merged)
         now follows, so it can react to it. */
      const turnMsg = { role: 'user', content: prompt };
      messages.push(turnMsg);
      messages.push({ role: 'tool', name: 'run_command', toolCallId: '!-user', content: `The user ran the shell command: ${cmd}\nIts output (stdout and stderr merged) follows:\n\n${output || '(no output)'}` });
      log.toolResults(`$ ${cmd}\n${output || '(no output)'}`);

      /* The command output is now in the conversation as a tool result, so
         run a model round right away and let it react to it. */
      let reply;
      try {
        reply = await runToolLoop(client, messages, opts, log, confirmRun, askUser, abortRef, forEach);
      } catch(e) {
        console.log(red(`error: ${e.message}`));
        rollbackTurn(messages, turnMsg); // don't leave a dangling/partial turn behind
        return;
      }
      saveSession();
      return;
    }

    if(prompt.startsWith('/run ')) {
      const cmd = prompt.slice('/run '.length).trim();
      if(!cmd) return;

      const { output, status, timedOut } = await runCommand(cmd, { cwd: opts.root });
      console.log(`(exit ${status}${timedOut ? ', timed out' : ''})`);
      console.log(output || '(no output)');
      return;
    }

    if(opts.failsafe) {
      log.prompt(prompt, []);

      const turnMsg = { role: 'user', content: prompt };
      messages.push(turnMsg);

      let reply;
      try {
        ({ content: reply } = await chatRound(client, messages, opts, abortRef));
      } catch(e) {
        console.log(red(`error: ${e.message}`));
        rollbackTurn(messages, turnMsg); // don't leave a dangling/partial turn behind
        return;
      }

      messages.push({ role: 'assistant', content: reply });
      log.reply(reply);
      saveSession();
      return;
    }

    let forceBinding = false;
    let effectivePrompt = prompt;
    if(prompt.startsWith('/binding ')) {
      forceBinding = true;
      effectivePrompt = prompt.slice('/binding '.length).trim();
      if(!effectivePrompt) return;
    }

    const { text: withFiles, attached } = attachFiles(effectivePrompt, opts.root, fileExchange);
    log.prompt(effectivePrompt, attached);

    let finalText = withFiles;
    if(forceBinding || looksLikeBindingPrompt(effectivePrompt)) {
      const { text: bindingText, attached: bindingAttached } = bindingContext(opts.root);
      if(bindingText) {
        console.log(dim(`(attached binding reference: ${bindingAttached.join(', ')})`));
        finalText = `${finalText}\n\n${bindingText}`;
      }
    }

    /* a small model told only "every function" tends to narrate a plan or
       start doing them one by one in a single context - say how to do it */
    if(opts.mode === 'plan') finalText += PLAN_NOTE;
    if(opts.mode !== 'plan' && /\b(every|each|all)\b/i.test(effectivePrompt)) console.log(dim('(added to the prompt: use for_each for a repeated job)'));
    if(opts.mode !== 'plan' && /\b(every|each|all)\b/i.test(effectivePrompt)) finalText += '\n\n(This job repeats over many things: list ALL of the items the request names (e.g. every function declared in the header - not only the files attached above) and call for_each once - do not do them yourself one by one, and do not just describe a plan.)';

    const turnMsg = { role: 'user', content: finalText, request: effectivePrompt };
    messages.push(turnMsg);

    let reply;
    try {
      reply = await runToolLoop(client, messages, opts, log, confirmRun, askUser, abortRef, forEach);
    } catch(e) {
      console.log(red(`error: ${e.message}`));
      rollbackTurn(messages, turnMsg); // don't leave a dangling/partial turn behind
      return;
    }

    const written = await applyFileBlocks(reply, opts.root, sentFiles, fileExchange);
    log.modified(written);
    saveSession();
    if(split.mode === 'git') await refreshGit();
  };

  /* the git pane's text, colored */
  async function refreshGit() {
    const { output, status } = await runCommand('git -c color.ui=always diff --stat && git -c color.ui=always diff', { cwd: opts.root });
    split.git = status === 0 ? output.trimEnd() : `(not a git repository: ${opts.root})`;
    tui?.drawPane();
  }

  /* in the TUI the output of a report command becomes one panel, control
     clients get the plain text as before */
  const reportLine = async line => {
    const prompt = line.trim();
    const name = /^\/[a-z-]+/.exec(prompt)?.[0];
    if(!tui?.active || !REPORT_COMMANDS.has(name)) return runLine(line);

    const puts = stdout.puts;
    let text = '';

    stdout.puts = s => ((text += s), true);
    try {
      await runLine(line);
    } finally {
      stdout.puts = puts;
    }

    if(!text.trim()) return;
    control?.output(stripAnsi(text));

    const n = keepPanel(prompt, text);
    tui.write(reportPanel(prompt.length > 40 ? prompt.slice(0, 39) + '…' : prompt, text, tui.width, { max: Math.max(6, tui.rows - 12), more: k => `… ${k} more lines · /view ${n} shows all` }) + '\n');
  };

  repl = new ChatREPL(opts.model, reportLine, opts.root, () => abortRef.current?.() ?? false);

  /* commands that only flip a flag or show something do not wait for the running request: typed while the
     model works they act at once (output goes straight to the transcript, not into a panel, because a panel
     captures stdout and would swallow the streamed reply). Piped input keeps its order. */
  if(!piped) {
    const INSTANT = [/^\/verbose(\s|$)/, /^\/proxy(\s+(on|off))?$/, /^\/(help|status|usage|about|tools|mode|last|requests)(\s|$)/, /^\/gateway(\s+(usage|providers|forecast|quota|limits|limited|models)\b.*)?$/, /^\/standby(\s+off)?$/, /^\/delegate(\s+(on|off))?$/, /^\/config$/, /^\/skill(\s+loaded)?$/, /^\/rename\s/, /^\/queue(\s|$)/];
    repl.immediate = line => INSTANT.some(re => re.test(line.trim()));
    repl.onImmediate = runLine;
  }

  if(tui) {
    repl.tui = tui;
    repl.pagerHeader = (cols, label) => gradientRule(cols, label);
    repl.addCleanupHandler(() => tui.close());
  }

  repl.argCompleter = completeArgs;
  repl.commandNames = [...new Set([...HELP_TEXT.matchAll(/(?:^|, )(\/[a-z]+)/gm)].map(m => m[1]))].sort();

  /* a key press outside the TUI has no status line: say it in one line and draw the prompt again */
  const keyNote = text => {
    if(tui?.active) return tui.drawStatus();
    console.log(`\n${dim(text)}`);
    repl.readlinePrintPrompt();
    repl.update();
  };

  repl.onCycleMode = () => {
    setMode(nextMode(opts.mode));
    keyNote(`(mode: ${opts.mode} - ${MODE_INFO[opts.mode]})`);
  };

  repl.onToggleVerbose = () => {
    setVerbose(!ui.verbose);
    keyNote(`(verbose: ${ui.verbose ? 'on' : 'off'})`);
  };

  /* everything the REPL prints (console.log goes through it too) is
     copied to the clients of the control socket, once one is open */
  const puts = stdout.puts.bind(stdout);
  stdout.puts = s => {
    control?.output(s);
    return puts(s);
  };

  repl.onIdle = () => control?.event({ type: 'ready' });
  repl.onPrompt = (kind, text) => control?.event({ type: 'waiting', kind, text });
  repl.addCleanupHandler(() => control?.close());
  repl.addCleanupHandler(() => restarting || removeSnapshot());

  /* auto-compaction and /compact: replaces the older turns of a conversation by a summary
     (lib/handoff.js, written by a local model) and keeps the last few verbatim. Auto only
     fires once the window is known and `compactAt` percent of it is in use, and not again
     until the conversation has grown noticeably, so a conversation that stays large
     (one huge recent turn) is not re-summarized every round. */
  const compactedAt = new WeakMap();
  let compacting = false;

  compactHook = async (msgs, { force = false, keepTurns } = {}) => {
    if(compacting) return;

    const used = estimateTokens(msgs);
    if(!force) {
      if(!ctxWindowNow || !opts.compactAt || used < (ctxWindowNow * opts.compactAt) / 100) return;
      if(compactedAt.has(msgs) && totalChars(msgs) < compactedAt.get(msgs) + 20000) return;
    }

    compacting = true;
    try {
      const base = msgs === messages ? baseMessageCount : msgs[0]?.role === 'system' ? 1 : 0;
      const before = totalChars(msgs);
      const model = opts.handoffModel ?? HANDOFF_MODEL;
      if(!opts.quiet) console.log(waveNote(`compacting: ~${fmtNum(used)} tokens${ctxWindowNow ? ` of ${fmtNum(ctxWindowNow)}` : ''}, summarizing older turns with ${model} ...`));

      const h = await buildHandoff(msgs, base, { keepTurns: keepTurns ?? opts.handoffTurns ?? 3, model, host: opts.host, port: opts.port, reason: 'compact' });
      if(!h) {
        if(force) console.log(waveNote('nothing to compact'));
        return;
      }

      const count = msgs.length;
      msgs.splice(0, msgs.length, ...h.messages);
      compactedAt.set(msgs, totalChars(msgs));
      if(msgs === messages) saveSession();
      console.log(waveNote(`compacted: ${fmtNum(before)} -> ${fmtNum(totalChars(msgs))} chars, ${count} -> ${msgs.length} messages, ${h.cut} older ones summarized by ${h.by}, the last turns kept`));
    } finally {
      compacting = false;
    }
  };

  /* /restart, /provider and the restart_harness tool: give the terminal back, run the new
     process in the foreground, leave with its status */
  restartHook = async overrides => {
    const r = await prepareRestart(opts, messages, baseMessageCount, overrides);
    if(typeof r === 'string') return r;

    if(r.moved) console.log(waveNote(`restarting from the source tree ${r.moved} (this session runs the installed copy, which does not see its edits)`));

    const started = Date.now();
    restarting = true;
    for(const handler of repl.cleanupHandlers) handler.call(repl);

    let code = exec(r.argv, { block: true });

    /* the edited harness died at startup (not a signal, not a quit): run the version this one started from */
    if(code > 0 && code < 128 && Date.now() - started < 15000 && r.fallback) {
      console.log(waveNote(`the restarted harness failed after ${Math.round((Date.now() - started) / 1000)}s (status ${code}), running the previous version`));
      code = exec(r.fallback, { block: true });
    }

    rmSync(r.backup, { force: true });
    removeSnapshot();
    purgeSnapshots();
    exit(code);
  };

  /* the control socket, from --listen or later from /remote-control */
  startControl = path => {
    const name = sessionName(opts);
    opts.name = name;
    control = new ControlSocket(
      { name, model: opts.model, provider: opts.provider, root: opts.root, cwd: getcwd()[0], mode: opts.mode, worker: !!opts.worker },
      line => {
        // as if typed: shown on the terminal so the user sees who asked
        if(!tui?.active) console.log(`${piped ? '' : '\r\x1b[K'}${green(`[remote]> ${line}`)}`);
        repl.handleCmd(line, 'remote');
      },
      () => repl.busy,
      path,
    );

    try {
      control.start();
    } catch(e) {
      console.log(red(`error: ${e.message}`));
      control = null;
      return false;
    }

    tui?.drawStatus();
    console.log(dim(`(control socket: ${control.path}, session name: ${name} - ollama-repl-ctl -s ${name} send ...)`));
    return true;
  };

  /* a --listen that cannot be honoured ends the run: whatever should have attached would wait for nothing */
  if(opts.listen !== undefined && !startControl(opts.listen || undefined)) exit(1);

  /* over a chat-bridge, a pinned site that hits its limit hands the turn to the
     next available one by itself, with a compacted conversation (lib/failover.js);
     auto is routed by the bridge */
  if(gateway?.isBridge && !opts.noFailover) {
    const failover = new Failover(client);

    failoverHook = {
      failover,
      handoff: async (msgs, callOpts) => {
        const base = msgs === messages ? baseMessageCount : msgs[0]?.role === 'system' ? 1 : 0;
        if(!callOpts.quiet) console.log(dim(`(handoff: summarizing older turns with ${opts.handoffModel ?? HANDOFF_MODEL} ...)`));

        const h = await buildHandoff(msgs, base, { keepTurns: opts.handoffTurns ?? 3, model: opts.handoffModel ?? HANDOFF_MODEL, host: opts.host, port: opts.port });
        if(!h) return;

        const before = msgs.length;
        msgs.splice(0, msgs.length, ...h.messages);
        if(msgs === messages) saveSession();
        if(!callOpts.quiet) console.log(dim(`(handoff: ${before} -> ${msgs.length} messages, ${h.cut} older ones summarized by ${h.by}, the last turns kept)`));
      },
      onSwitch: name => {
        opts.model = name;
        client.model = name;
        repl.setPromptName(name);
        control?.update({ model: name });
        updateCtxWindow();
      },
    };
  }

  repl.addCleanupHandler(() => {
    saveSession();
    log.close();
    client.destroy();
    bridgeProc?.stop();
  });

  queuedPrompts = () => repl.queue;
  repl.onQueue = () => saveSession();

  /* the prompts that were still waiting when the session was saved run again, in their order */
  if(pendingQueue.length)
    setTimeout(() => {
      console.log(dim(`(${pendingQueue.length} queued prompt${pendingQueue.length > 1 ? 's' : ''} restored from the saved session: /queue shows them, /queue clear drops them)`));
      repl.restoreQueue(pendingQueue);
    }, 0);

  await repl.run();
}

await main();
