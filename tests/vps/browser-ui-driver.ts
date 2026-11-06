import { messages, type Locale } from '../../src/browser/i18n'

// 只作为回环测试页的外部脚本运行，不进入公开资源。
const scenario = new URL(location.href).searchParams.get('scenario')
const nativeFetch = window.fetch.bind(window)
let metadataReads = 0
let sessions = 0
let confirmations = 0
const sessionToken = 't'.repeat(43)
const ranges: string[] = []
const writes: number[] = []
const truncations: number[] = []
function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { release, wait }
}
const secondChunk = gate()
const allowRetry = gate()
const commitStarted = gate()
const allowCommit = gate()
let recalled = false
let aborted = false
const filename = '共享-साझा-instrucciones <final>.zip'
const liveBlobs = new Map<string, Blob>()
if (scenario === 'blob') {
  const createUrl = URL.createObjectURL.bind(URL)
  const revokeUrl = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = object => {
    const url = createUrl(object)
    if (object instanceof Blob) liveBlobs.set(url, object)
    return url
  }
  URL.revokeObjectURL = url => { liveBlobs.delete(url); revokeUrl(url) }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function node<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  assert(element, 'Missing #' + id)
  return element as T
}

function whenVisible(check: () => boolean, description: string) {
  if (check()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (check()) { clearTimeout(timeout); observer.disconnect(); resolve() }
    })
    const timeout = setTimeout(() => {
      observer.disconnect()
      reject(new Error('Timed out waiting for ' + description + ': ' + node('status').textContent + ' ' + node('error').textContent))
    }, 45_000)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  })
}

function select(locale: Locale) {
  const count = metadataReads + ranges.length
  const selector = node<HTMLSelectElement>('language')
  selector.focus()
  selector.value = locale
  selector.dispatchEvent(new Event('change', { bubbles: true }))
  assert(document.documentElement.lang === locale && document.title === messages(locale).title, 'Untranslated document')
  assert(document.activeElement === selector && metadataReads + ranges.length === count, 'Language switch moved focus or fetched file data')
  assert(node('filename').textContent === filename, 'Localized or unescaped filename')
}

// 可控的 429、提交屏障和撤回便于恰在各个阶段切换语言；正常字节仍由同源 HTTP 提供。
window.fetch = async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname
  if (!path.startsWith('/api/files/')) return nativeFetch(input, init)
  if (path.endsWith('/download-session')) {
    sessions++
    return Response.json({ token: sessionToken })
  }
  if (path.endsWith('/download-complete')) {
    confirmations++
    assert(new Headers(init?.headers).get('X-Download-Session') === sessionToken, 'Missing confirmation session')
    return new Response(null, { status: 204 })
  }
  if (!path.endsWith('/chunk')) {
    metadataReads++
    const response = await nativeFetch(input, init)
    return Response.json({ ...await response.json(), firstDownloadNotification: true, ...(scenario === 'transfer' ? { chunkSize: 4 } : {}) })
  }
  assert(new Headers(init?.headers).get('X-Download-Session') === sessionToken, 'Missing tracked chunk session')
  ranges.push(new Headers(init?.headers).get('Range') ?? '')
  if (recalled) return new Response(null, { status: 410 })
  if (scenario === 'transfer' && ranges.length === 2) {
    secondChunk.release()
    await allowRetry.wait
    return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
  }
  return nativeFetch(input, init)
}

Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: scenario !== 'transfer' && scenario !== 'saveFailure' ? undefined :
  async ({ suggestedName }: { suggestedName: string }) => {
    assert(suggestedName === filename, 'Picker lost the original filename')
    return { async createWritable() { return {
      async write({ position }: { position: number }) { writes.push(position) },
      async truncate(size: number) { truncations.push(size) },
      async close() { if (scenario === 'saveFailure') throw new Error('Disk failed'); commitStarted.release(); await allowCommit.wait },
      async abort() { aborted = true },
    } } }
  },
})
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() {} } })

