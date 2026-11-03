# Product scope

Employees need to deliver 100 MB–1 GB files that do not fit in customer email. An employee sends an approved file to the Feishu bot, copies its reply URL into an email, and the customer clicks once to download the original file with its filename. Customers in different regions may download the same file repeatedly.

## Access and lifetime

The bot conversation is the controlled intake channel. Anyone with the resulting URL can download or forward the file. The customer needs no account, password, verification code, download page, client script, or chunking tool. Share only material approved for external distribution.

Production uses explicit FEISHU_INTAKE_POLICY=platform and trusts Feishu's configured application availability for user access. It accepts only authenticated user-to-bot p2p callbacks; it requires no local user/chat allowlist or admin IDs. Only the uploader can revoke a link or list their own links. The allowlist policy remains for existing mock/legacy environments, with deny-all on an empty list and optional listed administrators. This user-approved change supersedes the original mandatory allowlist/admin rules in PRD F02/F08 and §8.1.

The service imposes no business expiry or download count limit. Continued availability depends on the original Feishu attachment and permissions. Revoking the original message withdraws access for new requests once the recall has been recorded. Previously delivered bytes and files saved by customers are beyond the service's control.

## MVP boundary

Feishu retains the original bytes, D1 stores the index and state, and Cloudflare caches chunks to reduce repeated origin reads. The MVP excludes R2 persistence, a management UI, online previews, web uploads, multi-range downloads, and proactive global prewarming. Actual attachment retention and cache reuse across regions require measurement.

Requirements: [PRD §§1–4, 9, 12](../PRD.md).
