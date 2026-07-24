# CLAUDE.md

## BUGS file format

Newly discovered bugs (see root `CLAUDE.md`, "Track Newly Discovered Bugs")
are appended to `BUGS` in this directory, one entry per bug, shaped like:

    - <canonical-name> (<file>:<line>): <short plain-text description
      of what's broken and how it was confirmed>

        <JS code that triggers it, or a one-line note if not
        practically reproducible in plain JS>

`BUGS` itself is plain lowercase text: no back-quotes in descriptions,
keep descriptions to a sentence or two, and always include the source
location of the bug.
