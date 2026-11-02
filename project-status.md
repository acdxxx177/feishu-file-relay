# Project status

## Current state as of 2026-11-02

The repository has a locally verified development scaffold. [PRD.md](PRD.md) v1.0 defines the MVP and its acceptance criteria. The Word edition is also present. The root [agent instructions](AGENTS.md), product context, and project agent definitions provide development guidance. Local skill resources are available in .agents/skills/.

All three agent TOMLs parsed successfully. A fresh read-only Codex CLI session discovered `feishu-events`, `download-streaming`, and `relay-reviewer` with their configured descriptions. This check covered discovery only.

The scaffold implements the environment setup from PRD §5.1 and §11 M2, the health endpoint from §7, and the minimal entrypoint structure from §10. It uses pnpm 11.24.0, Hono 4.13.16, TypeScript 7.0.2, Wrangler 4.156.2, and Hono CLI 0.1.11. Verification ran on Node.js 24.20.0 on Windows. The private ESM package and lockfile are present, and `wrangler.jsonc` sets the compatibility date to `2026-11-02` without resource bindings or compatibility flags.

`src/index.ts` exports a Hono app with `GET /health`, returning HTTP 200 and exactly `{"status":"ok"}` as JSON. Unknown paths retain Hono's default 404. Scripts provide local development, generated Worker types, strict TypeScript checking, a local dry-run build, and a deployment command. [README.md](README.md) documents setup and commands in Chinese.

Feishu integration, D1, caching, migrations, business logic, and a test runner are not implemented. No Cloudflare authentication, deployment, or remote resource creation was performed. There is no recorded result for a live Feishu callback, a large-file transfer, a cache hit, or an end-to-end acceptance test.

[.env.example](.env.example) lists the local inputs for Feishu callback and M1 range testing. The operator fills the Git-ignored `.env` with test application settings and attachment identifiers and hashes as they become available. No test runner consumes these settings yet.

[.dev.vars.example](.dev.vars.example) contains comments only; the health endpoint needs no variables or credentials. An ignored local `.dev.vars` copy was used for verification so Wrangler would not load the existing `.env`. Existing environment files were preserved. Dependencies, generated runtime types, local Wrangler state, and build output are ignored by Git.

## Decisions

The application scaffold uses pnpm, TypeScript, Hono, and Cloudflare Workers. D1 remains planned. In the intended product, Feishu holds the source bytes, the public Gateway checks D1 on every file request, and an internal entry handles fixed-size cached chunks. [Product scope](context/product.md), [domain rules](context/domain.md), and [workflows](context/workflows.md) document these future contracts.

Use Wrangler directly without adding Vite, a Node.js server adapter, or a test framework. Generate platform types with `wrangler types` before type checking rather than maintaining binding types manually. `pnpm build` runs `wrangler deploy --dry-run --outdir dist`; the separate deployment script requires explicit deployment authorization before use.

The configured npm mirror initially lacked Wrangler 4.156.2, so installation used the official npm registry without changing global configuration. The project-local `pnpm-workspace.yaml` permits installation scripts only for `esbuild` and `workerd` and records pnpm's exact-version release-age exceptions for this dependency set.

## Scaffold validation

Passed:

- `pnpm install --frozen-lockfile --registry=https://registry.npmjs.org/`: lockfile verified and dependencies installed successfully after approving only the required `esbuild` and `workerd` installation scripts.
- `pnpm install --frozen-lockfile`: the documented installation command also completed successfully with the installed dependency set.
- `pnpm typecheck`: generated runtime and environment types, then completed `tsc --noEmit` successfully.
- `pnpm build`: local dry-run bundling succeeded, reporting 59.81 KiB total / 15.10 KiB gzip, no bindings, and an explicit dry-run exit.
- `pnpm exec hono request -P /health -J`: HTTP 200, `application/json`, and the expected JSON body.
- `pnpm dev`: workerd served `http://127.0.0.1:8787`; independent HTTP assertions verified the exact health body, JSON content type, and 200 status, plus 404 for `/not-found`. The server exited successfully afterward, and port 8787 had no remaining listener.
- `git diff --check`, local documentation references, ignore rules for generated files and secrets, and the visibility of both example environment files passed. `git status --short` confirmed the pre-existing staged changes remain present.

Skipped: actual deployment and all Feishu, D1, caching, and large-file acceptance checks, which are outside this setup task.

Blocked: none for the scaffold checks above. Wrangler type generation emitted an advisory about Node.js types; no Node.js imports or compatibility flags are used in the scaffold, and type checking and runtime checks passed without an additional type package.

Pre-existing check issue: `git diff --cached --check` reports trailing spaces in the staged PRD.md lines 3–6 (Markdown hard line breaks). That document and the index were preserved; the setup changes pass `git diff --check`.

## Next priority

Start with M1 in PRD §11 using an authorized Feishu test application and isolated test messages. Verify the callback and paired resource identifiers, read real byte ranges at all three target sizes, establish a trustworthy total length, and compare assembled content against original SHA-256 hashes. Record observed response headers and results without credentials or file content. Resolve discrepancies before implementing registration and downloads.

Attachment retention and cross-region cache behavior are open validation items in PRD §12. The proposed entry-point wiring, cache hit rate, and purge behavior need deployment evidence in the later cache milestone.
