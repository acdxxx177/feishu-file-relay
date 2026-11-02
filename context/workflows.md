# Relay workflows

## Register and reply

Handle the Feishu URL challenge promptly. Verify callback authenticity and replay protections, decrypt when configured, and restrict file registration to allowed employees or controlled bot conversations. For a file receive event, deduplicate by event ID and associate the matching message ID and file key. Confirm readability and the exact source length before activation. Publish one random public URL in the original conversation. Report a registration failure without presenting a usable link. Keep server-side tokens out of replies, URLs, logs, and cached responses.

## Download and resume

1. For every public GET or HEAD on `/f/:id`, check D1 before any cache or origin read. An unknown ID returns 404. A recalled ID returns 410 even on HEAD or a warm cache hit. Only active files serve bytes. Use `Cache-Control: no-store` on the public endpoint.
2. HEAD returns appropriate metadata without a body. Full GET returns 200. A single satisfiable byte range returns 206 with the exact `Content-Range` and response length. An invalid or unsatisfiable range returns 416. The MVP does not serve multipart ranges. Supply the correct content type, attachment filename (including non-ASCII names), length, and `Accept-Ranges: bytes`.
3. Map the browser's requested bytes onto internal 16 MiB chunks. A resume may start midway through a chunk. Slice boundary chunks to the requested interval, stream in order, and truncate the final chunk at EOF. The client receives one file or byte range, independently of chunk alignment.
4. Only the Gateway may call the chunk entry. On a miss, request the precise source range, verify status, bounds, and length, and cache a valid chunk as an independent 200 object under its versioned key. Start with the PRD's seven-day cache TTL. Avoid buffering a whole file. Never cache an error or a partial, corrupt chunk.

## Recall and failures

Record recall by original message ID using the [domain rules](domain.md). Once committed, all subsequent GET and HEAD requests for the recalled file return 410 without reading the origin. Cache cleanup can run asynchronously and may fail without weakening revocation. An in-flight transfer may already have sent bytes.

Handle Feishu throttling and temporary upstream failures with bounded retries. Return an appropriate failure before sending headers when possible. If a stream fails after headers are sent, terminate the incomplete transfer so it cannot appear successful.

## Evidence required

Compare the original SHA-256 with both full and interrupted-then-resumed downloads for each of 100 MB, 500 MB, and 1 GB. Exercise duplicate events, recall before registration, GET/HEAD after recall with cached chunks, invalid ranges, and upstream failures. Record actual Feishu range headers and reliable size discovery in M1. Measure repeat-download cache hits and origin request counts across regions, and observe attachment readability over time before making availability claims.

Requirements: [PRD §§3–5, 7–9, 11–12](../PRD.md).
