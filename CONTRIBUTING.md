# Contributing

Thanks for your interest in AIFLIX Studio. Issues and pull requests are welcome.

## Setup

You need Node.js 24 and ffmpeg on your `PATH`.

```bash
npm ci
npm run dev      # web client on http://127.0.0.1:5173, API on http://127.0.0.1:3001
```

With no `.env`, the studio uses the offline mock providers and an in-memory store, so you can
work on almost everything without API keys and without spending money. See the README for
live mode and MongoDB.

## Before you open a pull request

Run every check that CI runs:

```bash
npm run check    # lint, format check, type check (server and client) and tests
npm run build    # production build of the web client
```

`npm run format` fixes formatting. Tests must not need the network or API keys: use the fakes
in `server/test/helpers.ts` or the mock providers. The end-to-end test is skipped when ffmpeg
is missing locally, but it always runs in CI.

## Commit messages

- Write the subject in the imperative mood, at most about 72 characters: "Add clip cap to the
  studio form", not "Added" or "Adds".
- Explain in the body why the change is needed when it is not obvious.
- Keep one logical change per commit.

## Proposing changes

- For bugs, open an issue with the bug report template and include the job log.
- For larger changes or new providers, open a feature request first so the approach can be
  agreed before you write code. Mention any change in the number of paid API calls.
- Keep pull requests focused, and update the README and `.env.example` when behaviour or
  configuration changes.

By contributing you agree that your contributions are licensed under the MIT licence, and to
follow the [Code of Conduct](CODE_OF_CONDUCT.md).
