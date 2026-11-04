# VPS runtime contract

The Node entry is `main.ts`; application creation has no startup side effects. Production uses one process, `@hono/node-server`, in-process jobs and a remote Prisma/D1 repository. No Workers runtime API is reachable from the Node bundle. The legacy Worker tree is retained only for regression and rollback preparation.

Every public file read is authorized through `getDownloadFile`; control jobs use `getFile`, preserving reserved API capacity. Webhooks persist before acknowledgement. Tasks and notifications stay in D1; process memory is never the durable queue. Job completion is fenced by attempt and lease. Startup scans and non-overlapping polling recover work after crashes.

Sockets are observed independently of request-body completion. `safeNodeResponse` destroys a failing binary response before the Node adapter can append an error body. Length and EOF checks retain the final byte buffer until the upstream stream is verified. Client abort, source deadlines and shutdown cancel upstream work. Backpressure is bounded; source files are never persisted.

The optional cache is bounded at 64 MiB, five minutes, one completed chunk per file, and excludes complete small files. D1 is checked before every cache hit. Cache state grants no permission. The production proxy must disable cache, response buffering, temporary files and compression.

Readiness is loopback-only with shared 15-second results and blocked at Nginx. Download rate-limit keys come from sockets or a trusted loopback proxy's overwritten X-Real-IP. No generic forwarding header is trusted. Global concurrency defaults to ten. Shutdown stops claims immediately, drains for up to 60 seconds, then aborts remaining work; expired leases permit recovery.
