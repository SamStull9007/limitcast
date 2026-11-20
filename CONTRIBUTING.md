# Contributing to Limitcast

Start with [Q&A](https://github.com/SamStull9007/limitcast/discussions/categories/q-a) for setup help or [Ideas](https://github.com/SamStull9007/limitcast/discussions/categories/ideas) for proposed changes. Use an issue for a reproducible bug. Small documentation corrections are welcome as pull requests.

## Run locally

Requires Node.js 22+ on macOS or Linux. There are no runtime dependencies to install.

```sh
git clone https://github.com/SamStull9007/limitcast.git
cd limitcast
node bin/limitcast.mjs --version
npm test
node scripts/package-smoke.mjs
npx --yes @biomejs/biome@2.6.3 ci .
```

For the automatic local security check, install Semgrep with `uv tool install --python 3.12 semgrep`, install `pre-commit`, and run `pre-commit install` once in this checkout. Matching staged production code is scanned before each commit; run `pre-commit run semgrep-security --all-files` to check all covered files. The focused rule scope and limits are in [CONSTRAINTS.md](CONSTRAINTS.md).

Keep changes focused on one problem. Explain the behavior before and after, include a small regression test for nontrivial logic, and name any host or operating system you could not test. Update the usage guide when a command changes. Preserve existing hooks, configuration backups, keep-lists, and undo behavior.

## Release preflight

Commit the intended version and plugin pins, push that exact commit, and wait for all eight CI jobs to succeed. Keep the working tree clean. `npm publish` runs `scripts/release-check.mjs` through `prepublishOnly`; it requires authenticated GitHub CLI access and refuses missing, pending, failed or incomplete push CI for HEAD. Run `node scripts/release-check.mjs` to check without publishing. Do not bypass lifecycle scripts or lower coverage floors to publish.

Synthetic optimizer replay checks decision regressions, not savings. Use the [real-task measurement protocol](docs/optimizer-measurement.md) before making effectiveness claims.

## Protect private data

Never attach raw transcripts, credentials, account IDs, private project paths, configuration files, or customer information. Reproduce bugs with small synthetic fixtures. Review any terminal output before posting it, including output from a sharing command.

For a suspected credential or private-data exposure, email support@limitcast.dev instead of opening a public issue. Send a description and reproduction steps without the sensitive values.

## Useful first contributions

- Reproduce a setup problem using synthetic logs and add a fixture.
- Improve an unclear installation or error message.
- Verify a documented workflow on a supported Node/macOS/Linux combination.
- Improve screen-reader descriptions or a confusing documentation example.

Check existing issues and discussions first. For a larger change, discuss the intended behavior before implementing it. Contributions are reviewed for correctness, privacy, compatibility, and scope.
