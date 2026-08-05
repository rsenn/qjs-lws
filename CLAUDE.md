# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## BUGS file format

Newly discovered bugs (see root `CLAUDE.md`, "Track Newly Discovered Bugs")
are appended to `BUGS` in this directory, one entry per bug, in the order
found, shaped like:

    - <canonical-name> (<file>:<line>): <short plain-text description
      of what's broken and how it was confirmed>

        <JS code that triggers it, or a one-line note if not
        practically reproducible in plain JS>

`canonical-name` is a short kebab-case handle for referring back to the
bug elsewhere (commit messages, other BUGS entries). The source location
is the primary place the bug lives, not every place it's felt.

`BUGS` itself is plain lowercase text: no back-quotes in descriptions,
keep descriptions to a sentence or two, and always include the source
location of the bug.

Always append newly discovered bugs to `BUGS` as soon as you find them,
without asking first or waiting to be told - this applies any time you're
working in this directory, not just when explicitly hunting for bugs.
Check at the end of a task whether anything surfaced during the work
(errors seen while testing, oddities noticed while reading code, things
that "shouldn't happen" but did) got logged; if not, log it before
finishing.

## Running scripts with qjsm

To run a script (e.g. a throwaway test file while debugging), invoke it
as the plain positional argument: `qjsm script.js [args]` - same as
`repl.js`'s own header comment documents running itself
(`qjsm repl.js [--model ...]`).

Never use `qjsm -m script.js` (or `--module`) for this - `-m`/`--module`
is qjsm's special module loader (package.json/.ts-aware resolution,
per `qjsm --help`: "load an ES6 module"), unrelated to running a script
as the main program. A plain script run without `-m` already supports
`import`/`export` (it's ES module syntax either way) - `-m` is not
"the way to get module support", it's a different, unrelated loading
path, and using it to run a script is a category error, not just a
stylistic difference.

## Subproject TODO.md files

Several subdirectories (e.g. `examples/ollama-repl/`) keep their own
`TODO.md` tracking that subproject's known gaps and planned work. Any
time work in this directory changes the state of something a `TODO.md`
describes - an item gets implemented, partially implemented, discovered
to be harder/easier than described, or a change exposes a new gap - update
that subproject's `TODO.md` to match before finishing, without waiting to
be asked. Move finished items into a "Done" section (or delete them if
they're not worth keeping as a record) rather than leaving them listed as
still-open; note new gaps discovered along the way the same way `BUGS`
entries are noted. This applies to every `TODO.md` under this directory,
not just the one being actively discussed.
