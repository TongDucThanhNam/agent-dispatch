ALWAYS RESPOND IN ENGLISH

## Code search & navigation

Routing: `rg` for literal text, symbols, filenames. `ast-grep` when the *shape* of
code matters (call sites, argument patterns, migrations, refactors). LSP/compiler
for references, types, call graphs — ast-grep is syntax-only (no scope, type, or
flow analysis). File discovery respects .gitignore and skips hidden files by
default (`--no-ignore hidden` or `--globs '!gen/**'` to override).

### Structural search: `ast-grep run`
- `ast-grep run -p '<pattern>' [paths...]` matches AST nodes, not text —
  whitespace/comments don't matter; language inferred from extensions (`-l ts` to
  force). Always single-quote patterns (shell eats `$VAR`). Exit 1 = no matches.
- Metavariables: `$VAR` = one named node; `$$$ARGS` = zero or more (lazy, like TS
  `infer`); `$_` = non-capturing. Same `$VAR` twice requires identical code
  (`$A == $A`). Examples: `console.log($$$)` (any arity); `$O.$METHOD($$$)`
  (any method call); `function $F($$$ARGS) { $$$ }`.
- `-k 'call_expression > identifier'` matches by tree-sitter kind (ESQuery style).
- Pattern matches nothing? It probably parses as a different node kind
  (statement vs expression). Check with `--debug-query ast` + `-l`, or the
  playground. Fragments that don't parse standalone need a pattern object
  (`context:` + `selector:`) — see scan rules below.
- Use over `rg` when a search needs syntax awareness: exact arg counts, call vs
  reference, excluding strings/comments, same-node twice.

### Rewrites (codemods)
- `ast-grep run -p 'oldApi($$$A)' -r 'newApi($$$A)' [paths]` — metavariables carry
  into the rewrite. Dry-run by default (prints diff). Applied ONLY with `-U`
  (all) or `-i` (confirm each). Before `-U`, run the same search with `--json`
  and review every `replacement`.

### Complex queries: `ast-grep scan --inline-rules '<yaml>'
When one pattern isn't enough — context, exclusions, metavariable filters:

  ast-grep scan --inline-rules '
    id: hooks-in-component
    language: tsx
    severity: warning
    message: hook $HOOK called in component
    rule:
      pattern: $HOOK($$$ARGS)
      inside: { kind: function_declaration, stopBy: end }
    constraints:
      HOOK: { regex: "^use" }'

- Toolbox: `pattern` / `kind` / `regex` (Rust regex, no lookahead) / `nthChild`;
  `inside`/`has`/`follows`/`precedes` + `stopBy` (or shorthands
  `pattern-inside`/`pattern-not-inside`); `all`/`any`/`not`; `transform`
  (replace/substring/case-convert) for derived values in `message`/`fix`.
- Rule fields are unordered; wrap in `all: [...]` when metavariable capture
  order matters. Sibling `kind:` does NOT scope pattern parsing — use the
  pattern object (`context:` + `selector:`).
- Project-wide: `ast-grep new` scaffolds `sgconfig.yml` + `rules/`; `scan` runs
  all rules; `--format github|sarif` for CI (exit 1 only on `error`-severity
  matches); `fix:` + `-U` autofixes; `ast-grep test` snapshot-tests rules.

### Structural map: `ast-grep outline`
- Before reading a large/unfamiliar file: `ast-grep outline <path>` (files default
  to signatures + member digest). Zoom into one symbol with
  `--match '<regex>' --view expanded` (per-member lines with line numbers).
- Directories default to public surface (`--items exports --view names`); use
  `--items structure` for all top-level decls, `--items imports` for
  dependencies, `--type class,enum,function` to narrow. Skip when `rg` already
  pinpoints the code.