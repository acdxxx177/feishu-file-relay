import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function containerTags(repository: string, sha: string, event: string, ref: string): string[] {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid repository or commit')
  const image = `ghcr.io/${repository.toLowerCase()}`
  const tags = [`${image}:sha-${sha}`]
  if (event === 'workflow_dispatch') return tags
  if (event !== 'push' || !ref.startsWith('refs/tags/v')) throw new Error('Publication requires a version tag or manual dispatch')
  const version = ref.slice('refs/tags/v'.length)
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) throw new Error('Version tag must be v<SemVer>')
  // Docker 标签不接受 SemVer 的 +，采用 _ 保留构建元数据。
  const dockerVersion = version.replace('+', '_')
  if (dockerVersion.length > 128) throw new Error('Version exceeds Docker tag length')
  tags.push(`${image}:${dockerVersion}`)
  if (!match[4]) tags.push(`${image}:latest`)
  return tags
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tags = containerTags(process.env.GITHUB_REPOSITORY ?? '', process.env.GITHUB_SHA ?? '', process.env.GITHUB_EVENT_NAME ?? '', process.env.GITHUB_REF ?? '')
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GITHUB_OUTPUT')
  await appendFile(process.env.GITHUB_OUTPUT, `tags<<CONTAINER_TAGS\n${tags.join('\n')}\nCONTAINER_TAGS\n`)
}
