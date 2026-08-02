#!/usr/bin/env qjsm
/**
 * A Claude-Code-style REPL that talks to a local Ollama model (default:
 * qwen2.5-coder) over a kept-alive HTTP connection (lib/ollama-client.js,
 * built on the `httpClient` protocol adapter, lib/lws/protocols.js).
 *
 * File/glob references typed into a prompt ("fix the bug in src/foo.js",
 * "review *.md") are detected, read, and attached to the outgoing message
 * (lib/file-refs.js); files the model sends back using the "File: path"
 * convention below are parsed out of its reply and written into the
 * project tree (lib/file-blocks.js), same as Claude Code applying an edit.
 *
 * Run (Ollama must already be running locally with the model pulled):
 *   qjsm repl.js [--model qwen2.5-coder] [--host localhost] [--port 11434] [--root .]
 * Or, once installed (see CMakeLists.txt - installs to bin/ollama-repl,
 * lib/ollama-client.js's cross-tree imports rewritten to the installed
 * `lws/*.js` module path):
 *   ollama-repl [--model ...] [...]
 */
import { exit, out as stdout } from 'std';
import { clearTimeout, setTimeout, stat } from 'os';
import { OllamaClient } from './lib/ollama-client.js';
import { extractFileRefs, formatFileBlocks } from './lib/file-refs.js';
import { saveAllBlocks } from './lib/file-blocks.js';
import { extractRequests, runRequests, listFiles } from './lib/tool-requests.js';
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
  const opts = { model: 'qwen2.5-coder', host: 'localhost', port: 11434, root: '.', stream: false };

  for(let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if(arg === '--model') opts.model = argv[++i];
    else if(arg === '--host') opts.host = argv[++i];
    else if(arg === '--port') opts.port = +argv[++i];
    else if(arg === '--root') opts.root = argv[++i];
    else if(arg === '--stream') opts.stream = true;
    else if(arg === '--help' || arg === '-h') {
      console.log('Usage: qjs repl.js [--model NAME] [--host HOST] [--port PORT] [--root DIR] [--stream]');
      exit(0);
    }
  }

  return opts;
}

