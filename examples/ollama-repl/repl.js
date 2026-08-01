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
import * as std from 'std';
import { OllamaClient } from './lib/ollama-client.js';
import { extractFileRefs, formatFileBlocks } from './lib/file-refs.js';
import { saveAllBlocks } from './lib/file-blocks.js';
import { extractRequests, runRequests } from './lib/tool-requests.js';
import { ChatREPL } from './lib/chat-repl.js';
import { SessionLog } from './lib/session-log.js';
import { SentFiles } from './lib/sent-files.js';

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
      std.exit(0);
    }
  }

  return opts;
}

const SYSTEM_PROMPT = `You are a coding assistant working inside a local project tree, similar to
Claude Code. The user's messages may include attached file contents, shown
as:

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
file. Only include files you actually want to change. Any OTHER fenced
code block in your reply (no "File:" label - a snippet, an example, code
you're not sure belongs in the tree yet) is still saved automatically, as
its own numbered file, so nothing you write is ever lost even if it
wasn't meant as a file edit.

You can also ask the REPL to do things for you BEFORE you answer, using
these request lines - each on its own line, exactly like this:

LIST: <directory>
READ: <path-or-glob>
RUN: <shell command>

LIST shows every JS/C/HTML/CSS/Markdown source file (and README*) under a
directory, recursively - use it to learn a project's layout. READ shows
one file's contents (or every file matching a glob). RUN executes a shell
command in the project root and shows you its output (bounded time and
output size - it will tell you if it was truncated or timed out).

Use this liberally and as EARLY as possible - the moment you're not
certain about something (a file's actual contents, what a directory
contains, whether code compiles or a test passes, what a project's
structure even is) - rather than guessing or making something up. Prefer
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
imports (\`import * as fs from 'fs'\`, etc.) in any script running under
qjsm - roughly Node-shaped, not WHATWG:
- fs: mostly *Sync functions (readFileSync, writeFileSync, statSync,
  readdirSync, mkdirSync, existsSync, ...) plus lower-level std-file-style
  ops (openSync/closeSync/seek/tell) and stream helpers (createReadStream/
  createWriteStream, watch()).
- console: Console class / the global console - log/error/warn/etc. with
  util's inspect-based formatting, not just string concatenation.
- process: a Node-like singleton - argv, argv0, env, cwd()/chdir(),
  pid/ppid, platform/arch, exit(code), hrtime(), stdin/stdout/stderr.
- util: a large grab-bag - Object.* wrappers, type predicates (isObject,
  isString, isClass, TypedArray, ...), memoize, inherits, setImmediate/
  clearImmediate/queueMicrotask. Console's own value formatting comes from
  a separate 'inspect' built-in, not from here.`;

/** @returns {{ text: string, attached: string[] }} */
function attachFiles(prompt, root) {
  const { files, skipped } = extractFileRefs(prompt, root);

  if(skipped.length) console.log(`\x1b[2m(skipped, too large or unreadable: ${skipped.join(', ')})\x1b[0m`);
  if(!files.length) return { text: prompt, attached: [] };

  console.log(`\x1b[2m(attached: ${files.map(f => f.path).join(', ')})\x1b[0m`);
  return { text: `${prompt}\n\n${formatFileBlocks(files)}`, attached: files.map(f => f.path) };
}

/** @returns {string[]} paths actually written (named "File:" blocks and auto-named anonymous ones alike) */
function applyFileBlocks(reply, root, sentFiles) {
  const { written, rejected } = saveAllBlocks(reply, { root, sentFiles });

  for(const path of written) console.log(`\x1b[32mmodified: ${path}\x1b[0m`);
  for(const path of rejected) console.log(`\x1b[31mrefused to write (unsafe path): ${path}\x1b[0m`);

  return written;
}

/**
 * One chat() or chatStream() call, printed the same way either way.
 * @returns {Promise<string>} the reply text
 */
async function chatRound(client, messages, opts) {
  if(opts.stream) {
    std.out.puts('\nqwen> ');
    std.out.flush();

    const reply = await client.chatStream(messages, token => {
      std.out.puts(token);
      std.out.flush();
    });

    std.out.puts('\n\n');
    std.out.flush();
    return reply;
  }

  const reply = await client.chat(messages);
  console.log(`\nqwen> ${reply}\n`);
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
async function runToolLoop(client, messages, opts, log) {
  for(let round = 0; ; round++) {
    const reply = await chatRound(client, messages, opts);
    messages.push({ role: 'assistant', content: reply });
    log.reply(reply);

    const requests = extractRequests(reply);
    if(!requests.length || round >= MAX_TOOL_ROUNDS - 1) return reply;

    console.log(`\x1b[2m(${requests.map(r => `${r.type}: ${r.arg}`).join(' | ')})\x1b[0m`);

    const results = await runRequests(requests, opts.root);
    log.toolResults(results);

    messages.push({
      role: 'user',
      content: `Tool results:\n\n${results}\n\nContinue - answer now if you have enough information, or issue more LIST:/READ:/RUN: requests if you still need to.`,
    });
  }
}

async function main() {
  const opts = parseArgs(scriptArgs.slice(1));
  const client = new OllamaClient(opts);
  const log = new SessionLog(`${opts.model}.log`);
  const sentFiles = new SentFiles(opts.model, opts.root);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  console.log(`ollama-repl: ${opts.model} @ ${opts.host}:${opts.port}  (root: ${opts.root})`);
  console.log(`Type a prompt and press Enter. Reference files by name or glob (e.g. src/*.js) to attach them. /help for commands.`);
  console.log(`Logging this session to ${opts.model}.log. History persists via qjs-modules' repl module (^R to search, up/down to recall).\n`);

  const repl = new ChatREPL('you', async line => {
    const prompt = line.trim();
    if(!prompt) return;

    if(prompt === '/exit' || prompt === '/quit') return repl.exit(0);

    if(prompt === '/reset') {
      messages.length = 1;
      console.log('(conversation reset)');
      return;
    }

    if(prompt === '/help') {
      console.log('/reset - clear conversation history\n/exit  - quit\nAnything else is sent to the model as a prompt.');
      return;
    }

    const { text: withFiles, attached } = attachFiles(prompt, opts.root);
    log.prompt(prompt, attached);

    const turnStart = messages.length;
    messages.push({ role: 'user', content: withFiles });

    let reply;
    try {
      reply = await runToolLoop(client, messages, opts, log);
    } catch(e) {
      console.log(`\x1b[31merror: ${e.message}\x1b[0m`);
      messages.length = turnStart; // don't leave a dangling/partial turn behind
      return;
    }

    const written = applyFileBlocks(reply, opts.root, sentFiles);
    log.modified(written);
  });

  repl.addCleanupHandler(() => {
    log.close();
    client.destroy();
  });

  await repl.run();
}

await main();
