# Claude notes

## Workflow

- Solo repo: nobody else commits here. Pull requests are a formality — skip
  them. When a change is done and tests pass, merge the working branch
  straight into `main` with a descriptive commit/merge message and push.
- Run `npm test` before merging (needs `npm ci` first in a fresh container —
  the suite imports `three` from node_modules).
