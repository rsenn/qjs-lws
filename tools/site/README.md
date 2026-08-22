# tools/site — the qjs-lws GitHub Pages site

Generates <https://rsenn.github.io/qjs-lws/> from the repo's own markdown.
No toolchain beyond `qjsm` itself: the markdown renderer and the syntax
highlighter are in here.

```sh
qjsm tools/site/build.js          # -> _site/  (gitignored)
qjsm tools/site/build.js /tmp/out # or anywhere else
```

| File | Role |
|------|------|
| `build.js` | site map, link rewriting, page shell, entry point |
| `markdown.js` | CommonMark/GFM subset renderer (see its header for what's deliberately missing) |
| `highlight.js` | js / sh / c tokenizer for fenced blocks |
| `landing.html` | hand-written landing page body; `<x-code lang="…">` blocks go through `highlight.js` |
| `style.css` | one stylesheet, light and dark |
| `favicon.svg` | tab icon |

## Adding or moving a doc page

`NAV` at the top of `build.js` is the whole site map: each entry is
`[markdown source, output path, sidebar label]`. Adding a `doc/**.md` file
without listing it there means it does not get built, and inter-doc links
pointing at it fall back to a github.com blob URL instead of a site page.

Everything is linked with relative paths, so the output works both under
the project-pages prefix and from a local `file://` checkout.

## Publishing

The site is served from the orphan `gh-pages` branch, which holds only
generated output:

```sh
git worktree add ../qjs-lws-pages gh-pages
qjsm tools/site/build.js ../qjs-lws-pages
cd ../qjs-lws-pages && git add -A && git commit -m 'Rebuild site' && git push
```

`.nojekyll` is emitted by the build so GitHub serves the files as-is.
