// Bridges the push-driven onRawRx callback into pull-style reads, so the
// frame decoder below can be written top-to-bottom like a synchronous
// parser (mirrors readFully()'s contract: resolves the requested number of
// bytes, or null once closed).
export class ByteQueue {
  #buf = new Uint8Array(0);
  #closed = false;
  #waiting = null; // { n, resolve }

  feed(chunk) {
    const add = new Uint8Array(chunk);
    const buf = new Uint8Array(this.#buf.length + add.length);
    buf.set(this.#buf, 0);
    buf.set(add, this.#buf.length);
    this.#buf = buf;
    this.#check();
  }

  close() {
    this.#closed = true;
    this.#check();
  }

  read(n) {
    return new Promise(resolve => {
      this.#waiting = { n, resolve };
      this.#check();
    });
  }

  #check() {
    if(!this.#waiting) return;

    const { n, resolve } = this.#waiting;

    if(this.#buf.length >= n) {
      resolve(this.#buf.slice(0, n));
      this.#buf = this.#buf.subarray(n);
      this.#waiting = null;
    } else if(this.#closed) {
      resolve(null);
      this.#waiting = null;
    }
  }
}
