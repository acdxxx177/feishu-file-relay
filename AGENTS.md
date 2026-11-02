# Repository guidelines

## Start each task

1. Read [project status](project-status.md) for the current implementation, evidence, and next priority.
2. Identify the affected behavior. Read the relevant [product scope](context/product.md), [domain rules](context/domain.md), or [workflows](context/workflows.md). Use [PRD.md](PRD.md) as the requirements baseline and cite its section or feature ID when resolving a question.
3. Read any AGENTS.md in the affected module. Inspect the actual source, configuration, and scripts before changing them. For cross-module changes, check both sides of the interface. Reuse unchanged material already read during the task.

## Where knowledge belongs

Keep shared engineering and collaboration rules here. Write agent instructions, project status, and context in English. Put product knowledge in the root context directory. Once a module exists, put its implementation contracts and storage boundaries in its own context directory and any module-specific commands or exceptions in its nearest AGENTS.md. Write human-facing operating, deployment, and acceptance guides in Chinese under docs/.

Update project-status.md when behavior, architecture, interfaces, decisions, validation, blockers, or priorities materially change. Record the evidence for the current state. Distinguish tools present, dependencies installed, components integrated, behavior implemented, and results verified. A proposed schema or example command in the PRD is design input.

## Engineering rules

- Use pnpm and TypeScript. Use two-space indentation, camelCase for functions and variables, PascalCase for types, kebab-case module names, and snake_case database columns such as `message_id`. Write meaningful code comments in Chinese for non-obvious reasons, compatibility constraints, and design tradeoffs.
- Keep Hono routing, Feishu access, D1 persistence, HTTP Range handling, and internal chunk caching separate. Follow PRD §10 when scaffolding. Prefer small modules, existing patterns, and atomic operations for related event and state changes.
- Check D1 on every public GET and HEAD before accessing any chunk. Keep the chunk entry internal, stream large files, and keep credentials, sensitive headers, and file contents out of logs. Keep secrets out of Git, public URLs, and D1 records. Use placeholders in example environment files.
- Use PowerShell `Get-ChildItem` for file searches and `Get-ChildItem -Recurse` with `Select-String` for content searches. Do not use `rg` or ripgrep. Read UTF-8 files with `Get-Content -Encoding UTF8`.
- Treat .agents/skills/ and skills-lock.json as tooling. Load relevant skills as needed, read their instructions, and check version-sensitive guidance against local types, configuration, or official documentation.

## Authorization and delegation

Complete authorized, reversible work and its verification. Honor read-only or planning requests. Clarify missing information when it changes product behavior, safety, permissions, or compatibility. Obtain explicit authorization before discarding user changes, deploying to production, deleting real data, publishing externally, or changing permissions. Development authorization does not confer permission to register files through the product.

Keep local tasks with the primary agent. Delegate independent work with a specific question, file ownership, and expected evidence. Use `feishu-events` for Feishu intake and D1 writes, `download-streaming` for the public read path and internal cache, and `relay-reviewer` for independent read-only review of high-risk changes. The primary agent owns cross-module contracts, conflict resolution, integration, verification, and the final report.

## Verification and delivery

Use commands present in the repository. For documentation, check references and run `git diff --check` and `git status --short`. When adding a runner, use `*.test.ts` and document the actual pnpm scripts. Test webhook validation, duplicate events, recall before registration, GET/HEAD, invalid ranges, upstream failures, and recall with warm chunks. Verify SHA-256 for full and resumed downloads at 100 MB, 500 MB, and 1 GB. Use isolated resources for destructive tests and report passed, skipped, and blocked checks separately.

Use Conventional Commits with a Chinese subject, for example `docs: 添加仓库协作规则`. In pull requests, cite the relevant PRD requirement, summarize validation, and identify configuration or migration changes.
