# VPS metadata repository

The Node application uses `RelayRepository`; Prisma and D1 response types do not cross this interface. The existing Worker implementation in `files.ts` is retained only for the rollback build and baseline tests.

Prisma 7.10.1's official `PrismaD1` Node entry accepts `CLOUDFLARE_D1_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_DATABASE_ID`. Inspection of the installed `index-node.mjs` confirmed that its HTTP client has no injected fetch hook, does not expose `served_by_primary`, and implements transaction commit/rollback as no-ops. The relay therefore uses a narrow `SqlDriverAdapterFactory` with the same official Prisma adapter contract, not a simulated Workers binding. It rejects transactions and schema scripts before I/O. The supported scalar surface is deliberately restricted to the existing metadata schema.

All HTTP queries and batches share one sliding five-minute budget. Default 900 calls include a 100-call control reserve unavailable to download authorization/statistics. All results require `success`, the expected statement count, and `served_by_primary: true`. There is no authorization cache or fallback to replicas. Failure, missing proof, or exhaustion fails closed. This is a safety check, not evidence that a real remote D1 endpoint has been validated.

Registration/event deduplication, recall tombstones/deletion, activation/outbox, and unavailable/outbox execute as one REST batch. Batch support, rollback, connection-local `changes()`, and primary responses must still be verified in an explicitly selected isolated remote database before production use. Local SQLite tests only prove the SQL and adapter protocol contract. No transport-level write retry is permitted: a lost response may represent a committed transaction. Event replay is reconciled by durable identifiers; claims recover through lease expiry. Count increments are best effort and are not replayed after an ambiguous outcome.

Jobs and file validation use `(id, attempts, lease_until)` fencing when finishing/retrying. The runtime migration preserved the original schema; the first-download feature below adds one eligibility column. TEXT timestamps retain SQLite's `YYYY-MM-DD HH:mm:ss`; millisecond lease/retry values and counts use Prisma BigInt and explicit safe-integer conversion at the repository boundary. SQL CHECK constraints remain authoritative even though Prisma cannot represent them completely.

## Migration boundary

`prisma/schema.prisma` is the type model, not permission to rewrite existing tables. Generate the client with `pnpm exec prisma generate`; validate with `pnpm exec prisma validate`. Generate a candidate diff from an isolated copy of the existing schema, inspect all CHECK constraints/defaults/indexes, and put reviewed SQL in the existing `migrations/` sequence. Use explicit Wrangler D1 migration commands. Never use `db push`, `migrate reset`, automatic startup migrations, or a generated schema replacement on production. Existing `0001_init.sql` and D1 migration history must be adopted without replay. There is no schema change required for this runtime migration.

The fake D1 transport tests use SQLite transactions to emulate REST batch. Real REST atomicity, parameter representation, primary metadata, quota behavior and remote failure outcomes remain separate deployment gates; no production network calls are made by the default tests.

## First-download migration and outbox

Migration `0002_first_download_notification.sql` adds a checked `0/1` eligibility column with default `0`. It must precede the new binary even when the feature is disabled, because Prisma selects the new column. Only new registrations while enabled explicitly write `1`; event replay and historical files never gain eligibility. Fixtures and schema checks load the ordered migration sequence. No startup migration or table rebuild is introduced.

`recordFirstDownload` uses one primary REST batch on the download budget: conditionally insert `first-download:card:<id>` from an eligible active file with the matching version, then check the permanent task key. The file name and recipient come from D1. The unique task row is both event and outbox; there is no second event table or first-time column. Unknown commits retry this idempotent operation with the same frozen snapshot, and a committed row remains discoverable after recall. All pending/sent/failed rows are permanent deduplication evidence.

The argument envelope carries an immutable versioned snapshot and mutable `unsent`/`uncertain` delivery metadata plus a sanitized failure reason. Each network create first persists `uncertain` under the attempt/lease fence with sufficient lease remaining. Known non-delivery cannot erase an earlier uncertain attempt. Acknowledgements persist the bot message ID with fencing. Use the same UUID and card across retries, stop uncertain sends outside the conservative one-hour window, and retain permanent/eight-attempt failure without fallback. The original publication card and terminal PATCH jobs remain independent. Drain new pending jobs with the new consumer before reverting to an older VPS or Worker consumer.

## VPS card message persistence

For PRD F03/F06/F08/F09, the source attachment stays keyed by `files.message_id`. A VPS `active:card:<id>` publication stores the original public URL in its argument and the acknowledged outgoing message ID in `bot_jobs.message_id`. An `unsent:` prefix means the service can prove that no create request was accepted. The service removes it under the file and lease guards before the POST. A missing acknowledgement then requires recovery with the same content and UUID within the provider's deduplication window. Retain the publication row as long as the file exists. Historical `active:<id>` text notifications have no card association. No schema migration is required.

An owner-only card revocation binds file, uploader, chat and publication receipt inside one primary D1 batch. Terminal file transitions and receipt completion enqueue fenced card updates transactionally. The scheduler renders from authoritative file metadata. Card delivery state never authorizes a public read.