async function transfer() {
  select('en')
  assert(metadataReads + ranges.length === 0, 'Opening the page fetched file data')
  node('download').click()
  await secondChunk.wait
  select('es')
  assert(node('status').textContent === messages('es').downloading, 'Downloading status')
  assert(node('percent').textContent === messages('es').percent(0.5), 'Active progress')
  assert(!node<HTMLButtonElement>('cancel').disabled, 'Cancel disabled during transfer')
  node('copy').click()
  await whenVisible(() => node('feedback').textContent === messages('es').copied, 'clipboard feedback')
  assert(node('status').textContent === messages('es').downloading, 'Copy replaced transfer state')
  const retryVisible = whenVisible(() => node('status').textContent === messages('es').retry(1, 1), 'retry')
  allowRetry.release()
  await retryVisible
  select('hi')
  assert(node('status').textContent === messages('hi').retry(1, 1), 'Retry count or wait lost')
  await commitStarted.wait
  assert(confirmations === 0, 'Notified before native commit')
  select('zh-CN')
  const cancel = node<HTMLButtonElement>('cancel')
  assert(node('status').textContent === messages('zh-CN').committing && (cancel.disabled || cancel.hidden), 'Commit state enabled cancellation')
  allowCommit.release()
  await whenVisible(() => node('status').textContent === messages('zh-CN').saved, 'saved')
  assert(writes.join() === '0,4' && truncations.join() === '4,8', 'Incorrect offsets or rollback')
  assert(ranges.join() === 'bytes=0-3,bytes=4-7,bytes=4-7' && metadataReads === 1, 'Unexpected extra download')
  assert(Number(confirmations) === 1 && sessions === 1, 'Native commit did not report exactly once')
  recalled = true
  node('download').click()
  await whenVisible(() => !!node('error').textContent, 'terminal error')
  select('es')
  assert(aborted && node('error').textContent === messages('es').gone, 'Terminal error or abort lost')
  assert(node('status').textContent === messages('es').failed && node('save').hidden, 'Failure presented as saved')
  assert(Number(confirmations) === 1, 'Failed transfer produced a notification')
}

async function blobBoundary() {
  assert(node<HTMLSelectElement>('language').value === 'es', 'Saved preference lost on next visit')
  assert(metadataReads + ranges.length === 0, 'Opening the next file fetched data')
  node('download').click()
  await whenVisible(() => !node('save').hidden, 'Blob at 20 MiB')
  const link = node<HTMLAnchorElement>('save')
  const url = link.href
  assert(document.querySelector('.actions :is(a[href], button):not([hidden], :disabled)') === link && link.tabIndex === 0,
    'Save is not the first keyboard action after verification')
  const persisted = document.cookie
  const original = Object.getOwnPropertyDescriptor(document, 'cookie')
  Object.defineProperty(document, 'cookie', { configurable: true, set() { throw new DOMException('Blocked', 'SecurityError') } })
  try { select('hi') } finally {
    if (original) Object.defineProperty(document, 'cookie', original)
    else Reflect.deleteProperty(document, 'cookie')
  }
  assert(document.cookie === persisted, 'Blocked preference write changed the persisted language')
  assert(node('status').textContent === messages('hi').blobReady && !link.hidden, 'Blob ready state lost')
  assert(link.href === url && url.startsWith('blob:') && link.download === filename, 'Blob URL or filename changed')
  assert(liveBlobs.get(url)?.size === 20 * 1024 * 1024, 'Verified Blob was replaced or revoked')
  assert(ranges.length === 2 && metadataReads === 1, 'Unexpected Blob fetches')
  assert(confirmations === 0 && sessions === 1, 'Blob readiness notified before a Save click')
  let trustedSaves = 0
  link.addEventListener('click', event => {
    if (event.isTrusted) trustedSaves++
    else event.preventDefault()
  })
  link.click()
  assert(confirmations === 0, 'Synthetic Blob click produced a notification')
  link.focus()
  assert(document.activeElement === link, 'Save did not receive keyboard focus')
  assert(document.documentElement.scrollWidth <= window.innerWidth, 'Narrow download layout overflowed')
  assert(window.matchMedia('(prefers-reduced-motion: reduce)').matches, 'Reduced-motion browser setup missing')
  for (let attempt = 0; attempt < 2; attempt++) {
    // 由浏览器进程外的 CDP 键盘输入生成真实事件，不能把产品的 isTrusted 校验换成测试开关。
    const response = await nativeFetch('/test-keyboard-save', { method: 'POST' })
    assert(response.status === 204, 'External keyboard dispatch failed')
    assert(Number(trustedSaves) === attempt + 1, 'Enter did not activate a trusted Save click')
    assert(Number(confirmations) === 1, 'Trusted repeat Save did not deduplicate confirmation')
    assert(link.href === url && liveBlobs.get(url)?.size === 20 * 1024 * 1024, 'Saving revoked the reusable Blob')
  }
}

async function run() {
  if (scenario === 'transfer') await transfer()
  else if (scenario === 'blob') await blobBoundary()
  else if (scenario === 'saveFailure') {
    node('download').click()
    await whenVisible(() => !!node('error').textContent, 'failed native close')
    assert(aborted && confirmations === 0, 'Failed native close was reported as saved')
  }
  else if (scenario === 'oversized') {
    select('en')
    assert(node('mode').textContent === messages('en').tooLarge, 'Missing compatibility help')
    assert(node('download').hidden || node<HTMLButtonElement>('download').disabled, 'Oversized Blob can start')
    assert(!node('copy').hidden && metadataReads + ranges.length === 0, 'Oversized fallback fetched data or lost Copy')
  } else throw new Error('Unknown test scenario')
}

window.addEventListener('load', async () => {
  let error: string | undefined
  try { await run() } catch (failure) { error = String(failure) }
  const response = await nativeFetch('/test-result', { method: 'POST', body: JSON.stringify({ scenario, error }) })
  const next = await response.text()
  if (!error && next) location.assign(next)
})
