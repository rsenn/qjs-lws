#!/usr/bin/env qjsm
/**
 * ollama-repl-ctl - talk to a running `ollama-repl --listen` session.
 *
 *   ollama-repl-ctl list                      live sessions
 *   ollama-repl-ctl [-s SESSION] send LINE    type LINE into the session and
 *                                             print its output until it is idle
 *   ollama-repl-ctl [-s SESSION] watch        print the session's output
 *
 * SESSION is a session name (ollama-repl --name), a pid, a model-name
 * fragment or a socket path; optional when exactly one session is live.
 * With no matching session it waits (stderr says so) for the user to start
 * one. Options: -t SECS (wait/send timeout, default 600), --json (print the
 * raw events).
 * Exit status: 0 idle again, 3 the session waits for the user at the
 * terminal (y/N or ask_user - only the user can answer), 124 timeout
 * (nothing to wait for, or a send that did not finish),
 * 1 error.
 */
import { exit, err as stderr, out as stdout } from 'std';
import { setReadHandler, setTimeout, sleep } from 'os';
import { AF_UNIX, SOCK_STREAM, SockAddr, Socket } from 'sockets';
import { listSessions } from './lib/control-socket.js';

function fail(msg, code = 1) {
  stderr.puts(`ollama-repl-ctl: ${msg}\n`);
  exit(code);
}

const args = scriptArgs.slice(1);
let session, timeout = 600, json = false;
const rest = [];

for(let i = 0; i < args.length; i++) {
  if(args[i] === '-s') session = args[++i];
  else if(args[i] === '-t') timeout = +args[++i];
  else if(args[i] === '--json') json = true;
  else rest.push(args[i]);
}

const [cmd, ...words] = rest;

if(cmd === 'list') {
  for(const s of listSessions()) stdout.puts(`${s.name}\t${s.pid}\t${s.provider}/${s.model}\t${s.root}\t${s.sock}\n`);
  exit(0);
}

if(cmd !== 'send' && cmd !== 'watch') fail('usage: ollama-repl-ctl list | [-s SESSION] send LINE | [-s SESSION] watch');

const match = s => (session ? s.name === session || String(s.pid) === session || s.sock === session || s.model.includes(session) : true);
const sessionLabel = session ? `session "${session}"` : 'an ollama-repl --listen session';

/* Nobody listening yet: wait for the user to start one (never started from
   here - it needs their terminal). The message goes to stderr so it shows
   in the controller's output while this blocks. */
let found = listSessions().filter(match);
if(!found.length) {
  stderr.puts(`ollama-repl-ctl: waiting for ${sessionLabel} - start one in a terminal: ollama-repl --listen --name NAME --model M\n`);
  for(let waited = 0; !found.length; waited++) {
    if(waited >= timeout) fail(`gave up waiting for ${sessionLabel} after ${timeout}s`, 124);
    sleep(1000);
    found = listSessions().filter(match);
  }
  stderr.puts(`ollama-repl-ctl: found ${found[0].name}\n`);
}

/* an exact name beats a model-name fragment */
if(found.length > 1 && session) {
  const exact = found.filter(s => s.name === session);
  if(exact.length === 1) found = exact;
}

if(found.length !== 1) fail(`${found.length} sessions match, pick one with -s NAME:\n${found.map(s => `  ${s.name}\t${s.pid} ${s.model} ${s.root}`).join('\n')}`);

const line = words.join(' ');
if(cmd === 'send' && !line.trim()) fail('send: nothing to send');

const sock = new Socket(AF_UNIX, SOCK_STREAM);
try {
  sock.connect(new SockAddr(AF_UNIX, found[0].sock));
} catch(e) {
  fail(`cannot connect to ${found[0].sock}: ${e.message}`);
}

let sent = false, accepted = false, buf = '';
const dec = new TextDecoder();

const handle = ev => {
  if(json) stdout.puts(JSON.stringify(ev) + '\n');

  switch(ev.type) {
    case 'hello':
      if(cmd === 'send') {
        sock.send(line.replaceAll('\n', ' ') + '\n');
        sent = true;
      }
      break;
    case 'accepted':
      accepted = true;
      break;
    case 'output':
      if(!json) stdout.puts(ev.text);
      break;
    case 'waiting':
      if(cmd === 'send' && accepted) {
        stdout.flush();
        stderr.puts(`\nollama-repl-ctl: session waits for the user at the terminal (${ev.kind}): ${ev.text}\n`);
        exit(3);
      }
      break;
    case 'ready':
      if(cmd === 'send' && accepted) {
        stdout.flush();
        exit(0);
      }
      break;
  }
};

setReadHandler(sock.fd, () => {
  const chunk = new ArrayBuffer(65536);
  const n = sock.recv(chunk);

  if(n === 0) {
    stdout.flush();
    fail('session closed the connection', cmd === 'watch' ? 0 : 1);
  }
  if(n < 0) return;

  buf += dec.decode(new Uint8Array(chunk, 0, n), { stream: true });

  let nl;
  while((nl = buf.indexOf('\n')) !== -1) {
    const l = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if(l) handle(JSON.parse(l));
  }
});

if(cmd === 'send')
  setTimeout(() => {
    stdout.flush();
    fail(`timeout after ${timeout}s (the session keeps working)`, 124);
  }, timeout * 1000);
