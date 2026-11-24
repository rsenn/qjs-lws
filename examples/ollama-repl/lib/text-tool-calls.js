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
 * Also the XML form (Qwen3/nemotron templates):
 * <tool_call><function=NAME><parameter=KEY>value</parameter></function></tool_call>
 */

/** `value` (text) converted per the tool's schema type for `key`; JSON where it parses for non-strings. */
function coerce(value, type) {
  if(type === 'string' || !type) return value;
  try {
    return JSON.parse(value);
  } catch(e) {
    return value;
  }
}

/** XML-style calls: [{ name, args, span: [start, end) }] for offered tools. */
function xmlCalls(content, tools) {
  const out = [];
  const re = /(?:<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)(?:<\/function>\s*(?:<\/tool_call>)?|$)/g;

  for(const m of content.matchAll(re)) {
    const tool = tools.find(t => t.name === m[1]);
    if(!tool) continue;

    const args = {};
    for(const p of m[2].matchAll(/<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g))
      args[p[1]] = coerce(p[2].replace(/^\n/, '').replace(/\n$/, ''), tool.parameters?.properties?.[p[1]]?.type);

    out.push({ name: tool.name, args, span: [m.index, m.index + m[0].length] });
  }

  return out;
}

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

  for(const { name, args, span } of xmlCalls(content, tools)) {
    toolCalls.push({ id: `${name}#${toolCalls.length}`, name, args });
    cuts.push(span);
  }

  for(const [start, end] of objectSpans(content)) {
    let obj;
    try {
      obj = JSON.parse(content.slice(start, end));
    } catch(e) {
      continue;
    }

    /* inside an XML call already taken */
    if(cuts.some(([a, b]) => start >= a && start < b)) continue;

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
  for(const [a, b] of cuts.sort((x, y) => x[0] - y[0])) {
    out += content.slice(pos, a);
    pos = b;
  }
  out += content.slice(pos);

  return { content: out.trim(), toolCalls };
}
