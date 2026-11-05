import { localeNames, locales, messages, requestLanguage } from './i18n.ts'

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function pageErrorKey(status: number) {
  switch (status) {
    case 404: return 'missing'
    case 410: return 'gone'
    case 429: return 'rateLimited'
    default: return 'temporary'
  }
}

export function renderDownloadPage(file: { name: string; size: number } | null, status: number, request: Request): string {
  const { locale, preference } = requestLanguage(request)
  const t = messages(locale)
  const options = locales.map((code) =>
    `<option value="${code}" lang="${code}"${code === preference ? ' selected' : ''}>${localeNames[code]}</option>`).join('')
  const reason = pageErrorKey(status)
  const panel = file ? `
    <section class="sheet" aria-labelledby="filename" data-size="${file.size}">
      <header class="file-heading">
        <svg class="document" viewBox="0 0 36 44" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" focusable="false"><path d="M5 2h16l10 10v29H5z M21 2v11h10 M11 23h14 M11 29h10"/></svg>
        <div><h2 id="filename" dir="auto">${escape(file.name)}</h2><p id="filesize">${t.size(file.size)}</p></div>
      </header>
      <div class="transfer">
        <p id="status" role="status">${t.ready}</p>
        <div id="meter" hidden>
          <div class="figures"><span id="percent"></span><span id="amount"></span></div>
          <progress id="progress" max="1" value="0" aria-label="${t.progress}"></progress>
        </div>
        <p id="mode">${t.initialMode}</p>
        <p id="error" role="alert"></p>
        <div class="actions" hidden>
          <a id="save" class="primary" data-text="save" tabindex="0" hidden>${t.save}</a>
          <button id="download" class="primary">${t.download}</button>
          <button id="cancel" data-text="cancel" hidden disabled>${t.cancel}</button>
          <button id="copy" data-text="copy">${t.copy}</button>
        </div>
        <p id="feedback" role="status"></p>
        <noscript><p>${t.noScript}</p></noscript>
      </div>
    </section>` : `
    <section class="sheet unavailable" aria-labelledby="unavailable">
      <h2 id="unavailable" data-text="unavailable">${t.unavailable}</h2>
      <p data-text="${reason}">${t[reason]}</p>
    </section>`
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title><link rel="stylesheet" href="/assets/download.css"><script type="module" src="/assets/download.js"></script></head>
<body><main>
  <header class="page-heading"><h1 data-text="title">${t.title}</h1>
    <label class="language" hidden><span data-text="language">${t.language}</span>
      <select id="language" autocomplete="off"><option value="auto" data-text="automatic"${preference === 'auto' ? ' selected' : ''}>${t.automatic}</option>${options}</select>
    </label>
  </header>${panel}
</main></body></html>`
}
