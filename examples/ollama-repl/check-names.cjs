/**
 * check-names: finds names a module uses but never declares or imports (the `'fg' is not defined` class: the code
 * parses and the tests pass, the request fails when the path runs). A flat check: any declaration anywhere in the file
 * counts, so it does not find a name used outside its scope, only a name that is declared nowhere.
 *
 *   node --expose-internals check-names.cjs repl.js $(find lib -name '*.js') ctl.js usage-baseline.js
 *
 * Uses the acorn parser that comes with node (hence --expose-internals). Prints `file:line: name`, exit status 1 when any.
 */
const acorn = require('internal/deps/acorn/acorn/dist/acorn');
const walk = require('internal/deps/acorn/acorn-walk/dist/walk');
const fs = require('fs');
const GL = new Set([...Object.getOwnPropertyNames(globalThis), 'scriptArgs', 'std', 'os', 'print', 'console', 'globalThis', 'arguments', 'undefined']);
let bad = 0;
for(const f of process.argv.slice(2)) {
  let src = fs.readFileSync(f, 'utf8').replace(/^#!.*/, '');
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true }); } catch(e) { console.log(f, 'PARSE', e.message); continue; }
  const decl = new Set();
  const addPat = p => { if(!p) return; if(p.type === 'Identifier') decl.add(p.name); else if(p.type === 'ObjectPattern') p.properties.forEach(x => addPat(x.value ?? x.argument)); else if(p.type === 'ArrayPattern') p.elements.forEach(addPat); else if(p.type === 'AssignmentPattern') addPat(p.left); else if(p.type === 'RestElement') addPat(p.argument); };
  walk.full(ast, n => {
    if(n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') decl.add(n.local.name);
    if(n.type === 'VariableDeclarator') addPat(n.id);
    if(n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') { if(n.id) decl.add(n.id.name); n.params.forEach(addPat); }
    if(n.type === 'ClassDeclaration' || n.type === 'ClassExpression') n.id && decl.add(n.id.name);
    if(n.type === 'CatchClause') addPat(n.param);
  });
  walk.fullAncestor(ast, (n, _s, anc) => {
    if(n.type !== 'Identifier') return;
    const p = anc[anc.length - 2];
    if(!p) return;
    if((p.type === 'MemberExpression' && p.property === n && !p.computed) || (p.type === 'Property' && p.key === n && !p.computed && !p.shorthand) || (p.type === 'MethodDefinition' && p.key === n) || (p.type === 'PropertyDefinition' && p.key === n) || p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement' || p.type === 'ExportSpecifier' || p.type === 'ImportSpecifier' || p.type === 'MetaProperty') return;
    if(decl.has(n.name) || GL.has(n.name)) return;
    console.log(`${f}:${n.loc.start.line}: ${n.name}`); bad++;
  });
}
console.log(bad, 'undefined names');
process.exit(bad ? 1 : 0);
