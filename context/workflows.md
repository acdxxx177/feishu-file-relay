# Relay workflows

## VPS revision (2026-11-04)

The approved VPS revision supersedes Worker-specific mechanics below: Node uses a private in-process range service, explicit length/EOF verification, a socket-destroying response boundary, memory-only tokens, and a non-overlapping persistent-lease scheduler instead of RPC, FixedLengthStream, Cache API, waitUntil and Cron. Prisma queries and direct atomic REST batches share a quota budget; primary metadata is mandatory. Browser ranges default to 16 MiB. See [runtime contract](../src/vps/context/runtime.md) and [database contract](../src/db/context/vps-contract.md). The remaining workflow semantics and historical evidence requirements still apply; production cutover has not occurred.

## Register and reply

The VPS sends a dynamically built Simplified Chinese Card 2.0 after activation. A submit button requests native confirmation. The callback authenticates the operator and binds the original chat and bot message before revoking. Source loss, recall and revocation schedule an update to the same card. The separate text command remains available for older clients and expired interactions. The retained Worker publishes text. See the [VPS operating guide](../docs/vps-deployment.md) and [card acceptance steps](../docs/acceptance.md).

Handle the Feishu URL challenge promptly. Verify callback authenticity and replay protections, decrypt when configured, and accept user p2p messages according to the selected intake policy. Production platform policy delegates user availability to Feishu; legacy allowlist policy requires listed employees. For a file receive event, deduplicate by event ID and associate the matching message ID and file key. Confirm readability and the exact source length before activation. Publish one random public URL in the original conversation. Report a registration failure without presenting a usable link. Keep server-side tokens out of replies, URLs, logs, and cached responses.

## Download and resume

1. Every valid-ID public file GET/HEAD performs a D1 first-primary read before cache/source access. Unknown files return 404, deleted/unavailable files return 410, and D1 failures return 503 without reading bytes.
2. GET /f/:id renders a no-store page without fetching bytes or incrementing statistics. HEAD /f/:id retains the original D1-only binary metadata contract. GET /api/files/:id exposes only public metadata and a relay ETag.
3. The browser requests /api/files/:id/chunk sequentially with a single Range and exact If-Match. Missing preconditions return 428; mismatches return 412; missing, multipart, invalid or over-16-MiB ranges return 416. No If-Range fallback to a full file occurs here. Every chunk is a new authoritative availability check.
4. Private ChunkEntry reads the exact range, checks upstream status, Content-Range, optional Content-Length, encoding, byte count and EOF, and applies idle deadlines/cancellation. Canonical 16 MiB keys remain compatible; other ranges have distinct versioned keys. Cache reads require matching generation/length completion markers. The Gateway uses native pipeTo/FixedLengthStream without a JavaScript byte assembly loop.
5. File System Access writes await backpressure at absolute offsets, rolls failed chunks back, and commits only after verification and close. Blob mode has a hard 20 MiB limit. Cancellation or exhausted retries aborts tentative output. In-session automatic recovery is distinct from restarting after a terminal failure, refresh or browser restart.
6. GET/HEAD /f/:id/download preserves the old binary Range/If-Range path and its known Free CPU limitation. Page/metadata/chunk responses use no-store. Raw successes retain private,no-cache. Page opens never count; browser offset-zero chunks count after successful forwarding, and repeated zero-offset requests can overcount.

## First confirmed download (VPS)

The opt-in notification applies only to files registered while the feature is enabled. Browser sessions track complete canonical ranges in bounded process memory, separately from approximate download counters. Native saves report after successful close; Blob saves report only after full assembly and a trusted Save activation. Raw downloads, partial ranges, HEAD, metadata and prefetch never trigger the notification. Successful in-session recovery may qualify after whole-file completion.

An atomic primary D1 insert under `first-download:card:<fileId>` freezes the first accepted confirmation and queues one historical card to the uploader's original chat. Retain the row in every delivery state. Same-UUID retries stop when an ambiguous send exceeds the provider window. Session loss before persistence may omit a notification; persisted jobs recover through the existing scheduler. Only proxy-verified country/region/city are stored, never IPs. See the [operating guide](../docs/first-download-notifications.md) for the approved completion limits and rollout sequence.

## Recall and failures

Record recall by original message ID using the [domain rules](domain.md). Once committed, all subsequent GET and HEAD requests for the recalled file return 410 without reading the origin. Cache cleanup can run asynchronously and may fail without weakening revocation. An in-flight transfer may already have sent bytes.

Handle Feishu throttling and temporary upstream failures with bounded retries. Return an appropriate failure before sending headers when possible. If a stream fails after headers are sent, terminate the incomplete transfer so it cannot appear successful.

## Evidence required

Compare the original SHA-256 with both full and interrupted-then-resumed downloads for each of 100 MB, 500 MB, and 1 GB. Exercise duplicate events, recall before registration, GET/HEAD after recall with cached chunks, invalid ranges, and upstream failures. Record actual Feishu range headers and reliable size discovery in M1. Measure repeat-download cache hits and origin request counts across regions, and observe attachment readability over time before making availability claims.

Requirements: [PRD §§3–5, 7–9, 11–12](../PRD.md).