const SYSTEM_PROMPT = `You are a coding assistant working inside a local project tree, similar to
Claude Code - be proactive and thorough the same way: verify things
against the actual codebase instead of guessing, understand existing
conventions before proposing changes, and keep answers grounded in what
you've actually seen (via READ:/LIST:/RUN: below), not assumption. The
user's messages may include attached file contents, shown as:

File: path/to/file.ext
\`\`\`language
...current contents...
\`\`\`

Only when the user explicitly asks you to create, write, or modify a file,
reply with a block in that exact same format - "File: " followed by the
path (relative to the project root), then a fenced code block with the
complete new file contents. Do not use this format for ordinary
conversation, explanations, or short answers - plain text is fine for
those, and a "File:" block found anywhere in your reply gets written to
disk automatically, overwriting whatever is already there. You may include
prose before/after/between file blocks; each one will be
extracted and written to disk automatically, overwriting the existing
file. Only include files you actually want to change.

For EVERY code snippet you write, in ANY reply - even a quick example, not
just an actual file edit - suggest a real filename for it using the same
"File: path" format, choosing an extension that matches the language,
rather than leaving it an unlabeled snippet. Only skip this for something
that's obviously not meant to be saved (a one-line shell command, a single
expression). Anything you still leave unlabeled is saved anyway, as its
own auto-numbered file, so nothing is ever lost - but a real name you
chose is always more useful than one the REPL had to invent.

You can also ask the REPL to do things for you BEFORE you answer, using
these request lines - each on its own line, exactly like this:

LIST: <directory>
READ: <path-or-glob>
RUN: <shell command>

LIST shows every JS/C/CMake/HTML/CSS/Markdown source file (and README*) under
a directory, recursively - use it to learn a project's layout. READ shows
one file's contents (or every file matching a glob). RUN executes a shell
command yourself, in the project root, and shows you its output (bounded
time and output size - it will tell you if it was truncated or timed out)
- use it freely to grep/search through the codebase (e.g. "grep -rn TODO src"),
inspect a directory (ls, find), or debug something (run a test, check a
tool's version, reproduce an error) instead of guessing what a command
would print. The user is asked to approve each  RUN: command before it
actually executes (you'll be told if one was declined) - that's just a
safety gate, not something you need to ask about yourself; simply issue
the RUN: line you need.

The project's top-level layout and any README/CMakeLists.txt contents are
already given to you below, gathered automatically at the start of this
session - read that first before LIST:/READ:-ing the same things again.
For anything not already covered there (a subdirectory, a specific
source file, a test's actual behavior), use these requests to go look
before answering - the moment you're not certain about something (a
file's actual contents, what a directory contains, whether code compiles
or a test passes) rather than guessing or making something up. Prefer
asking over assuming. You may issue several request lines in one reply;
each one runs, and you'll be shown the results and asked again, so build
up what you need step by step - LIST a directory to see what's there,
then READ the file that looks relevant, then maybe RUN a test - before
committing to a final answer. Only stop asking once you actually have
enough to answer well; don't pad a reply with requests you don't need.

You often work on "qjs-*" native modules: a small C file per JS class/
namespace binding QuickJS to a native library, plus JS glue that uses it.
Reference material is available on request - just mention "quickjs.h",
"fs.js", "console.js", "process.js", or "util.js" in a message and the
real file is attached automatically, same as any project file.

QuickJS C API (quickjs.h), the shape every qjs-* binding follows:
- JSValue is a tagged, refcounted handle; JSContext* is a per-thread heap,
  JSRuntime* owns one or more contexts. JS_DupValue()/JS_FreeValue() move
  the refcount; every JSValue a function creates or takes ownership of
  must be freed exactly once - the single most common bug in this kind of
  code is a missing JS_FreeValue() (leak) or a double one (use-after-free).
- A native class: JS_NewClassID() + JS_NewClass(rt, id, &JSClassDef) once
  at module init; each instance is a plain JS object with a native struct
  attached via JS_SetOpaque()/JS_GetOpaque(obj, class_id) - the struct is
  yours to malloc/free, typically in the JSClassDef.finalizer.
- Native functions/getters go in a static const JSCFunctionListEntry[]
  table via JS_CFUNC_DEF(name, argc, func) or, for one C function
  dispatching several JS methods/properties by an int tag,
  JS_CFUNC_MAGIC_DEF/JS_CGETSET_MAGIC_DEF(name, argc, func, magic) -
  installed with JS_SetPropertyFunctionList() on a prototype object, or
  JS_SetModuleExportList() for a module's top-level exports.
- Modules: JS_NewCModule(ctx, name, init_func) declares it;
  JS_AddModuleExport()/JS_SetModuleExport() (or the *List() forms above)
  expose values, called both from the init callback (declare) and again
  once the module body runs (set the real value) - see any existing
  qjs-lws module init function for the two-phase pattern.
- Errors: return JS_EXCEPTION (not NULL, not JS_UNDEFINED) from a native
  function after calling JS_ThrowTypeError()/JS_ThrowRangeError()/
  JS_ThrowInternalError(ctx, fmt, ...) - never leave a JSValue error
  pending without a return that signals it.
- Strings/buffers: JS_ToCString()/JS_FreeCString() for a temporary C
  string view, JS_NewStringLen()/JS_NewString() to create one,
  JS_GetArrayBuffer()/JS_NewArrayBufferCopy() for ArrayBuffers.

qjs-modules JS built-ins (/usr/local/lib/quickjs/*.js), available as bare
imports (\`import * as fs from 'fs'\`, etc.) in any script running under qjsm -  roughly Node-shaped, not WHATWG:  - fs: mostly *Sync functions (readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, existsSync, ...) plus lower-level std-file-style ops (openSync/closeSync/seek/tell) and stream helpers (createReadStream/ createWriteStream, watch()). - console: Console class / the global console - log/error/warn/etc. with util's inspect-based formatting, not just string concatenation. - process: a Node-like singleton - argv, argv0, env, cwd()/chdir(), pid/ppid, platform/arch, exit(code), hrtime(), stdin/stdout/stderr. - util: a large grab-bag - Object.* wrappers, type predicates (isObject, isString, isClass, TypedArray, ...), memoize, inherits, setImmediate/ clearImmediate/queueMicrotask. Console's own value formatting comes from a separate 'inspect' built-in, not from here.`;

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

/** Starts an animated "<glyph> Thinking..." line; returns a function that
    stops it and clears the line. */
function startSpinner(label = 'Thinking') {
  let i = 0;
  let timer;

  const tick = () => {
    stdout.puts(`\r${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${label}...`);
    stdout.flush();
    timer = setTimeout(tick, SPINNER_MS);
  };

  tick();

  return () => {
    if(timer != null) clearTimeout(timer);
    stdout.puts(`\r${' '.repeat(label.length + 5)}\r`);
    stdout.flush();
  };
}

/**
 * One chat() or chatStream() call, printed the same way either way -
 * shows a spinner (startSpinner() above) until the first sign of a reply
 * (the first token, or the whole reply for non-streaming), then a
 * "Cogitated for Ns" line once it's completely done.
 * @returns {Promise<string>} the reply text
 */
