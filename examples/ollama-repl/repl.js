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
import { exit, getenv, loadFile, popen, out as stdout, err as stderr } from 'std';
import { clearTimeout, getcwd, getpid, isatty, realpath, setTimeout, stat, readdir, S_IFDIR } from 'os';
import { OllamaClient } from './lib/ollama-client.js';
import { GeminiClient } from './lib/gemini-client.js';
import { OpenAIClient } from './lib/openai-client.js';
import { Failover, failoverNote } from './lib/failover.js';
import { buildHandoff, HANDOFF_MODEL } from './lib/handoff.js';
import { startBridge, pickModel } from './lib/bridge-process.js';
import { extractFileRefs, formatFileBlocks, SOURCE_EXT } from './lib/file-refs.js';
import { saveAllBlocks } from './lib/file-blocks.js';
import { TOOLS, executeTool, resetJournal, undoJournal, writeCount } from './lib/tool-requests.js';
import { looksLikeBindingPrompt, bindingContext } from './lib/binding-context.js';
import { fileMode, SKIP_DIRS } from './lib/match.js';
import { ChatREPL } from './lib/chat-repl.js';
import { ControlSocket, listSessions } from './lib/control-socket.js';
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
import { Tui } from './lib/tui.js';
import { exitIp, measure, newExit, proxied, proxySettings } from './lib/proxy-probe.js';
import { PORT_NAMES, ownSockets, processInfo } from './lib/resources.js';
import { MarkdownStream } from './lib/markdown.js';
import { done as doneQuip, quip } from './lib/quips.js';
import { banner, gradientRule, helpPanel, numberedDiff, toolLine, toolResult, meter, modeBadge, panel, reportPanel, shortPath, WARN as WARN_BORDER } from './lib/look.js';
import { keyValue, statusBar, stripAnsi } from 'terminal';
import { piped, dim, red, green, wrapHanging } from './lib/ansi.js';

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
  const opts = { mode: DEFAULT_MODE, provider: 'ollama', model: undefined, host: 'localhost', port: 11434, root: '.', stream: false, debug: false, failsafe: false, numCtx: 16384, temperature: 0.2, maxRounds: DEFAULT_MAX_ROUNDS, yes: false, listen: undefined, noSystem: false, name: undefined, think: 'detect' };

  for(let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if(arg === '--provider') opts.provider = argv[++i];
    else if(arg === '--model') opts.model = argv[++i]?.trim(); // trim() also drops a pasted no-break space
    else if(arg === '--host') opts.host = argv[++i];
    else if(arg === '--port') opts.port = +argv[++i];
    else if(arg === '--root') opts.root = argv[++i];
    else if(arg === '--no-failover') opts.noFailover = true;
    else if(arg === '--no-tools') opts.noTools = true;
    else if(arg === '--no-tui') opts.noTui = true;
    else if(arg === '--scan') opts.scan = true;
    else if(arg === '--allow-paid') opts.allowPaid = true;
    else if(arg === '--no-handoff') opts.noHandoff = true;
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

  opts.modelGiven = opts.model !== undefined;

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
/* set by main() when the endpoint is a chat-bridge: { failover, onSwitch } */
let failoverHook = null;

/* lib/tui.js layout, set by main() on a terminal unless --no-tui */
let tui = null;

/* view switches: verbose (Ctrl-O) shows reasoning, full tool results and
   every request/response */
const ui = { verbose: false };

/* set by main(): asks the user to allow a file change (manual mode) */
let approveWrite = null;

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
function showPanel(title, text, opts = {}) {
  const n = keepPanel(title, text);
  console.log(panel(title, text, tui.width, { max: Math.max(6, Math.floor(tui.rows / 2) - 4), more: k => `… ${k} more lines · /view ${n} shows all`, ...opts }));
}

/* how many messages of a conversation the verbose request panel has shown */
const shownMessages = new WeakMap();

const ROLE_COLOR = { system: '#2dd4bf', user: '#fbbf24', assistant: '#a3e635', tool: '#c084fc' };

/** messages as text for a panel: a colored role line, then the content */
function messagesText(msgs) {
  return msgs
    .map(m => {
      const head = `\x1b[1;38;2;${(ROLE_COLOR[m.role] ?? '#ffffff').match(/\w\w/g).map(h => parseInt(h, 16)).join(';')}m${m.role}${m.name ? ` ${m.name}` : ''}\x1b[0m`;
      const calls = (m.toolCalls ?? m.tool_calls ?? []).map(tc => `→ ${tc.name ?? tc.function?.name}(${JSON.stringify(tc.args ?? tc.function?.arguments ?? {})})`);
      return [head, ...(typeof m.content == 'string' ? [m.content] : m.content ? [JSON.stringify(m.content)] : []), ...calls].join('\n');
    })
    .join('\n\n');
}

/** a path the model gave, relative to root */
const underRoot = (root, p) => (String(p ?? '').startsWith('/') ? p : `${root}/${p}`);

async function chatRound(client, messages, opts, abortRef, chatOptions = {}) {
  const tried = new Set([client.model]);

  for(;;) {
    try {
      return await chatRoundOnce(client, messages, opts, abortRef, chatOptions);
    } catch(e) {
      if(!failoverHook || !Failover.applies(e)) throw e;

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

  const verbose = ui.verbose && !opts.quiet;
  const panes = verbose && tui?.active;

  /* TUI verbose: what goes out, the messages new since the last request */
  if(panes) {
    const from = shownMessages.get(messages) ?? 0;
    shownMessages.set(messages, messages.length);
    showPanel(`→ ${client.model} · ${messages.length} messages, ${fmtNum(totalChars(messages))} chars, ${chatOptions.tools?.length ?? 0} tools${from ? `, ${messages.length - from} new` : ''}`, messagesText(messages.slice(from)) || '(nothing new)', { border: '#c084fc' });
  } else if(verbose) console.log(dim(`-> ${client.model}: ${messages.length} messages, ${fmtNum(totalChars(messages))} chars, ${chatOptions.tools?.length ?? 0} tools${opts.stream ? ', streamed' : ''}${chatOptions.toolChoice ? `, tool_choice ${chatOptions.toolChoice}` : ''}`));

  /* verbose: reasoning text as it streams, dim, before the reply */
  let thinking = false;
  let reasoning = '';

  /* TUI verbose: the reasoning as one panel, before the reply */
  const showReasoning = () => {
    if(reasoning) showPanel('◌ reasoning', `\x1b[2m${reasoning.trim()}\x1b[0m`, { border: '#64748b' });
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
    if(panes) return showPanel(`← ${m.status ?? '-'} ${routeName(m)}${m.provider ? ` via ${m.provider}` : ''} · ${fmtMs(m.ms)}`, formatMeta({ ...m, reasoning: result.reasoning }), { border: '#c084fc' });
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
          stdout.puts(`\n${opts.label ?? opts.provider}> `);
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
    if(result.content && !opts.quiet) console.log(`\n${opts.label ?? opts.provider}> ${piped ? result.content : new MarkdownStream().push(result.content + '\n')}\n`);
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
  let repeatRounds = 0;
  const writesAtStart = writeCount; // this loop's own changes, not an earlier item's

  for(let round = 0; ; round++) {
    const final = round >= opts.maxRounds - 1 || repeatRounds >= MAX_REPEAT_ROUNDS;
    elideOldToolResults(messages, opts.numCtx);
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

      if(seen > 0) {
        repeats++;
        const output = `error: you already made this exact ${tc.name} call (${seen}x) - repeating it will not change the result. Try a different approach (different arguments, read_file to re-check the current contents first) or stop and explain what is blocking you.`;
        if(!opts.quiet) console.log(dim(`(repeated ${tc.name} call skipped)`));
        log.toolResults(`${tc.name}(${JSON.stringify(tc.args)})\n${output}`);
        messages.push({ role: 'tool', name: tc.name, toolCallId: tc.id, content: output });
        continue;
      }

      let output;
      const asked = needsApproval(opts.mode, tc.name);

      if(tui?.active && !opts.quiet) {
        if(ui.verbose) showPanel(`⚙ ${tc.name}`, JSON.stringify(tc.args ?? {}, null, 2), { border: '#c084fc' });
        else console.log(toolLine(tc.name, tc.args ?? {}));
      }

      /* the mode may have changed since the tools were offered (Shift-Tab mid-turn) */
      if(!toolAllowed(opts.mode, tc.name)) output = `error: ${tc.name} is not available in ${opts.mode} mode - only read the code and answer with a plan`;
      else if(needsApproval(opts.mode, tc.name) && tc.name !== 'run_command' && !(await approveWrite?.(describeWrite(tc.name, tc.args ?? {}), tc.name, tc.args ?? {}))) output = '(declined by the user - nothing was changed)';
      else {
        setPhase('tool', { tool: tc.name });
        const stop = tui?.active && !opts.quiet ? tuiSpinner(`running ${tc.name}`) : () => {};
        try {
          output = await executeTool(tc.name, tc.args, opts.root, confirmRun, askUser, forEach);
        } finally {
          stop();
          setPhase('idle');
        }
      }

      if(WRITE_TOOLS.has(tc.name) && !/^(error|\(declined)/.test(output ?? '')) {
        changes.push({ title: `${tc.name} ${tc.args?.path ?? ''}`, diff: numberedDiff(tc.name, tc.args ?? {}, loadFile(underRoot(opts.root, tc.args?.path)), true), at: Date.now() });
        if(split.mode === 'diff') tui?.drawPane();
      }

      /* TUI: a file change as a numbered diff, anything else as one summary line */
      if(tui?.active && !opts.quiet && !ui.verbose) {
        if(WRITE_TOOLS.has(tc.name) && !asked && !/^(error|\(declined)/.test(output)) showPanel(`✔ ${tc.name} ${tc.args?.path ?? ''}`, numberedDiff(tc.name, tc.args ?? {}, loadFile(underRoot(opts.root, tc.args?.path)), true), { border: '#4ade80' });
        else console.log(toolResult(output));
      }

      if(ui.verbose && !opts.quiet && tui?.active) showPanel(`⎿ ${tc.name} result · ${output.split('\n').length} lines, ${output.length} chars`, output || '(empty)', { border: /^error/.test(output) ? '#f87171' : '#c084fc' });
      else if(ui.verbose && !opts.quiet) {
        const lines = output.split('\n');
        console.log(dim(`[${tc.name} result, ${output.length} chars]\n${lines.slice(0, 200).join('\n')}${lines.length > 200 ? `\n... (${lines.length - 200} more lines)` : ''}`));
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

/** Total char count across `msgs` - a rough proxy for outgoing request
    size (see DEMO.md 5 on why this is a diagnostic, not a target), shown
    alongside the message count in /context. */
function totalChars(msgs) {
  return msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
}

const HELP_TEXT = `/reset          - clear conversation history (keeps the initial project scan)
/clear          - wipe conversation history completely, including the initial project scan
/cd DIR         - change the project directory (~, ~user, - for the previous one) the model works in (file refs, writes, run_command all follow it)
/exit, /quit    - quit
/help           - this text
/split [diff|git|status|off] - a pane right of the transcript: this session's file changes as diffs (default), git diff of the project, or the live status (what happens now, the request, sockets with their traffic, memory). /split alone toggles
/proxy [probe|exit] - the socks proxy the gateway sends upstream requests through: settings, latency it adds (probe measures direct vs proxied, 3 runs each), time to first byte per platform; exit asks for a new exit (tor-change-exitnode.sh) and measures again
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
/rename NAME    - rename the session (ollama-repl-ctl -s NAME picks it)
/model [NAME|list] - show the provider/model/endpoint in use; switch to another installed model (conversation kept) or list them
/usage          - tokens and requests of this session, per routed model and platform
/last [N]       - everything known about the last request (or request #N of /requests): route, provider, request id, tokens, timings, fallbacks
/requests [N]   - the last N (10) requests of this session, one line each
/gateway [usage|providers|forecast|quota [FILTER]|models [FILTER]|login] - ask the freellmapi gateway: month usage of all clients, upstream health, provider quotas, per-model quotas (dashboard session), models ready now. login fetches the dashboard token from the browser (CDP, --cdp-port), opening a dashboard tab if needed
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
Anything else is sent to the model as a prompt.`;

/** /help sections in the TUI: title, the commands under it (the rest go under "more") */
const HELP_SECTIONS = [
  ['conversation', ['/reset', '/clear', '/undo', '/each', '/binding', '/system', '/context', '/log', '/files']],
  ['project', ['/cd', '/run', '/diff']],
  ['model and gateway', ['/model', '/stream', '/tools', '/usage', '/last', '/requests', '/gateway', '/proxy', '/status']],
  ['session', ['/mode', '/verbose', '/view', '/split', '/mouse', '/remote-control', '/rename', '/about', '/js', '/help', '/exit']],
];

/** commands whose output the TUI shows as a panel (/js writes past std.out, /each and /binding talk to the model) */
const REPORT_COMMANDS = new Set(['/mouse', '/proxy', '/reset', '/clear', '/undo', '/diff', '/cd', '/status', '/mode', '/verbose', '/remote-control', '/rename', '/model', '/usage', '/last', '/requests', '/gateway', '/tools', '/system', '/stream', '/files', '/context', '/log', '/run']);

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
  return (known ?? []).filter(m => re.test(m));
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
function statusLines(opts, stats, messages, ctxWindow, busy, gateway, remote, cols) {
  const t = stats.totals();
  const last = stats.last();
  const effective = last && !last.error ? routeName(last) : null;
  const dimmed = s => `\x1b[2m${s}\x1b[22m`;

  const left = `${modeBadge(opts.mode, MODE_COLOR[opts.mode])} ${dimmed(shortPath(realpath(opts.root)[0] ?? opts.root, Math.max(12, Math.floor(cols / 4))))}${ui.verbose ? ' \x1b[33mverbose\x1b[0m' : ''}${remote ? ` \x1b[36mremote:${remote}\x1b[0m` : ''}`;
  const center = effective
    ? `\x1b[1m${effective}\x1b[22m${last.provider ? dimmed(` via ${last.provider}`) : ''}${effective !== opts.model && !effective.endsWith(opts.model) ? dimmed(` (asked ${opts.model})`) : ''}`
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
  if(last?.fallbacks) two.push(`\x1b[33m${last.fallbacks} fallback${last.fallbacks > 1 ? 's' : ''}\x1b[39m`);
  two.push(busy ? 'Ctrl-C cancels' : 'Shift-Tab mode · Ctrl-O verbose · /help');

  return [gradientRule(cols), statusBar([left, center, right], cols - 1), dimmed(two.join(' · '))];
}

async function main() {
  const opts = parseArgs(scriptArgs.slice(1));

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
  const stats = new UsageStats();
  /* context window of the model that answered last, for the status line */
  let ctxWindow;

  if('onPhase' in client) client.onPhase = (name, meta) => setPhase(name, { meta });

  if('onMeta' in client)
    client.onMeta = meta => {
      meta.proxied = proxied(proxyInfo.settings, meta.platform);
      stats.add(meta);
      tui?.drawStatus();

      /* the gateway's quota counters moved, and the model that answered may have another window */
      gateway?.refresh().then(async () => {
        if(!meta.error) ctxWindow = (await gateway.effectiveContext(meta, opts.model)) ?? ctxWindow;
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

  if(opts.provider === 'openai' && !bridgeProc) {
    gateway = new Gateway(client);

    if(await gateway.detect()) {
      if(!opts.modelGiven) opts.model = client.model = 'auto';
      if(await gateway.login({ cdp: { host: opts.cdpHost, port: opts.cdpPort } })) await loadProxy(true);
      await gateway.refresh(true);
    } else if(opts.label === 'freellm') console.log(dim(`(${client.baseUrl} does not answer /v1/usage - no freellmapi gateway there, /gateway is off)`));
  }

  if(bridgeProc && opts.model === undefined) {
    const models = await client.listModels().catch(() => []);
    opts.model = pickModel(models);

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
  const saved = store.load();

  const messages = saved ? saved.messages : opts.failsafe || opts.noSystem ? [] : [{ role: 'system', content: opts.noTools ? NOTOOLS_PROMPT : opts.label === 'bridge' ? BRIDGE_PROMPT : SYSTEM_PROMPT + (isQuickJsProject(opts.root) ? QJS_NOTES : '') }];
  /* a resumed session carries the system prompt of the run that saved it */
  if(opts.noSystem && messages[0]?.role === 'system') {
    messages.shift();
    if(saved) saved.baseMessageCount = Math.max(0, saved.baseMessageCount - 1);
  }

  const saveSession = () => store.save(messages, baseMessageCount);

  /* context window of the model, for the status line */
  const updateCtxWindow = async () => (ctxWindow = gateway?.enabled ? await gateway.contextWindow(opts.model) : opts.provider === 'ollama' ? opts.numCtx : undefined);
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
    ['gateway', gateway?.enabled ? `freellmapi${gateway.tokenSource ? `, dashboard via ${gateway.tokenSource}` : ''}` : null],
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
      status: () => statusLines(opts, stats, messages, ctxWindow, repl?.busy, gateway, control && opts.name, tui.cols),
      statusRows: 3,
      paintRule: (cols, label) => gradientRule(cols, label),
      onResize: cols => repl && ((repl.columns = cols), repl.render()),
    });
    tui.start();
  }

  const endpoint = opts.provider === 'gemini' ? 'generativelanguage.googleapis.com' : opts.provider === 'openai' ? client.baseUrl.replace(/^https?:\/\//, '').replace(/\/v1$/, '') : `${opts.host}:${opts.port}`;
  if(tui) {
    console.log(banner(aboutRows(), TIPS, tui.width));
  } else {
    console.log(`ollama-repl: ${opts.provider}/${opts.model} @ ${endpoint}  (root: ${opts.root})${opts.failsafe ? '  [failsafe: no system prompt/project scan/tools]' : ''}`);
    if(gateway?.enabled) console.log(dim('(freellmapi gateway: each reply names the model that served it, /usage /last /requests /gateway for the rest)'));
    console.log(`/help for commands.`);
    console.log(`Logging this session to ${log.path}`);
    console.log(`History persists (^R to search, up/down to recall).`);
  }

  if(saved) {
    console.log(dim(`(resumed session from ${store.path}: ${messages.length} messages)`));
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
  let baseMessageCount = saved ? saved.baseMessageCount : messages.length;
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
        { role: 'system', content: SYSTEM_PROMPT + (isQuickJsProject(opts.root) ? QJS_NOTES : '') },
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
      if(!gateway?.enabled) return void console.log('(no freellmapi gateway: the endpoint does not answer /v1/usage)');

      const arg = prompt.slice('/proxy'.length).trim();
      await loadProxy(false);
      const url = proxyInfo.settings?.url;

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
      } else if(arg) return void console.log('usage: /proxy [probe|exit]');

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
      sentFiles.setRoot(opts.root);
      fileExchange.setRoot(opts.root);
      control?.update({ root: opts.root });

      /* the system prompt's QuickJS notes and the project scan describe the old root */
      if(messages[0]?.role === 'system' && messages[0].content.startsWith(SYSTEM_PROMPT)) messages[0].content = SYSTEM_PROMPT + (isQuickJsProject(opts.root) ? QJS_NOTES : '');
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
      if(prompt !== '/verbose') ui.verbose = prompt.endsWith('on');
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

      if(what === 'login') {
        const ok = await gateway.login({ cdp: { host: opts.cdpHost, port: opts.cdpPort, open: true } });
        if(ok) await Promise.all([gateway.refresh(true), loadProxy(true)]);
        tui?.drawStatus();
        return void console.log(ok ? `(dashboard session from ${gateway.tokenSource}: per-model quotas on)` : `(${gateway.dashboardNote})`);
      }

      const show = { usage: () => gateway.usageText(), providers: () => gateway.providersText(), forecast: () => gateway.forecastText(), quota: () => gateway.quotaText(rest.join(' ')), models: () => gateway.modelsText(rest.join(' ')) }[what];
      if(!show) return void console.log('usage: /gateway [usage|providers|forecast|quota [FILTER]|models [FILTER]|login]');

      try {
        console.log(await show());
      } catch(e) {
        console.log(red(`error: ${e.detail ?? e.message}`));
      }
      return;
    }

    if(prompt === '/model' || prompt.startsWith('/model ')) {
      const arg = prompt.slice('/model'.length).trim();

      if(!arg) return void console.log(`${opts.provider}/${opts.model} @ ${endpoint}`);

      /* openai: whatever the endpoint lists, if it lists at all (a
         chat-bridge does, with availability; plain servers may not) */
      const remote = opts.provider === 'openai' ? await client.listModels().catch(() => null) : null;
      const known = opts.provider === 'ollama' ? ollamaModels() : remote ? remote.map(m => m.name) : null;

      if(arg === 'list') {
        if(remote) return void console.log(remote.filter(m => m.available).map(m => `${m.name.padEnd(32)} ${m.displayName}`).join('\n'));
        return void console.log(known ? known.join('\n') : '(model list is only available for --provider ollama and openai endpoints that serve /models)');
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

    if(prompt === '/tools') {
      console.log(TOOLS.map(t => wrapHanging((t.function?.name ?? t.name).padEnd(14) + ' ', (t.function?.description ?? t.description ?? '').split('\n')[0])).join('\n'));
      return;
    }

    if(prompt === '/system' || prompt.startsWith('/system ')) {
      const arg = prompt.slice('/system'.length).trim();
      const has = messages[0]?.role === 'system';
      const defaultPrompt = SYSTEM_PROMPT + (isQuickJsProject(opts.root) ? QJS_NOTES : '');

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
      const turnStart = messages.length;
      messages.push({ role: 'user', content: prompt });
      messages.push({ role: 'tool', name: 'run_command', toolCallId: '!-user', content: `The user ran the shell command: ${cmd}\nIts output (stdout and stderr merged) follows:\n\n${output || '(no output)'}` });
      log.toolResults(`$ ${cmd}\n${output || '(no output)'}`);

      /* The command output is now in the conversation as a tool result, so
         run a model round right away and let it react to it. */
      let reply;
      try {
        reply = await runToolLoop(client, messages, opts, log, confirmRun, askUser, abortRef, forEach);
      } catch(e) {
        console.log(red(`error: ${e.message}`));
        messages.length = turnStart; // don't leave a dangling/partial turn behind
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

      const turnStart = messages.length;
      messages.push({ role: 'user', content: prompt });

      let reply;
      try {
        ({ content: reply } = await chatRound(client, messages, opts, abortRef));
      } catch(e) {
        console.log(red(`error: ${e.message}`));
        messages.length = turnStart; // don't leave a dangling/partial turn behind
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

    const turnStart = messages.length;
    messages.push({ role: 'user', content: finalText, request: effectivePrompt });

    let reply;
    try {
      reply = await runToolLoop(client, messages, opts, log, confirmRun, askUser, abortRef, forEach);
    } catch(e) {
      console.log(red(`error: ${e.message}`));
      messages.length = turnStart; // don't leave a dangling/partial turn behind
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

  if(tui) {
    repl.tui = tui;
    repl.pagerHeader = (cols, label) => gradientRule(cols, label);
    repl.addCleanupHandler(() => tui.close());
  }

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
    ui.verbose = !ui.verbose;
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

  /* the control socket, from --listen or later from /remote-control */
  startControl = path => {
    const name = sessionName(opts);
    opts.name = name;
    control = new ControlSocket(
      { name, model: opts.model, provider: opts.provider, root: opts.root, cwd: getcwd()[0], mode: opts.mode },
      line => {
        // as if typed: shown on the terminal so the user sees who asked
        if(!tui?.active) console.log(`${piped ? '' : '\r\x1b[K'}${green(`[remote]> ${line}`)}`);
        repl.handleCmd(line, 'remote');
      },
      () => repl.busy,
      path,
    );

    control.start();
    tui?.drawStatus();
    console.log(dim(`(control socket: ${control.path}, session name: ${name} - ollama-repl-ctl -s ${name} send ...)`));
  };

  if(opts.listen !== undefined) startControl(opts.listen || undefined);

  /* over a chat-bridge, a model that hits its limit hands the turn to the
     next available one by itself (lib/failover.js) */
  if(opts.provider === 'openai' && !opts.noFailover) {
    const failover = new Failover(client);

    if(await failover.detect())
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

  await repl.run();
}

await main();
