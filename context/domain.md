# Domain rules

The VPS implementation uses Prisma for typed independent queries and a repository-internal D1 REST batch for atomic state changes. Prisma transactions are explicitly rejected. Public read authorization requires primary proof and is never cached. Job completion and retries are fenced by the claimed attempt and lease. Existing metadata, identifiers, TEXT timestamps and CHECK constraints are preserved; no business-table migration is required for this runtime change.

## Identities

| Entity | Identity and purpose |
|---|---|
| Feishu event | `event_id` identifies a delivery for idempotent processing in `processed_events`. A retry must not produce a second registration or link. |
| Source attachment | The original `message_id` and matching `file_key` identify the attachment in its conversation. Recall refers to the original message ID. |
| File record | D1 associates a message with its opaque, randomly generated public ID, filename, verified byte length, version, and status. It holds neither source bytes nor access tokens. |
| Recall tombstone | `recalled_messages` records the original message ID even when the file record does not yet exist. |
| Cached chunk | Public file ID, version, and a canonical chunk index or exact range identify reusable bytes. Cache presence conveys no download permission. |

## State transitions

Only `active` is downloadable. A file stays `pending` until the resource is readable and its exact length is trustworthy. Verification allows activation and a bot reply with a link. An active file whose source becomes unreadable can become `unavailable`.

Recall records a tombstone and marks an existing file `deleted`, retaining its history and deletion time. Deletion is terminal for that original message. Make event processing, tombstone checks, and the corresponding D1 state changes atomic or equivalently consistent. Concurrent registration and recall, a retried event, or a late verification result must never reactivate a recalled message. Resending identical bytes creates a new message with a new public ID.

Requirements: [PRD §§3, 4 (F01–F03, F06), 6](../PRD.md).