async function chatRound(client, messages, opts) {
  const t0 = Date.now();
  const stopSpinner = startSpinner();
  const cogitated = () => console.log(`\x1b[2mCogitated for ${((Date.now() - t0) / 1000).toFixed(1)}s\x1b[0m\n`);

  if(opts.stream) {
    let first = true;

    const reply = await client.chatStream(messages, {}, token => {
      if(first) {
        stopSpinner();
        stdout.puts('\nqwen> ');
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

  const reply = await client.chat(messages);
  stopSpinner();
  console.log(`\nqwen> ${reply}\n`);
  cogitated();
  return reply;
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
async function runToolLoop(client, messages, opts, log, confirmRun) {
  for(let round = 0; ; round++) {
    const reply = await chatRound(client, messages, opts);
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
 * Runs an automatic LIST + READ of the project root's own layout (every
 * README*, plus CMakeLists.txt if the project has one) and returns it
 * formatted the same way a model-requested LIST:/READ: round would be -
 * seeded into `messages` once at startup (see main()) so the model always
 * starts a session already knowing the project's shape, the same way
 * Claude Code auto-reads project context rather than waiting to be asked.
 */
async function gatherProjectContext(root) {
  const files = listFiles('', root);

  const readmes = files.filter(f => /^readme/i.test(f.slice(f.lastIndexOf('/') + 1)));
  const requests = [{ type: 'LIST', arg: '.' }, ...readmes.map(f => ({ type: 'READ', arg: f }))];

  const [cmakeStat] = stat(root === '.' ? 'CMakeLists.txt' : `${root}/CMakeLists.txt`);
  if(cmakeStat) requests.push({ type: 'READ', arg: 'CMakeLists.txt' });

  return runRequests(requests, root);
}

const HELP_TEXT = `/reset          - clear conversation history (keeps the initial project scan)
/exit, /quit    - quit
/help           - this text
/run <command>  - run a shell command yourself, right now (no model round trip, no approval prompt - it's you asking, not the model)
/status         - show model/connection/session info
/files          - dump this session's file exchange (sent, received, diffs)
Anything else is sent to the model as a prompt.`;

async function main() {
  const opts = parseArgs(scriptArgs.slice(1));
  const client = new OllamaClient(opts);
  const log = new SessionLog(`${opts.model}.log`);
  const sentFiles = new SentFiles(opts.model, opts.root);
  const fileExchange = new FileExchange(opts.model, opts.root);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  console.log(`ollama-repl: ${opts.model} @ ${opts.host}:${opts.port}  (root: ${opts.root})`);
  //console.log(`Type a prompt and press Enter.\nReference files by name or glob (e.g. src/*.js) to attach them.`);
  console.log(`/help for commands.`);
  console.log(`Logging this session to ${opts.model}.log.`);
  console.log(`History persists (^R to search, up/down to recall).`);

  console.log(`\x1b[2m(scanning project layout...)\x1b[0m`);

  const projectContext = await gatherProjectContext(opts.root);

  console.log('projectContext', console.config({ maxStringLength: 32, maxArrayLength: 32 }), projectContext.length, projectContext.replaceAll(/\n/g, '\\n').slice(0, 50));

  messages.push(
    { role: 'user', content: `(automatic project scan at session start)\n\n${projectContext}` },
    { role: 'assistant', content: "Got it - I have the project's layout and README/CMakeLists.txt contents above." },
  );
  log.toolResults(projectContext);

  console.log('ready!');

  // /reset clears conversation history, not the auto-loaded project scan.
  const baseMessageCount = messages.length;
  const startedAt = Date.now();

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
            `model:    ${opts.model} @ ${opts.host}:${opts.port}${opts.stream ? ' (streaming)' : ''}`,
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

      const { text: withFiles, attached } = attachFiles(prompt, opts.root, fileExchange);
      log.prompt(prompt, attached);

      const turnStart = messages.length;
      messages.push({ role: 'user', content: withFiles });

      const confirmRun = cmd => repl.confirm(`Run this command?\n  ${cmd}`);

      let reply;
      try {
        reply = await runToolLoop(client, messages, opts, log, confirmRun);
      } catch(e) {
        console.log(`\x1b[31merror: ${e.message}\x1b[0m`);
        messages.length = turnStart; // don't leave a dangling/partial turn behind
        return;
      }

      const written = await applyFileBlocks(reply, opts.root, sentFiles, fileExchange);
      log.modified(written);
    },
    opts.root,
  );

  repl.addCleanupHandler(() => {
    log.close();
    client.destroy();
  });

  await repl.run();
}

await main();
