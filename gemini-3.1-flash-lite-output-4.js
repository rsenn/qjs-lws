// Add this to your imports at the top
import { MutationObserver } from '../qjs-modules/lib/dom.js'; 

// ... inside buildShims(doc) ...

    // MutationObserver (from imported module)
    MutationObserver: MutationObserver,

// ... inside main() ...

  // 3. Install globals
  // ...
  globalThis.MutationObserver = win.MutationObserver;