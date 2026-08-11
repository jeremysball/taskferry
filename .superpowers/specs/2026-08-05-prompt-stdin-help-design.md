# Prompt stdin help design

## Goal

Close issue #300 by making the existing `--prompt -` stdin behavior discoverable in the generated help for both `dispatch` and `advisor`.

## Scope

Update the command help metadata in `src/command-specs.js`:

- Change both prompt option labels from `--prompt <text>` to `--prompt <text|->`.
- Explain that `-` reads the prompt from piped stdin.
- Add a stdin example for both commands.

Add focused assertions in `src/args.test.js` that the dispatch and advisor help payloads expose the stdin guidance and examples.

Do not change parsing or runtime behavior. `src/cli.js` already recognizes `--prompt -` for both commands and reads stdin before dispatching.

## Verification

Run the focused argument tests and the repository's standard test/lint checks appropriate to the changed files. Confirm the rendered `dispatch --help` and `advisor --help` output contains the stdin label, explanation, and examples.

## Out of scope

- Changing stdin reading semantics.
- Refactoring shared help constants.
- Updating the already-correct long-form CLI reference documentation.
