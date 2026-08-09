#!/usr/bin/env qjsm
/**
 * A Claude-Code-style REPL that talks to either a local Ollama model
 * (default: qwen2.5-coder, over a kept-alive HTTP connection -
 * lib/ollama-client.js, built on the `httpClient` protocol adapter,
 * lib/lws/protocols.js) or Google's Gemini API (lib/gemini-client.js,
 * built on the shared `fetch()`) - `--provider` selects which. Both
 * clients expose the same `chat()`/`chatStream()` shape, so everything
 * below this point is provider-agnostic.
 *
 * File/glob references typed into a prompt ("fix the bug in src/foo.js",
 * "review *.md") are detected, read, and attached to the outgoing message
 * (lib/file-refs.js); files the model sends back using the "File: path"
 * convention below are parsed out of its reply and written into the
 * project tree (lib/file-blocks.js), same as Claude Code applying an edit.
 *
 * Run (Ollama must already be running locally with the model pulled; for
 * `--provider gemini`, GEMINI_API_KEY must be exported instead):
 *   qjsm repl.js [--provider ollama|gemini] [--model NAME] [--host localhost] [--port 11434] [--root .]
 * Or, once installed (see CMakeLists.txt - installs to bin/ollama-repl,
 * lib/ollama-client.js's cross-tree imports rewritten to the installed
 * `lws/*.js` module path):
 *   ollama-repl [--model ...] [...]
 *
 * `--failsafe` drops all of the above scaffolding: no system prompt, no
 * project scan, no file-ref attachment, no LIST:/READ:/RUN: tool loop, no
 * "File:" auto-write - just the conversation, sent to the model as-is, for
 * when the normal prompt/tooling machinery itself is what's under
 * suspicion (or simply unwanted).
 *
 * A second `-x`/`--debug` (e.g. `-x -x`) additionally turns on `lws.so`'s
 * own LLL_USER logging (the underlying HTTP connection - connects,
 * writes, reads, closes) to stderr, on top of the first `-x`'s
 * request/response body logging to `<model>.log` - for when the model
 * traffic itself looks fine but something at the socket/HTTP level
 * (lib/lws/protocols.js, lib/lws/context.js) is suspect.
 */
import { exit, out as stdout, err as stderr } from 'std';
import { clearTimeout, setTimeout, stat, readdir, S_IFDIR } from 'os';
import { logLevel, LLL_USER } from 'lws.so';
import { OllamaClient } from './lib/ollama-client.js';
import { GeminiClient } from './lib/gemini-client.js';
import { extractFileRefs, formatFileBlocks, SOURCE_EXT } from './lib/file-refs.js';
import { saveAllBlocks } from './lib/file-blocks.js';
import { extractRequests, runRequests } from './lib/tool-requests.js';
import { looksLikeBindingPrompt, bindingContext } from './lib/binding-context.js';
import { fileMode, SKIP_DIRS } from './lib/match.js';
import { ChatREPL } from './lib/chat-repl.js';
import { SessionLog } from './lib/session-log.js';
import { SentFiles } from './lib/sent-files.js';
import { FileExchange } from './lib/file-exchange.js';
import { runCommand } from './lib/run-command.js';

/* Bounds the LIST:/READ:/RUN: tool loop (see SYSTEM_PROMPT and
   runToolLoop() below) - a request round costs a real network round trip
   to the model, so this caps both latency and (if the model gets stuck
   re-requesting) runaway cost, not just literal infinite loops. */
const MAX_TOOL_ROUNDS = 4;

