import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { ReadableStream, WritableStream, TransformStream } from '../../lib/lws/streams.js';

async function readAll(readable) {
  const reader = readable.getReader();
  const out = [];
  for(;;) {
    const { value, done } = await reader.read();
    if(done) break;
    out.push(value);
  }
  return out;
}

await tests({
  async 'ReadableStream: enqueue then close, reader sees all chunks then done'() {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.close();
      },
    });
    const chunks = await readAll(rs);
    eq('a,b', chunks.join(','));
  },

  async 'ReadableStream: for-await-of iterates chunks'() {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.close();
      },
    });
    const out = [];
    for await(const chunk of rs) out.push(chunk);
    eq('1,2', out.join(','));
  },

  async 'ReadableStream: pull is called lazily to produce chunks'() {
    let pulls = 0;
    const rs = new ReadableStream({
      pull(controller) {
        pulls++;
        if(pulls > 3) {
          controller.close();
          return;
        }
        controller.enqueue(pulls);
      },
    });
    const chunks = await readAll(rs);
    eq('1,2,3', chunks.join(','));
    assert(pulls >= 4, 'expected pull() to be called at least 4 times (3 chunks + close), got ' + pulls);
  },

  async 'ReadableStream: cancel() invokes the cancel algorithm'() {
    let cancelReason;
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('x');
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    await rs.cancel('nope');
    eq('nope', cancelReason);
  },

  async 'ReadableStream: getReader() a second time throws (stream locked)'() {
    const rs = new ReadableStream({
      start(c) {
        c.close();
      },
    });
    rs.getReader();
    try {
      rs.getReader();
      fail('expected a throw acquiring a second reader on a locked stream');
    } catch(e) {
      /* expected */
    }
  },

  async 'ReadableStream.tee() produces two independent copies'() {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('x');
        controller.close();
      },
    });
    const [a, b] = rs.tee();
    const [chunksA, chunksB] = await Promise.all([readAll(a), readAll(b)]);
    eq('x', chunksA.join(','));
    eq('x', chunksB.join(','));
  },

  async 'WritableStream: write() then close(), sees every chunk'() {
    const seen = [];
    const ws = new WritableStream({
      write(chunk) {
        seen.push(chunk);
      },
    });
    const writer = ws.getWriter();
    await writer.write('a');
    await writer.write('b');
    await writer.close();
    eq('a,b', seen.join(','));
  },

  async 'WritableStream: abort() invokes the abort algorithm'() {
    let abortReason;
    const ws = new WritableStream({
      abort(reason) {
        abortReason = reason;
      },
    });
    const writer = ws.getWriter();
    await writer.abort('bail');
    eq('bail', abortReason);
  },

  async 'TransformStream: identity pass-through'() {
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    });
    const writer = ts.writable.getWriter();
    writer.write('a');
    writer.write('b');
    writer.close();
    const chunks = await readAll(ts.readable);
    eq('a,b', chunks.join(','));
  },

  async 'TransformStream: transform can map chunks'() {
    const ts = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk * 2);
      },
    });
    const writer = ts.writable.getWriter();
    writer.write(1);
    writer.write(2);
    writer.close();
    const chunks = await readAll(ts.readable);
    eq('2,4', chunks.join(','));
  },
});
