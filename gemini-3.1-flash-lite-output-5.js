// If the imported observer is a factory or needs the doc:
globalThis.MutationObserver = class extends MutationObserver {
  constructor(cb) {
    super(cb);
    // You might need to manually link it to your doc if it's not global
  }
};