function parseArgs(argv) {
  const opts = { provider: 'ollama', model: undefined, host: 'localhost', port: 11434, root: '.', stream: false, debug: false, lwsDebug: false, failsafe: false };
  let debugCount = 0;

  for(let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if(arg === '--provider') opts.provider = argv[++i];
    else if(arg === '--model') opts.model = argv[++i];
    else if(arg === '--host') opts.host = argv[++i];
    else if(arg === '--port') opts.port = +argv[++i];
    else if(arg === '--root') opts.root = argv[++i];
    else if(arg === '--stream') opts.stream = true;
    else if(arg === '-x' || arg === '--debug') {
      opts.debug = true;
      if(++debugCount >= 2) opts.lwsDebug = true;
    } else if(arg === '--failsafe') opts.failsafe = true;
    else if(arg === '--help' || arg === '-h') {
      console.log('Usage: qjsm repl.js [--provider ollama|gemini] [--model NAME] [--host HOST] [--port PORT] [--root DIR] [--stream] [-x [-x]] [--failsafe]');
      exit(0);
    }
  }

  if(opts.provider !== 'ollama' && opts.provider !== 'gemini') {
    console.log(`\x1b[31merror: --provider must be "ollama" or "gemini", got "${opts.provider}"\x1b[0m`);
    exit(1);
  }

  opts.model ??= opts.provider === 'gemini' ? 'gemini-flash-latest' : 'qwen2.5-coder';

  return opts;
}

const SYSTEM_PROMPT = `You are a coding assistant working inside a local project tree, similar to
Claude Code: verify against the actual codebase instead of guessing, and
ground answers in what you've actually seen (via READ:/LIST:/RUN: below),
not assumption. Ask if genuinely unsure rather than guessing.

This project runs on QuickJS (qjs/qjsm), not Node.js - don't assume Node's
globals, module system ("require", "node_modules"), or built-ins ("path",
"crypto", "buffer", "process.nextTick") are available unless a project
file actually imports/defines one; check (READ:/LIST: below) if unsure.

Attached file contents in the user's messages look like:

File: path/to/file.ext
\`\`\`language
...current contents...
\`\`\`
(imports/includes: ../lib/foo.js - READ: any of these you actually need)

Only when explicitly asked to create, write, or modify a file, reply with
a block in that same format - "File: path" then a fenced code block with
the complete new file contents - for each file you actually want to
change; a "File:" block anywhere in your reply gets written to disk
automatically, overwriting what's there. Don't use it for ordinary
conversation - plain text is fine for that. Label any other code snippet
you write the same way (a real filename, matching extension) unless it's
obviously not meant to be saved; anything left unlabeled is auto-saved
anyway, so a real name is just more useful than an invented one.

You can ask the REPL to do things for you before answering, one request
per line, anywhere in your reply:

LIST: <directory>
READ: <path-or-glob>
RUN: <shell command>

LIST recursively lists source files (and README*) under a directory -
<directory> can also be a sibling "qjs-*" reference project checked out
alongside this one (e.g. "LIST: qjs-modules"). READ shows a file's
contents, or every file matching a glob. RUN executes a shell command in
the project root and shows its output (you'll be asked to approve each
one first) - use it for git (status/diff/log, to see what's actually
changed or already there) and for testing: \`qjsm -e '<code>'\` evaluates
a JS snippet immediately and shows the result, so you can check a
QuickJS/C-binding API call actually works (or a syntax idea actually
runs) before writing it into a file - much cheaper than writing a whole
file and hoping. Issue as many requests as you need in one reply - each
runs and you're shown the results and asked again, so build up what you
need before committing to a final answer.

The project's top-level layout and README/CMakeLists.txt are already
given below, gathered automatically at session start - read that first.
For anything else - a subdirectory, a specific file, a sibling "qjs-*"
project, the QuickJS C API (quickjs.h) or qjs-modules' JS built-ins
(fs.js/console.js/process.js/util.js under /usr/local/lib/quickjs/) -
READ:/LIST: it rather than guessing at its contents; naming a header or
built-in by name attaches the real file automatically.

Writing a new native (C) QuickJS binding is a common request here - when
one of examples/fib.c, examples/point.c, and the quickjs-binding-api.md
cheat sheet are attached below, they're the reference for it, already
picked for you; otherwise READ an existing one for the real shape of the
boilerplate (a sibling "qjs-*" project's own .c file, or LIST: one of
them if you don't know which - qjs-ffi and qjs-modules are the most
representative), and READ quickjs.h for any exact JS_* signature the
cheat sheet doesn't cover, rather than recalling it from memory. Before
writing any C, sketch the JS-facing API in one or two lines as plain text
(argument/return types, sync vs. async, e.g. \`deflate(data:
ArrayBuffer|Uint8Array): ArrayBuffer\`) - catches a bad shape before code
exists for it, and gives the human a checkpoint to redirect at. Verify
the binding compiles/links and a quick JS-side smoke test actually works
via RUN: - compile it standalone, not through this project's own build
(that pulls in libwebsockets and a multi-minute link for something that
needs none of it):
\`gcc -shared -fPIC -I<quickjs-source-dir> -o binding.so binding.c
-DJS_SHARED_LIBRARY [-lwhatever]\`, then \`qjsm -e '<smoke test importing
./binding.so>'\` - before presenting it as done, don't just describe code
that should work.`;

