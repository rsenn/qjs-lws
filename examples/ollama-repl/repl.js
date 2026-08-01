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
 *   qjs repl.js [--model qwen2.5-coder] [--host localhost] [--port 11434] [--root .]
 */
import * as std from 'std';
import { OllamaClient } from './lib/ollama-client.js';
import { extractFileRefs, formatFileBlocks } from './lib/file-refs.js';
import { extractFileBlocks, saveFileBlocks } from './lib/file-blocks.js';

function parseArgs(argv) {
  const opts = { model: 'qwen2.5-coder', host: 'localhost', port: 11434, root: '.' };

  for(let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if(arg === '--model') opts.model = argv[++i];
    else if(arg === '--host') opts.host = argv[++i];
    else if(arg === '--port') opts.port = +argv[++i];
    else if(arg === '--root') opts.root = argv[++i];
    else if(arg === '--help' || arg === '-h') {
      console.log('Usage: qjs repl.js [--model NAME] [--host HOST] [--port PORT] [--root DIR]');
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
file. Only include files you actually want to change.`;

function attachFiles(prompt, root) {
  const { files, skipped } = extractFileRefs(prompt, root);

  if(skipped.length) console.log(`\x1b[2m(skipped, too large or unreadable: ${skipped.join(', ')})\x1b[0m`);
  if(!files.length) return prompt;

  console.log(`\x1b[2m(attached: ${files.map(f => f.path).join(', ')})\x1b[0m`);
  return `${prompt}\n\n${formatFileBlocks(files)}`;
}

function applyFileBlocks(reply, root) {
  const blocks = extractFileBlocks(reply);
  if(!blocks.length) return;

  const { written, rejected } = saveFileBlocks(blocks, root);

  for(const path of written) console.log(`\x1b[32mmodified: ${path}\x1b[0m`);
  for(const path of rejected) console.log(`\x1b[31mrefused to write (unsafe path): ${path}\x1b[0m`);
}

async function main() {
  const opts = parseArgs(scriptArgs.slice(1));
  const client = new OllamaClient(opts);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  console.log(`ollama-repl: ${opts.model} @ ${opts.host}:${opts.port}  (root: ${opts.root})`);
  console.log(`Type a prompt and press Enter. Reference files by name or glob (e.g. src/*.js) to attach them. /help for commands.\n`);

  for(;;) {
    std.out.puts('you> ');
    std.out.flush();

    const line = std.in.getline();
    if(line === null) break; // EOF (Ctrl-D)

    const prompt = line.trim();
    if(!prompt) continue;

    if(prompt === '/exit' || prompt === '/quit') break;

    if(prompt === '/reset') {
      messages.length = 1;
      console.log('(conversation reset)');
      continue;
    }

    if(prompt === '/help') {
      console.log('/reset - clear conversation history\n/exit  - quit\nAnything else is sent to the model as a prompt.');
      continue;
    }

    const withFiles = attachFiles(prompt, opts.root);
    messages.push({ role: 'user', content: withFiles });

    let reply;
    try {
      reply = await client.chat(messages);
    } catch(e) {
      console.log(`\x1b[31merror: ${e.message}\x1b[0m`);
      messages.pop(); // don't leave a dangling user turn with no reply
      continue;
    }

    messages.push({ role: 'assistant', content: reply });

    console.log(`\nqwen> ${reply}\n`);
    applyFileBlocks(reply, opts.root);
  }

  client.destroy();
}

await main();
