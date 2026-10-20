/**
 * Tool calls a model wrote into its reply text instead of the structured
 * `tool_calls` field - qwen2.5-coder does this routinely through Ollama: it
 * ignores the "<tool_call>...</tool_call>" format its template asks for and
 * answers with a ```json fenced object (or a bare one), so the server never
 * recognizes the call and the REPL would just print it as prose.
 *
 * Recognized: <tool_call>{...}</tool_call>, ```json {...} ``` and a bare
 * {...} object, each `{ "name": <tool>, "arguments"|"parameters"|"args": {...} }`
 * (or an array of them), with `name` being one of the offered tools.
 */

/** Balanced `{...}` objects (string-aware) found anywhere in `text`, as [start, end) spans. */
function objectSpans(text) {
  const spans = [];

  for(let i = 0; i < text.length; i++) {
    if(text[i] !== '{') continue;

    let depth = 0;
    let inStr = false;

    for(let j = i; j < text.length; j++) {
      const c = text[j];

      if(inStr) {
        if(c === '\\') j++;
        else if(c === '"') inStr = false;
      } else if(c === '"') inStr = true;
      else if(c === '{') depth++;
      else if(c === '}' && --depth === 0) {
        spans.push([i, j + 1]);
        i = j;
        break;
      }
    }
  }

  return spans;
}

/**
 * @param {string} content  the reply text
 * @param {{name: string, parameters?: {required?: string[]}}[]} tools  the tools that were offered
 * @returns {{ content: string, toolCalls?: {id: string, name: string, args: object}[] }}
 *   `content` with the recognized call text (and its fence/tags) removed
 */
export function extractTextToolCalls(content, tools) {
  if(!content) return { content };

  const toolNames = tools.map(t => t.name);

  const toolCalls = [];
  const cuts = [];

  for(const [start, end] of objectSpans(content)) {
    let obj;
    try {
      obj = JSON.parse(content.slice(start, end));
    } catch(e) {
      continue;
    }

    let name = obj?.name ?? obj?.function?.name;
    let args = obj?.arguments ?? obj?.parameters ?? obj?.args ?? obj?.function?.arguments;

    /* just the arguments object, no name (qwen2.5-coder: {"items": [...], "task": "..."}):
       it is that tool's call if its keys cover exactly one tool's required parameters */
    if(name === undefined && obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const fits = tools.filter(t => t.parameters?.required?.length && t.parameters.required.every(k => k in obj));
      if(fits.length === 1) {
        name = fits[0].name;
        args = obj;
      }
    }

    if(typeof name !== 'string' || !toolNames.includes(name)) continue;

    if(typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch(e) {
        continue;
      }
    }

    toolCalls.push({ id: `${name}#${toolCalls.length}`, name, args: args ?? {} });

    /* swallow a surrounding ```json fence / <tool_call> tags with the object */
    let a = start;
    let b = end;
    const before = content.slice(0, a).match(/(```[a-z]*\s*|<tool_call>\s*)$/);
    const after = content.slice(b).match(/^(\s*```|\s*<\/tool_call>)/);
    if(before) a -= before[0].length;
    if(after) b += after[0].length;
    cuts.push([a, b]);
  }

  if(!toolCalls.length) return { content };

  let out = '';
  let pos = 0;
  for(const [a, b] of cuts) {
    out += content.slice(pos, a);
    pos = b;
  }
  out += content.slice(pos);

  return { content: out.trim(), toolCalls };
}