/** @returns {{ text: string, attached: string[] }} */
function attachFiles(prompt, root, fileExchange) {
  const { files, skipped } = extractFileRefs(prompt, root);

  if(skipped.length) console.log(`\x1b[2m(skipped, too large or unreadable: ${skipped.join(', ')})\x1b[0m`);
  if(!files.length) return { text: prompt, attached: [] };

  const attached = files.map(f => f.path);

  console.log(`\x1b[2m(attached: ${attached.join(', ')})\x1b[0m`);
  fileExchange.recordSent(attached);

  return { text: `${prompt}\n\n${formatFileBlocks(files)}`, attached };
}

/** @returns {string[]} paths actually written (named "File:" blocks and auto-named anonymous ones alike) */
async function applyFileBlocks(reply, root, sentFiles, fileExchange) {
  const { written, rejected } = await saveAllBlocks(reply, { root, sentFiles, fileExchange });

  for(const path of written) console.log(`\x1b[32mmodified: ${path}\x1b[0m`);
  for(const path of rejected) console.log(`\x1b[31mrefused to write (unsafe path): ${path}\x1b[0m`);

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

/** Starts an animated "<glyph> Thinking...(1m 5s)" line - the elapsed-time
    suffix only appears past SPINNER_ELAPSED_THRESHOLD_MS - and returns a
    function that stops it and clears the line. */
function startSpinner(label = 'Thinking') {
  const t0 = Date.now();
  let i = 0;
  let timer;
  let lastLen = 0;

  const tick = () => {
    const elapsed = Date.now() - t0;
    const suffix = elapsed >= SPINNER_ELAPSED_THRESHOLD_MS ? ` (${formatElapsed(elapsed)})` : '';
    const text = `${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${label}...${suffix}`;

    stdout.puts(`\r${text}`);
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

/**
 * One chat() or chatStream() call, printed the same way either way -
 * shows a spinner (startSpinner() above) until the first sign of a reply
 * (the first token, or the whole reply for non-streaming), then a
 * "Cogitated for Ns" line once it's completely done. `abortRef.current` is
 * set to the active client's abort() for the duration of the call (and
 * cleared after) - see main()'s ChatREPL construction below, whose Ctrl-C
 * handler calls it to cancel the in-flight request instead of quitting.
 * @returns {Promise<string>} the reply text
 */
async function chatRound(client, messages, opts, abortRef) {
  //console.log('chatRound');
  const t0 = Date.now();
  const stopSpinner = startSpinner();
  const cogitated = () => console.log(`\x1b[2mCogitated for ${((Date.now() - t0) / 1000).toFixed(1)}s\x1b[0m\n`);

  abortRef.current = () => client.abort();

  // `finally` (not just the explicit stopSpinner() calls below, which only
  // cover the success path) - client.chat()/chatStream() throwing (a
  // timeout, a dropped connection, ...) must never leave the spinner's
  // timer running; stopSpinner() is idempotent, so this is a harmless
  // no-op on top of an already-stopped spinner.
  try {
    if(opts.stream) {
      let first = true;

      const { content: reply } = await client.chatStream(messages, {}, token => {
        if(first) {
          stopSpinner();
          stdout.puts(`\n${opts.provider}> `);
          first = false;
        }

        stdout.puts(token);
        stdout.flush();
      });

      if(first) stopSpinner(); // reply came back empty - no token ever arrived to stop it

      stdout.puts('\n\n');
      stdout.flush();
      cogitated();
      return reply;
    }

    const { content: reply } = await client.chat(messages);
    stopSpinner();
    console.log(`\n${opts.provider}> ${reply}\n`);
    cogitated();
    return reply;
  } finally {
    abortRef.current = null;
    stopSpinner();
  }
}

/**
 * Drives the LIST:/READ:/RUN: request loop (see SYSTEM_PROMPT): runs one
 * chat round, and if the reply contains request lines, executes them,
 * feeds the results back as the next turn's input, and repeats - up to
 * MAX_TOOL_ROUNDS - until a reply with no more requests (or the round cap)
 * is reached. `messages` is mutated in place (a user turn, then one
 * assistant turn per round); callers that want to roll back an aborted
 * turn should snapshot `messages.length` before calling this.
 *
 * @returns {Promise<string>} the final reply shown to the user
 */
async function runToolLoop(client, messages, opts, log, confirmRun, abortRef) {
  for(let round = 0; ; round++) {
    const reply = await chatRound(client, messages, opts, abortRef);
    messages.push({ role: 'assistant', content: reply });
    log.reply(reply);

    const requests = extractRequests(reply);
    if(!requests.length || round >= MAX_TOOL_ROUNDS - 1) return reply;

    console.log(`\x1b[2m(${requests.map(r => `${r.type}: ${r.arg}`).join(' | ')})\x1b[0m`);

    const results = await runRequests(requests, opts.root, confirmRun);
    log.toolResults(results);

    messages.push({
      role: 'user',
      content: `Tool results:\n\n${results}\n\nContinue - answer now if you have enough information, or issue more LIST:/READ:/RUN: requests if you still need to.`,
    });
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
 * Runs an automatic LIST + READ of the project root's own layout - a
 * shallow, top-level-only directory listing, plus the root README.md and
 * CMakeLists.txt if the project has them - and returns it formatted the
 * same way a model-requested LIST:/READ: round would be - seeded into
 * `messages` once at startup (see main()) so the model always starts a
 * session already knowing the project's shape, the same way Claude Code
 * auto-reads project context rather than waiting to be asked.
 *
 * Deliberately shallow: this used to run a full recursive LIST (every
 * listable file in the whole tree, up to 300 entries) and READ every
 * README* found anywhere under root, not just the top-level one - on this
 * project alone that came to a ~80KB first-turn payload before a single
 * word had been exchanged, which is what actually triggered
 * BUGS:tls-client-large-body-hangs-or-closes against a real API. A
 * top-level listing plus the project's own README/CMakeLists.txt is
 * enough to know the project's shape; anything deeper is exactly what the
 * LIST:/READ: tool loop is for. Files are further filtered to SOURCE_EXT
 * (file-refs.js) - directories always stay (needed to see the layout at
 * all), but a top-level file with no source extension (a cert, a lockfile,
 * a build cache stray SKIP_DIRS/.gitignore didn't already catch) is noise
 * for "what does this project look like", not signal.
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

  const requests = [];

  const [readmeStat] = stat(root === '.' ? 'README.md' : `${root}/README.md`);
  if(readmeStat) requests.push({ type: 'READ', arg: 'README.md' });

  const [cmakeStat] = stat(root === '.' ? 'CMakeLists.txt' : `${root}/CMakeLists.txt`);
  if(cmakeStat) requests.push({ type: 'READ', arg: 'CMakeLists.txt' });

  const reads = requests.length ? await runRequests(requests, root) : '';

  return `LIST: . (top-level only)\n${layout || '(empty)'}${reads ? `\n\n${reads}` : ''}`;
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
/exit, /quit    - quit
/help           - this text
/run <command>  - run a shell command yourself, right now (no model round trip, no approval prompt - it's you asking, not the model)
/binding <text> - force-attach the native-binding reference (fib.c/point.c/cheat sheet) for this prompt, even if it doesn't sound like a binding request
/status         - show model/connection/session info
/files          - dump this session's file exchange (sent, received, diffs)
/context        - inspect the full context about to be sent to the model (system prompt + project scan + conversation) - raw, inspect()-colored, with -x; a one-line-per-message summary without it
/log            - inspect just the conversation so far (no system prompt/project scan) - same raw-with--x/summary-without split as /context
Anything else is sent to the model as a prompt.`;

async function main() {
  const opts = parseArgs(scriptArgs.slice(1));

  if(opts.lwsDebug) {
    let f = std.open('traffic.log', 'a+');

    logLevel(LLL_USER, (level, msg) => {
      //msg = msg.replace(/^[^\]]*\]: [^:]*: /, '');
      //f.puts(`\x1b[1;33m${msg}\x1b[0m\n`);
      f.puts(`${msg}\n`);
      f.flush();
    });
  }

  let client;
  try {
    client = opts.provider === 'gemini' ? new GeminiClient(opts) : new OllamaClient(opts);
  } catch(e) {
    console.log(`\x1b[31merror: ${e.message}\x1b[0m`);
    exit(1);
  }

  const log = new SessionLog(`${opts.model}.log`);
  const sentFiles = new SentFiles(opts.model, opts.root);
  const fileExchange = new FileExchange(opts.model, opts.root);
  const messages = opts.failsafe ? [] : [{ role: 'system', content: SYSTEM_PROMPT }];

  const endpoint = opts.provider === 'gemini' ? 'generativelanguage.googleapis.com' : `${opts.host}:${opts.port}`;
  console.log(`ollama-repl: ${opts.provider}/${opts.model} @ ${endpoint}  (root: ${opts.root})${opts.failsafe ? '  [failsafe: no system prompt/project scan/tools]' : ''}`);
  //console.log(`Type a prompt and press Enter.\nReference files by name or glob (e.g. src/*.js) to attach them.`);
  console.log(`/help for commands.`);
  console.log(`Logging this session to ${opts.model}.log.`);
  console.log(`History persists (^R to search, up/down to recall).`);

  if(!opts.failsafe) {
    console.log(`\x1b[2m(scanning project layout...)\x1b[0m`);

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
  const baseMessageCount = messages.length;
  const startedAt = Date.now();

  /* Set to the active client's abort() (see chatRound() above) for the
     duration of whatever chat()/chatStream() call is currently in flight,
     null otherwise - the ChatREPL constructed below calls it on Ctrl-C
     instead of quitting, when there's actually something to cancel. */
  const abortRef = { current: null };

  const repl = new ChatREPL(
    'you',
    async line => {
      const prompt = line.trim();
      if(!prompt) return;

      //console.log('ChatREPL', prompt);

      if(prompt === '/exit' || prompt === '/quit') return repl.exit(0);

      if(prompt === '/reset') {
        messages.length = baseMessageCount;
        console.log('(conversation reset)');
        return;
      }

      if(prompt === '/help') {
        console.log(HELP_TEXT);
        return;
      }

      if(prompt === '/status') {
        const uptimeS = Math.round((Date.now() - startedAt) / 1000);
        console.log(
          [
            `model:    ${opts.provider}/${opts.model} @ ${endpoint}${opts.stream ? ' (streaming)' : ''}`,
            `root:     ${opts.root}`,
            `messages: ${messages.length - baseMessageCount} (${messages.length} incl. system prompt + project scan)`,
            `log:      ${opts.model}.log`,
            `uptime:   ${uptimeS}s`,
          ].join('\n'),
        );
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
          reply = await chatRound(client, messages, opts, abortRef);
        } catch(e) {
          console.log(`\x1b[31merror: ${e.message}\x1b[0m`);
          messages.length = turnStart; // don't leave a dangling/partial turn behind
          return;
        }

        messages.push({ role: 'assistant', content: reply });
        log.reply(reply);
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
          console.log(`\x1b[2m(attached binding reference: ${bindingAttached.join(', ')})\x1b[0m`);
          finalText = `${finalText}\n\n${bindingText}`;
        }
      }

      const turnStart = messages.length;
      messages.push({ role: 'user', content: finalText });

      const confirmRun = cmd => repl.confirm(`Run this command?\n  ${cmd}`);

      let reply;
      try {
        reply = await runToolLoop(client, messages, opts, log, confirmRun, abortRef);
      } catch(e) {
        console.log(`\x1b[31merror: ${e.message}\x1b[0m`);
        messages.length = turnStart; // don't leave a dangling/partial turn behind
        return;
      }

      const written = await applyFileBlocks(reply, opts.root, sentFiles, fileExchange);
      log.modified(written);
    },
    opts.root,
    () => abortRef.current?.() ?? false,
  );

  repl.addCleanupHandler(() => {
    log.close();
    client.destroy();
  });

  await repl.run();
}

await main();
