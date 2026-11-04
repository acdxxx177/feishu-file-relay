import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containerTags } from '../../scripts/container-tags.ts'

test('only stable version releases update latest; manual runs publish commit tags', () => {
  const sha = 'a'.repeat(40)
  const commit = `ghcr.io/owner/relay:sha-${sha}`
  assert.deepEqual(containerTags('Owner/Relay', sha, 'push', 'refs/tags/v1.2.3'), [commit, 'ghcr.io/owner/relay:1.2.3', 'ghcr.io/owner/relay:latest'])
  assert.deepEqual(containerTags('Owner/Relay', sha, 'push', 'refs/tags/v1.2.3-rc.1+build.2'), [commit, 'ghcr.io/owner/relay:1.2.3-rc.1_build.2'])
  assert.deepEqual(containerTags('Owner/Relay', sha, 'workflow_dispatch', 'refs/heads/main'), [commit])
  for (const ref of ['refs/heads/main', 'refs/tags/vbad', 'refs/tags/v01.2.3', 'refs/tags/v1.2.3-01', 'refs/tags/v1.2.3\nlatest']) {
    assert.throws(() => containerTags('Owner/Relay', sha, 'push', ref))
  }
  assert.throws(() => containerTags('Owner/Relay', sha, 'pull_request', 'refs/tags/v1.2.3'))
})
