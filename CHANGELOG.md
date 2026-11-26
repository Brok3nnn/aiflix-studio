# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-26

### Added

- First public release of AIFLIX Studio: premise, runtime and look in; a short film with its
  own cast, scene plan, end card and poster out.
- Director plan (Gemini, JSON mode) with validation and defaults, and a locked second pass for
  the synopsis and poster direction.
- Exact-runtime planner: 6-20 second clips that add up to the requested runtime.
- One fal.ai LTX 2.3 clip per scene, with a text-only style lock and character lock.
- Single-pass ffmpeg edit with exact trim and an end card drawn with a bundled OFL font.
- Mock provider mode that runs the whole pipeline offline with no keys.
- Retries with backoff, `Retry-After` support, model fallback chains, resumable jobs and
  start-up recovery of interrupted jobs.
- Cost guards: one running job at a time and a cap on clips per job.
- Result view with the film, poster, synopsis, cast and scene list, and a live job monitor.
- MongoDB persistence behind a repository interface, with an in-memory store for tests and
  the demo.
- Tests, linting, formatting, type checks and CI.
