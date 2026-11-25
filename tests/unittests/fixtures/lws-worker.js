/* os.Worker body for test-multi-runtime.js: loads lws.so in a second JSRuntime.
   A worker has no module-path normalizer of its own, so the parent passes
   the full path of lws.so. */
import * as os from 'os';

os.Worker.parent.onmessage = async e => {
  try {
    const { LWSContext } = await import(e.data.lws);

    new LWSContext({}).destroy();
    os.Worker.parent.postMessage({ done: true });
  } catch(err) {
    os.Worker.parent.postMessage({ done: true, error: String(err) });
  }
};
