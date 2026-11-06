import { createBlobSink, downloadChunks, DownloadError, MAX_BLOB_BYTES, type DownloadMetadata, type DownloadSink, type TransferEvent } from './download-controller.ts'
import { isLocale, messages, rememberLanguage, resolveLanguages, savedPreference, type Locale } from './i18n.ts'
import { createDownloadConfirmation, startDownloadSession } from './download-confirmation.ts'

type Copy = ReturnType<typeof messages>
type TextKey = { [K in keyof Copy]: Copy[K] extends string ? K : never }[keyof Copy]
type Phase = 'ready' | 'picking' | 'checking' | 'downloading' | Extract<TransferEvent, { type: 'retry' }> | 'committing' | 'saved' | 'blobReady' | 'cancelled' | 'failed'
interface FileWritable {
  write(data: { type: 'write'; position: number; data: Uint8Array }): Promise<void>
  truncate(size: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
type PickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileWritable> }> }

function setText(element: Element, text: string): void {
  // 不重复写入 live region，避免每段数据都触发相同的读屏播报。
  if (element.textContent !== text) element.textContent = text
}

function bindTransfer(panel: HTMLElement, initial: Copy): (copy: Copy) => void {
  let t = initial
  let total = Number(panel.dataset.size)
  let bytes = 0
  let phase: Phase = 'ready'
  let failure: DownloadError | undefined
  let feedback: 'copied' | 'copyUnsupported' | 'copyFailed' | undefined
  let active: AbortController | undefined
  let blobUrl: string | undefined
  let blobConfirmation: ReturnType<typeof createDownloadConfirmation> | undefined
  let pageLifetime = new AbortController()
  let frame = 0
  const picker = window.isSecureContext ? (window as PickerWindow).showSaveFilePicker : undefined
  const canStream = typeof picker === 'function'
  const button = panel.querySelector<HTMLButtonElement>('#download')!
  const cancel = panel.querySelector<HTMLButtonElement>('#cancel')!
  const copy = panel.querySelector<HTMLButtonElement>('#copy')!
  const save = panel.querySelector<HTMLAnchorElement>('#save')!
  const progress = panel.querySelector<HTMLProgressElement>('#progress')!
  const percent = panel.querySelector<HTMLElement>('#percent')!
  const amount = panel.querySelector<HTMLElement>('#amount')!
  const meter = panel.querySelector<HTMLElement>('#meter')!
  const status = panel.querySelector<HTMLElement>('#status')!
  const mode = panel.querySelector<HTMLElement>('#mode')!
  const error = panel.querySelector<HTMLElement>('#error')!
  const notice = panel.querySelector<HTMLElement>('#feedback')!
  const fileName = panel.querySelector<HTMLElement>('#filename')!.textContent!
  panel.querySelector<HTMLElement>('.actions')!.hidden = false

  function renderProgress(): void {
    const fraction = total ? bytes / total : Number(phase === 'saved' || phase === 'blobReady')
    progress.value = fraction
    setText(percent, t.percent(fraction))
    setText(amount, t.amount(bytes, total))
  }

  function render(): void {
    const tooLarge = !canStream && (total > MAX_BLOB_BYTES || failure?.code === 'tooLarge')
    const busy = !!active
    const committed = phase === 'saved' || phase === 'blobReady'
    setText(panel.querySelector('#filesize')!, t.size(total))
    setText(status, tooLarge ? '' : typeof phase === 'object' ? t.retry(phase.seconds, phase.attempt) : t[phase])
    setText(mode, tooLarge ? t.tooLarge : busy ? t.keepOpen : phase === 'ready' ? (canStream ? t.pickerMode : t.blobMode) : '')
    setText(error, !failure || tooLarge ? '' : failure.code === 'http' ? t.http(failure.httpStatus) : t[failure.code])
    setText(notice, feedback ? t[feedback] : '')
    setText(button, phase === 'ready' || busy ? t.download : t.restart)
    progress.setAttribute('aria-label', t.progress)
    meter.hidden = tooLarge || !(busy && phase !== 'picking' || committed)
    if (!meter.hidden) renderProgress()
    button.hidden = tooLarge || busy
    button.disabled = busy || tooLarge
    button.classList.toggle('primary', phase !== 'blobReady')
    cancel.hidden = !busy
    cancel.disabled = !busy || phase === 'committing'
    save.hidden = !blobUrl
    copy.classList.toggle('primary', tooLarge)
  }

  function changePhase(next: Phase): void {
    phase = next
    render()
  }

  function releaseBlob(): void {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    blobUrl = undefined
    blobConfirmation = undefined
    save.removeAttribute('href')
    save.hidden = true
  }

  cancel.addEventListener('click', () => active?.abort())
  save.addEventListener('click', (event) => { if (blobUrl && !save.hidden) void blobConfirmation?.save(event) })
  window.addEventListener('pagehide', () => {
    active?.abort()
    pageLifetime.abort()
    if (frame) { cancelAnimationFrame(frame); frame = 0 }
    if (blobUrl) {
      releaseBlob()
      changePhase('ready')
    }
  })
  window.addEventListener('pageshow', () => { if (pageLifetime.signal.aborted) pageLifetime = new AbortController() })
  const warnBeforeLeaving = (event: BeforeUnloadEvent) => event.preventDefault()
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) feedback = 'copyUnsupported'
      else { await navigator.clipboard.writeText(location.href); feedback = 'copied' }
    } catch { feedback = 'copyFailed' }
    setText(notice, t[feedback])
  })
  button.addEventListener('click', async () => {
    if (active || button.disabled) return
    const abort = new AbortController()
    active = abort
    window.addEventListener('beforeunload', warnBeforeLeaving)
    failure = undefined
    feedback = undefined
    bytes = 0
    releaseBlob()
    let sink: DownloadSink | undefined
    try {
      // 原生选择器必须在用户点击时调用，先等待元数据会丢失用户激活。
      const pending = canStream ? picker.call(window, { suggestedName: fileName }) : undefined
      changePhase(canStream ? 'picking' : 'checking')
      cancel.focus()
      const handle = await pending
      abort.signal.throwIfAborted()
      changePhase('checking')
      const id = location.pathname.split('/')[2]
      const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { cache: 'no-store', signal: abort.signal }).catch(() => { throw new DownloadError('metadataFailed') })
      if (!response.ok) {
        const codes: Partial<Record<number, DownloadError['code']>> = { 404: 'missing', 410: 'gone', 429: 'rateLimited' }
        throw new DownloadError(codes[response.status] ?? 'metadataFailed')
      }
      const metadata: DownloadMetadata = await response.json().catch(() => { throw new DownloadError('badMetadata') })
      abort.signal.throwIfAborted()
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw new DownloadError('badMetadata')
      total = metadata.size
      let blobSink: ReturnType<typeof createBlobSink> | undefined
      if (handle) {
        const writable = await handle.createWritable()
        sink = { write: (position, data) => writable.write({ type: 'write', position, data }), truncate: size => writable.truncate(size), close: () => writable.close(), abort: () => writable.abort() }
      } else {
        blobSink = createBlobSink(total, metadata.blobLimit)
        sink = blobSink
      }
      const method = blobSink ? 'blob' : 'native'
      const sessionToken = await startDownloadSession(metadata, method, { signal: abort.signal })
      abort.signal.throwIfAborted()
      const confirmation = sessionToken ? createDownloadConfirmation(metadata.id, sessionToken, method, { signal: pageLifetime.signal }) : undefined
      changePhase('downloading')
      await downloadChunks(metadata, sink, {
        signal: abort.signal,
        sessionToken,
        progress(value) {
          bytes = value
          if (phase !== 'downloading') changePhase('downloading')
          else if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderProgress() })
        },
        status(event) {
          changePhase(event.type === 'retry' ? event : event.type)
        },
      })
      if (blobSink) {
        blobUrl = URL.createObjectURL(blobSink.blob())
        save.href = blobUrl
        save.download = metadata.name
        blobConfirmation = confirmation
        phase = 'blobReady'
      } else phase = 'saved'
      // 保存结果已经确定；通知独立重试，不进入上面的文件写入/回滚异常链。
      void confirmation?.downloaded()
    } catch (cause) {
      await sink?.abort().catch(() => {})
      const cancelled = abort.signal.aborted || cause instanceof DOMException && cause.name === 'AbortError'
      phase = cancelled ? 'cancelled' : 'failed'
      if (!cancelled) failure = cause instanceof DownloadError ? cause : new DownloadError('saveFailed')
    } finally {
      const restoreFocus = document.activeElement === cancel || document.activeElement === document.body
      active = undefined
      window.removeEventListener('beforeunload', warnBeforeLeaving)
      render()
      if (restoreFocus) (blobUrl ? save : button.hidden ? copy : button).focus()
    }
  })

  return (next: Copy) => { t = next; render() }
}

