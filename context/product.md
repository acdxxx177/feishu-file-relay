# Product scope

Employees need to deliver 100 MB–1 GB files that do not fit in customer email. An employee sends an approved file to the Feishu bot, copies its reply URL into an email, and the customer opens a lightweight page and explicitly starts saving the original file with its filename. Customers in different regions may download the same file repeatedly.

## Access and lifetime

The bot conversation is the controlled intake channel. Anyone with the resulting URL can download or forward the file. The customer needs no account, password or verification code. A lightweight same-origin browser controller orchestrates independent chunk requests. File System Access streams to a tentative local file; unsupported browsers use a Blob only through 20 MiB and otherwise show supported-browser guidance. No durable cross-session resume is claimed. Share only material approved for external distribution.

Production uses explicit FEISHU_INTAKE_POLICY=platform and trusts Feishu's configured application availability for user access. It accepts only authenticated user-to-bot p2p callbacks; it requires no local user/chat allowlist or admin IDs. Only the uploader can revoke a link or list their own links. The allowlist policy remains for existing mock/legacy environments, with deny-all on an empty list and optional listed administrators. This user-approved change supersedes the original mandatory allowlist/admin rules in PRD F02/F08 and §8.1.

The service imposes no business expiry or download count limit. Continued availability depends on the original Feishu attachment and permissions. Revoking the original message withdraws access for new requests once the recall has been recorded. Previously delivered bytes and files saved by customers are beyond the service's control.

## MVP boundary

Feishu retains the original bytes; a Linux VPS runs Node/Hono and streams from Feishu; remote D1 stores metadata accessed through Prisma and isolated atomic batches. Caching is disabled by default. Optional bounded in-memory chunks are disposable and never authorize a read. Browser ranges default to 16 MiB. The MVP excludes full-file storage on the VPS, R2 persistence, a management UI, online previews, web uploads, multi-range downloads, and proactive global prewarming. D1 REST limits and real Feishu behavior require separate acceptance. The retained Worker implementation is a regression/rollback baseline, not the default runtime.

Requirements: [PRD §§1–4, 9, 12](../PRD.md).
