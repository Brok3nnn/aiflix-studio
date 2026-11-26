# Security policy

## Supported versions

Only the latest `main` is supported. Fixes are not backported.

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue:

- use the **Report a vulnerability** button on the repository's **Security** tab
  (GitHub private vulnerability reporting), or
- email vitanbalint@gmail.com.

Include the steps to reproduce, the affected version or commit, and the impact you expect. You
should get an answer within a week.

## Scope and known limitations

AIFLIX Studio is a local, single-user tool. It has **no authentication**: anyone who can reach
the API can start jobs that spend your Gemini and fal.ai credit and read or delete your films.
By default the server binds to `127.0.0.1` and refuses requests addressed to other host names.
Add authentication before exposing it on a network. Reports about the lack of authentication
on a server that was deliberately exposed are out of scope.