function boot(): void {
  const selector = document.querySelector<HTMLSelectElement>('#language')!
  const labels = document.querySelectorAll<HTMLElement>('[data-text]')
  const panel = document.querySelector<HTMLElement>('[data-size]')
  const renderTransfer = panel && bindTransfer(panel, messages(resolveLanguages([document.documentElement.lang])))
  // 历史导航可能恢复旧的 select.value；初始化以实际 cookie 和服务器的默认选项为准。
  const serverChoice = Array.from(selector.options).find(option => option.defaultSelected)?.value
  let previousPreference = readPreference()
  let choice = previousPreference ?? (isLocale(serverChoice) ? serverChoice : 'auto')
  function render(): void {
    selector.value = choice
    const locale: Locale = isLocale(choice) ? choice : resolveLanguages(navigator.languages?.length ? navigator.languages : [navigator.language])
    const t = messages(locale)
    document.documentElement.lang = locale
    document.title = t.title
    for (const element of labels) setText(element, t[element.dataset.text as TextKey])
    renderTransfer?.(t)
  }
  selector.addEventListener('change', () => {
    choice = isLocale(selector.value) ? selector.value : 'auto'
    rememberLanguage(choice)
    render()
  })
  window.addEventListener('languagechange', () => { if (choice === 'auto') render() })
  function readPreference() {
    try { return savedPreference(document.cookie) } catch { return undefined }
  }
  // 从浏览器历史缓存返回时，仅在另一页更改了实际 cookie 时覆盖内存选择。
  window.addEventListener('pagehide', () => { previousPreference = readPreference() })
  window.addEventListener('pageshow', () => {
    const saved = readPreference()
    if (saved && saved !== previousPreference) choice = saved
    render()
  })
  selector.closest('label')!.hidden = false
  render()
}

boot()
