# @drumee/server-essentials

The shared primitives every [Drumee](https://drumee.com) back-end service is
built on.

[![npm](https://img.shields.io/npm/v/@drumee/server-essentials)](https://www.npmjs.com/package/@drumee/server-essentials)

```console
npm i @drumee/server-essentials
```

---

## What it is

The lowest layer of the Drumee back-end stack. It provides the building blocks
that everything above it — including
[`@drumee/server-core`](https://github.com/drumee/server-core) — assumes:

- **MariaDB** access and query helpers
- **Cache** and the Redis store
- **Logging**
- **Email** delivery and **templating**
- **Crypto** helpers
- **Offline** and background worker primitives

It is a library with no entry point of its own. It is the most widely depended-on
package in the organisation: `server-core`, `server-team`, `schemas`,
`services-router`, `setup-infra`, `setup-schemas`, `shell`, `sandbox-server`,
`loby` and `starter-kit` all build on it.

## Layout

| Path | What it holds |
|---|---|
| `lib/` | The library; `lib/index.js` is the entry point |
| `templates/` | Email and document templates |
| `bin/` | Maintenance scripts |

## Tests

```console
npm test                # test:modules, test:acl and test:db in sequence
npm run test:crypto
npm run test:email
npm run test:template
npm run test:db
npm run show:cache      # dump the current cache state
npm run show:sysEnv     # dump the resolved system environment
```

These run against a **live environment** rather than in isolation, so a failure
often means the environment is not up. Check that first.

## Contributing

See the org [CONTRIBUTING guide](https://github.com/drumee/.github/blob/main/CONTRIBUTING.md).
Questions: [Discussions](https://github.com/orgs/drumee/discussions).

## License

AGPL-3.0 — see [LICENSE](LICENSE).
