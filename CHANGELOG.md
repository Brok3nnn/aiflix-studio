# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Films of three or more clips are frame-exact: a frame no longer goes missing at scene cuts, and
  a 64-second film is 1,600 frames and 64.000 seconds long.
- The macOS instructions for end-card text pass `FFMPEG_PATH` and `FFPROBE_PATH` on the command
  line; `$(...)` is not expanded in `.env`.
- Copying `.env.example` no longer makes MongoDB a requirement, and an unreachable MongoDB stops
  the server with a one-line hint instead of a stack trace.
- While a film renders, the page no longer restarts a playing video, closes the story bible or
  moves the job log you are reading.

### Changed

- A paid fal.ai render request is sent again only after a rate limit or a connection that never
  opened, so a timed-out render is not paid twice; the scene fails and the film can be resumed.
- In live mode, **Generate film** and **Resume** ask for confirmation with the expected number of
  paid calls.
- Default Gemini models: `gemini-3.8-flash` (fallback `gemini-3.6-flash`) for the director and
  `gemini-3.1-flash-image` (fallback `gemini-3.1-flash-lite-image`) for the poster, replacing the
  deprecated `gemini-2.5-flash` and `gemini-2.5-flash-image` and the preview fallbacks, one of
  which Google has shut down. The director no longer falls back to a Pro-priced model.
- Gemini requests no longer set a temperature: Gemini 3 models use their defaults, as Google
  advises.
- The README has a quick start, ffmpeg install commands and fewer repeats.

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

[Unreleased]: https://github.com/Brok3nnn/aiflix-studio/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Brok3nnn/aiflix-studio/releases/tag/v1.0.0
