import { WritableStream, ReadableStream, TransformStream } from './streams.js';
import { exec, pipe, close, read } from 'os';

export function SubprocessStream(args, options = {}) {
  let stdin, stdout, stderr;

  options.block = false;

  [options.stdin, stdin] = pipe();
  [stdout, options.stdout] = pipe();
  [stderr, options.stderr] = pipe();

  const pid = exec(args, options);

  for(let fd of [options.stdin, options.stdout, options.stderr]) close(fd);

  return {
    pid,
    stdin: new WritableStream({
      write(chunk) {
        let r = write(stdin, chunk);
        console.log('wrote', r);
      },
    }),
    stdout: new ReadableStream({
      buf: new ArrayBuffer(1024),
      async pull(controller) {
        const r = read(stdout, this.buf, 0, 1024);

        if(r > 0) controller.enqueue(this.buf.slice(0, r));
        else controller.close();
      },
    }),
    stderr: new ReadableStream({
      buf: new ArrayBuffer(1024),
      async pull(controller) {
        const r = read(stderr, this.buf, 0, 1024);

        if(r > 0) controller.enqueue(this.buf.slice(0, r));
        else controller.close();
      },
    }),
  };
}
