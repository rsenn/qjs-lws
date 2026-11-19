/* tool calls in a chat reply: every top level JSON object that names one of
   the tools, however the page decorated it (code block labels, copy buttons,
   ...) and however loosely the model shaped it:
     {"name":..,"arguments":{..}}  the asked-for shape
     {"name":..,"parameters":{..}} / "args" / "input"
     {"name":..,"arguments":"{..}"} arguments as a JSON string
     {"name":..,"path":".."}        flat: the keys the schema lists
     {"function":{"name":..,..}}    OpenAI shape
   a call without the arguments its schema requires is dropped */

const ARG_KEYS = ['arguments', 'parameters', 'args', 'input'];

function schemaOf(tool) {
  return (tool.function ?? tool).parameters ?? {};
}

function callOf(o, tools) {
  if(o && typeof o.function == 'object' && o.function) o = { ...o.function, ...(o.name ? { name: o.name } : {}) };
  const name = o?.name ?? o?.tool ?? o?.tool_name;
  const tool = tools.find(t => (t.function ?? t).name == name);
  if(!tool) return null;

  const schema = schemaOf(tool), props = schema.properties ?? {};
  let args;
  for(const k of ARG_KEYS) {
    if(o[k] === undefined) continue;
    args = o[k];
    if(typeof args == 'string') {
      try {
        args = JSON.parse(args);
      } catch(e) {
        args = undefined;
      }
    }
    break;
  }
  if(args === undefined) {
    args = {};
    for(const k of Object.keys(props)) if(o[k] !== undefined) args[k] = o[k];
  }
  if(!args || typeof args != 'object' || Array.isArray(args)) return null;
  if((schema.required ?? []).some(k => args[k] === undefined)) return null;
  return { name, arguments: args };
}

export function extractCalls(text, tools) {
  text = text.replace(new RegExp('[' + [0xa0, 0x200b, 0x2028, 0x2029].map(c => String.fromCharCode(c)).join('') + ']', 'g'), ' '); /* rendered code blocks */
  const calls = [];
  for(let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    let depth = 0, str = false, esc = false, j = i;
    for(; j < text.length; j++) {
      const c = text[j];
      if(str) {
        if(esc) esc = false;
        else if(c == '\\') esc = true;
        else if(c == '"') str = false;
      } else if(c == '"') str = true;
      else if(c == '{') depth++;
      else if(c == '}' && --depth == 0) break;
    }
    if(depth) break;
    try {
      const call = callOf(JSON.parse(text.slice(i, j + 1)), tools);
      if(call) {
        calls.push(call);
        i = j;
      }
    } catch(e) {}
  }
  return calls;
}
