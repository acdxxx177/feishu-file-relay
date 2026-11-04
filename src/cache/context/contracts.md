# Internal chunk contract

`ChunkEntry` is a named Worker entrypoint reached through `ctx.exports.ChunkEntry.openChunk(source, index)`. This returns a `ChunkRequest` RPC capability before upstream work starts; the Gateway installs abort handling, then calls `response()`. Its `cancel()` method interrupts upstream header waits as well as active body transfers. The Gateway disposes each capability when that chunk is drained or canceled. The Gateway is the only public HTTP handler. The private entrypoint has no public route or source-identifier URL; the public browser chunk API only accepts opaque IDs behind the Gateway D1 gate. RPC arguments contain the paired Feishu identifiers and trusted D1 length; responses never contain credentials or upstream headers.

The Gateway checks D1 before every valid public GET/HEAD and rechecks after each eight chunks. Deleted/unavailable files return 410 before cache access. Chunk cache availability never authorizes a download. Chunk keys use the configured public origin with `/chunks/{id}/v{version}/{index}`; these paths return 404 at the Gateway.

Canonical legacy chunks are exactly 16 MiB except the last; browser ranges may be smaller or non-aligned. An upstream chunk must be 206 with exact Content-Range, optional exact Content-Length, identity encoding, and an actual body of precisely the expected length. The final read is held until EOF. A bounded two-branch pump applies backpressure to both the client and cache, so slow clients do not accumulate a whole chunk through `tee()`.

Both internal branches and the public response use native `FixedLengthStream`. Workers removes manually supplied Content-Length on unknown-length JavaScript streams; the native stream retains the trusted length and rejects length mismatches. A local workerd cache test observed MISS then HIT and unchanged origin request count on the second download.

An interrupted native fixed-length cache write was observed locally to leave a partial cache object with the original declared Content-Length. Therefore, cache data is not considered committed without a separate zero-body `${key}/complete` marker. Data and marker carry the same random generation; a marker is published only after exact-length validation, successful forwarding, and completed cache storage. This also prevents a stale marker from authorizing a partial overwrite. Aborted writes are removed best effort; markerless or generation-mismatched objects are never returned as cache hits. Markers use the same seven-day TTL. No D1 content or additional storage product is involved.

Upstream reads have an idle deadline (`UPSTREAM_READ_TIMEOUT_MS`, default 30 seconds) measured only while a read is pending, so client backpressure is not mistaken for source inactivity. On source errors or deadlines, the response stream is errored immediately; upstream cancellation is background cleanup and cannot delay the client's failure. RPC handles are disposed before awaiting any network cancellation confirmation.

Concurrent misses within an isolate share only a completion Promise, never request-owned I/O. Followers open their own cache response after completion. If the leader disconnects or the cache write fails, followers may make a new source request. No global cache or global coalescing is claimed.

Chunk logs count `origin_calls` to the Feishu service. Transport retry attempts are a separate service-level measurement.

PRD §§5.4–5.5 contain incompatible requirements for a real `bytes=0-0` response, D1-only reads, and storing no source bytes in D1. The implementation uses one exact upstream byte for this special request and never populates a full chunk. HEAD is D1-only. Public success responses use PRD §5.4 `private, no-cache`; errors use `no-store`.

## Browser range extension (2026-11-03)

The private openRange(source,start,end,cache) capability uses the same validation and cancellation path. Each public browser chunk has a separate D1 first-primary gate and strong relay If-Match. Exact ranges may be at most 16 MiB. Canonical ranges retain existing keys; all others append /range/start-end. There is no rounded-up origin read. BROWSER_CHUNK_CACHE_ENABLED=false bypasses cache only for browser ranges and retains checkedBody plus native FixedLengthStream. The Gateway uses native pipeTo rather than its legacy JavaScript slices loop.

GET /f/:id is now a no-store page; the legacy binary contract moves to /f/:id/download. Browser chunks are no-store. The relay ETag pins D1 id/version; it is not an origin cryptographic digest. No same-size silent source replacement detection is claimed without an authoritative source validator.

Browser cold reads use native BYOB readAtLeast with a fresh buffer capped at 256 KiB, reducing JavaScript pump callbacks. Unsupported byte readers fall back to default reads. The existing deadline bounds the entire aggregation read (30s by default), not per-network-frame inactivity; a continuously slow origin can time out below roughly 8.5 KiB/s. Raw reads retain their original inactivity behavior. Partial EOF, one-byte overrun probing, cancellation, backpressure and marker publication remain unchanged. Tests cover aggregation timeout, recovery and rejection of incomplete cache data.

Cache-bypass calls do not construct cache URLs or allocate miss-coalescing completion state. They retain exactly the same checkedBody and FixedLengthStream path. Cache-enabled calls keep generation markers and inFlight lifecycle unchanged. Local CPU experiments did not justify buffer-size changes or a replacement manual writer; 256 KiB and native pipeTo remain the baseline. See docs/chunk-cpu-investigation.md for evidence and limits.
