import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startBrowser } from './browser-process'

test('browser startup reports early exit and bounded stderr instead of hiding it behind a timeout', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'relay-browser-exit-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const child = startBrowser(process.execPath, ['-e', "process.stderr.write('x'.repeat(12000) + '\\nNo usable sandbox!\\n'); process.exitCode = 23"])
  t.after(() => child.stop())
  await assert.rejects(child.endpoint(profile), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /exited before exposing/)
    assert.match(error.message, /Exit code: 23/)
    assert.match(error.message, /No usable sandbox!/)
    assert.ok(error.message.length < 9000)
    return true
  })
})

test('missing browser executable exposes spawn error and can be cleaned up', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'relay-browser-missing-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const child = startBrowser(join(profile, 'missing-browser'), [])
  t.after(() => child.stop())
  await assert.rejects(child.endpoint(profile), /Spawn error:.*ENOENT/)
})

test('browser endpoint deadline preserves stderr and stops a still-running process', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'relay-browser-timeout-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const child = startBrowser(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  t.after(() => child.stop())
  await assert.rejects(child.endpoint(profile, 100), /Timed out waiting for Chromium debugging endpoint/)
  await child.stop()
  await child.closed
})

test('browser startup accepts an isolated endpoint file while the process remains alive', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'relay-browser-endpoint-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const child = startBrowser(process.execPath, ['-e', "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'DevToolsActivePort'), '12345\\r\\n/devtools/browser/test-id\\r\\n'); setInterval(() => {}, 1000)", profile])
  t.after(() => child.stop())
  assert.equal(await child.endpoint(profile), 'ws://127.0.0.1:12345/devtools/browser/test-id')
})
