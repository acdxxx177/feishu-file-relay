export const locales = ['en', 'es', 'hi', 'zh-CN'] as const
export type Locale = typeof locales[number]
export type Preference = Locale | 'auto'

export const localeNames: Record<Locale, string> = {
  en: 'English', es: 'Español', hi: 'हिन्दी', 'zh-CN': '简体中文',
}

const cookieName = 'relay_language'

export function isLocale(value: unknown): value is Locale {
  return locales.some(locale => locale === value)
}

export function resolveLanguages(tags: readonly string[]): Locale {
  for (const tag of tags) {
    try {
      const locale = new Intl.Locale(tag)
      if (locale.language === 'zh') {
        // 显式文字优先于地区，例如 zh-Hant-CN 仍是繁体中文。
        if (locale.maximize().script === 'Hans') return 'zh-CN'
      } else if (isLocale(locale.language)) return locale.language
    } catch {
      // 忽略单个无效标签，继续检查浏览器后续的语言偏好。
    }
  }
  return 'en'
}

export function savedPreference(cookie: string): Preference {
  for (const item of cookie.split(';')) {
    const pair = item.trim()
    if (!pair.startsWith(cookieName + '=')) continue
    const value = pair.slice(cookieName.length + 1)
    if (isLocale(value)) return value
  }
  return 'auto'
}

export function requestLanguage(request: Request): { locale: Locale; preference: Preference } {
  const preference = savedPreference(request.headers.get('Cookie') ?? '')
  if (preference !== 'auto') return { locale: preference, preference }

  const candidates: { tag: string; weight: number }[] = []
  // 限流错误页也要协商语言，限制不可信请求头触发的解析工作量。
  const header = request.headers.get('Accept-Language') ?? ''
  if (header.length > 4096) return { locale: 'en', preference: 'auto' }
  for (const item of header.split(',', 32)) {
    const entry = /^([\w-]+)(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(item.trim())
    if (!entry) continue
    const weight = Number(entry[2] ?? 1)
    if (weight > 0) candidates.push({ tag: entry[1], weight })
  }
  candidates.sort((first, second) => second.weight - first.weight)
  return { locale: resolveLanguages(candidates.map(candidate => candidate.tag)), preference: 'auto' }
}

type BrowserContext = { document?: { cookie: string }; location?: { protocol: string } }

export function rememberLanguage(preference: Preference, browser: BrowserContext = globalThis as BrowserContext): void {
  try {
    if (!browser.document) return
    const clear = preference === 'auto'
    const secure = browser.location?.protocol === 'https:' ? '; Secure' : ''
    browser.document.cookie = `${cookieName}=${clear ? '' : preference}; Path=/f/; Max-Age=${clear ? 0 : 31536000}; SameSite=Lax${secure}`
  } catch {
    // 受限浏览上下文可能拒绝 cookie；当前页面仍使用内存中的选择。
  }
}

const en = {
  title: 'File download',
  language: 'Language',
  automatic: 'Automatic',
  ready: 'Ready to download',
  download: 'Download file',
  restart: 'Download again',
  cancel: 'Cancel',
  copy: 'Copy link',
  save: 'Save file',
  progress: 'Download progress',
  initialMode: 'Start the download when you’re ready.',
  pickerMode: 'Choose where to save the file when you start.',
  blobMode: 'When the download is ready, select Save file.',
  tooLarge: 'This browser can save files up to 20 MiB. Copy the link and open it in a browser that can save larger files, such as desktop Chrome or Edge.',
  keepOpen: 'Keep this page open during the download. If you refresh, you will need to start again.',
  picking: 'Choose a save location.',
  checking: 'Checking file availability…',
  downloading: 'Downloading…',
  committing: 'Finishing download…',
  saved: 'File saved to your chosen location.',
  blobReady: 'Your file is ready. Select Save file to save it to your device.',
  cancelled: 'Download cancelled. Download again to start from the beginning.',
  failed: 'Download incomplete.',
  copied: 'Link copied.',
  copyUnsupported: 'Copy the link from your address bar.',
  copyFailed: 'Couldn’t copy the link. Copy it from your address bar.',
  unavailable: 'File unavailable',
  missing: 'File not found. Check the link with the sender.',
  gone: 'This link is no longer available. Ask the sender for a new link.',
  rateLimited: 'Too many requests. Wait a moment and try again.',
  temporary: 'The service is temporarily unavailable. Try again later.',
  noScript: 'Enable JavaScript to download this file.',
  badMetadata: 'The file details are invalid. Refresh the page and try again.',
  timeout: 'The server took too long to respond. Try again.',
  versionChanged: 'The file has changed. Refresh the page to download the current version.',
  badRange: 'The data received does not match the requested part of the file. Start the download again.',
  overflow: 'The server sent more data than expected. Start the download again.',
  writeFailed: 'Couldn’t write the file. Check your free disk space and write permissions.',
  rollbackFailed: 'Couldn’t recover the interrupted part. Start the download again.',
  incomplete: 'Part of the file is missing. Start the download again.',
  network: 'Connection interrupted. Check your connection and try again.',
  longWait: 'The service needs more time. Try downloading again later.',
  badPosition: 'Couldn’t write the data in the correct order. Start the download again.',
  badLength: 'The file size is inconsistent. Start the download again.',
  notComplete: 'The file is incomplete. Start the download again.',
  saveFailed: 'Couldn’t save the file. Check your browser permissions and try again.',
  metadataFailed: 'Couldn’t read the file details. Try again later.',
}

type Copy = typeof en

const es: Copy = {
  title: 'Descarga de archivo',
  language: 'Idioma',
  automatic: 'Automático',
  ready: 'Listo para descargar',
  download: 'Descargar archivo',
  restart: 'Volver a descargar',
  cancel: 'Cancelar',
  copy: 'Copiar enlace',
  save: 'Guardar archivo',
  progress: 'Progreso de la descarga',
  initialMode: 'Inicia la descarga cuando quieras.',
  pickerMode: 'Al iniciar la descarga, elige dónde guardar el archivo.',
  blobMode: 'Cuando termine la descarga, selecciona «Guardar archivo».',
  tooLarge: 'Este navegador permite guardar archivos de hasta 20 MiB. Copia el enlace y ábrelo en un navegador que admita archivos más grandes, como Chrome o Edge para computadoras.',
  keepOpen: 'Mantén esta página abierta durante la descarga. Si la recargas, tendrás que empezar de nuevo.',
  picking: 'Elige dónde guardar el archivo.',
  checking: 'Comprobando la disponibilidad del archivo…',
  downloading: 'Descargando…',
  committing: 'Finalizando la descarga…',
  saved: 'El archivo se guardó en la ubicación que elegiste.',
  blobReady: 'El archivo está listo. Selecciona «Guardar archivo» para guardarlo en tu dispositivo.',
  cancelled: 'Descarga cancelada. Si vuelves a descargar el archivo, comenzarás desde el principio.',
  failed: 'Descarga incompleta.',
  copied: 'Enlace copiado.',
  copyUnsupported: 'Copia el enlace de la barra de direcciones.',
  copyFailed: 'No se pudo copiar el enlace. Cópialo de la barra de direcciones.',
  unavailable: 'Archivo no disponible',
  missing: 'No se encontró el archivo. Confirma el enlace con quien te lo envió.',
  gone: 'El enlace ya no está disponible. Pide un enlace nuevo a quien te lo envió.',
  rateLimited: 'Hay demasiadas solicitudes. Espera un momento y vuelve a intentarlo.',
  temporary: 'El servicio no está disponible por el momento. Vuelve a intentarlo más tarde.',
  noScript: 'Activa JavaScript para descargar este archivo.',
  badMetadata: 'Los datos del archivo no son válidos. Recarga la página y vuelve a intentarlo.',
  timeout: 'El servidor tardó demasiado en responder. Vuelve a intentarlo.',
  versionChanged: 'El archivo cambió. Recarga la página para descargar la versión actual.',
  badRange: 'Los datos recibidos no coinciden con la parte solicitada del archivo. Reinicia la descarga.',
  overflow: 'El servidor envió más datos de los esperados. Reinicia la descarga.',
  writeFailed: 'No se pudo escribir el archivo. Comprueba el espacio libre y los permisos de escritura.',
  rollbackFailed: 'No se pudo recuperar la parte interrumpida. Reinicia la descarga.',
  incomplete: 'Falta una parte del archivo. Reinicia la descarga.',
  network: 'Se interrumpió la conexión. Compruébala y vuelve a intentarlo.',
  longWait: 'El servicio necesita más tiempo. Vuelve a descargar el archivo más tarde.',
  badPosition: 'No se pudieron escribir los datos en el orden correcto. Reinicia la descarga.',
  badLength: 'El tamaño del archivo no coincide con el esperado. Reinicia la descarga.',
  notComplete: 'El archivo está incompleto. Reinicia la descarga.',
  saveFailed: 'No se pudo guardar el archivo. Comprueba los permisos del navegador y vuelve a intentarlo.',
  metadataFailed: 'No se pudieron leer los datos del archivo. Vuelve a intentarlo más tarde.',
}

const hi: Copy = {
  title: 'फ़ाइल डाउनलोड',
  language: 'भाषा',
  automatic: 'स्वचालित',
  ready: 'डाउनलोड के लिए तैयार',
  download: 'फ़ाइल डाउनलोड करें',
  restart: 'फिर से डाउनलोड करें',
  cancel: 'रद्द करें',
  copy: 'लिंक कॉपी करें',
  save: 'फ़ाइल सहेजें',
  progress: 'डाउनलोड की प्रगति',
  initialMode: 'जब चाहें, डाउनलोड शुरू करें।',
  pickerMode: 'डाउनलोड शुरू करते समय चुनें कि फ़ाइल कहाँ सहेजनी है।',
  blobMode: 'डाउनलोड पूरा होने पर “फ़ाइल सहेजें” चुनें।',
  tooLarge: 'यह ब्राउज़र 20 MiB तक की फ़ाइलें सहेज सकता है। लिंक कॉपी करें और उसे बड़ी फ़ाइलें सहेजने वाले ब्राउज़र में खोलें, जैसे कंप्यूटर पर Chrome या Edge।',
  keepOpen: 'डाउनलोड के दौरान यह पेज खुला रखें। पेज रीफ़्रेश करने पर डाउनलोड फिर से शुरू करना होगा।',
  picking: 'फ़ाइल सहेजने की जगह चुनें।',
  checking: 'फ़ाइल की उपलब्धता जाँची जा रही है…',
  downloading: 'डाउनलोड हो रहा है…',
  committing: 'डाउनलोड पूरा किया जा रहा है…',
  saved: 'फ़ाइल आपकी चुनी हुई जगह पर सहेज ली गई है।',
  blobReady: 'आपकी फ़ाइल तैयार है। इसे अपने डिवाइस पर सहेजने के लिए “फ़ाइल सहेजें” चुनें।',
  cancelled: 'डाउनलोड रद्द कर दिया गया है। दोबारा डाउनलोड करने पर फ़ाइल शुरू से डाउनलोड होगी।',
  failed: 'डाउनलोड अधूरा है।',
  copied: 'लिंक कॉपी कर लिया गया है।',
  copyUnsupported: 'ब्राउज़र के पता बार से लिंक कॉपी करें।',
  copyFailed: 'लिंक कॉपी नहीं हो सका। इसे ब्राउज़र के पता बार से कॉपी करें।',
  unavailable: 'फ़ाइल उपलब्ध नहीं है',
  missing: 'फ़ाइल नहीं मिली। भेजने वाले से लिंक की पुष्टि करें।',
  gone: 'यह लिंक अब उपलब्ध नहीं है। भेजने वाले से नया लिंक माँगें।',
  rateLimited: 'बहुत ज़्यादा अनुरोध आए हैं। थोड़ी देर बाद फिर कोशिश करें।',
  temporary: 'सेवा फ़िलहाल उपलब्ध नहीं है। कुछ देर बाद फिर कोशिश करें।',
  noScript: 'यह फ़ाइल डाउनलोड करने के लिए JavaScript चालू करें।',
  badMetadata: 'फ़ाइल का विवरण सही नहीं है। पेज रीफ़्रेश करके फिर कोशिश करें।',
  timeout: 'सर्वर से समय पर जवाब नहीं मिला। फिर कोशिश करें।',
  versionChanged: 'फ़ाइल बदल गई है। नया संस्करण डाउनलोड करने के लिए पेज रीफ़्रेश करें।',
  badRange: 'मिला हुआ डेटा फ़ाइल के माँगे गए हिस्से से मेल नहीं खाता। डाउनलोड फिर से शुरू करें।',
  overflow: 'सर्वर ने उम्मीद से ज़्यादा डेटा भेजा है। डाउनलोड फिर से शुरू करें।',
  writeFailed: 'फ़ाइल में डेटा नहीं लिखा जा सका। डिस्क में खाली जगह और लिखने की अनुमति जाँचें।',
  rollbackFailed: 'डाउनलोड के अधूरे हिस्से को ठीक नहीं किया जा सका। डाउनलोड फिर से शुरू करें।',
  incomplete: 'फ़ाइल का कुछ हिस्सा नहीं मिला। डाउनलोड फिर से शुरू करें।',
  network: 'कनेक्शन टूट गया है। अपना कनेक्शन जाँचें और फिर कोशिश करें।',
  longWait: 'सेवा को और समय चाहिए। कुछ देर बाद फिर से डाउनलोड करें।',
  badPosition: 'डेटा सही क्रम में नहीं लिखा जा सका। डाउनलोड फिर से शुरू करें।',
  badLength: 'फ़ाइल का आकार अपेक्षित आकार से मेल नहीं खाता। डाउनलोड फिर से शुरू करें।',
  notComplete: 'फ़ाइल अधूरी है। डाउनलोड फिर से शुरू करें।',
  saveFailed: 'फ़ाइल सहेजी नहीं जा सकी। ब्राउज़र की अनुमतियाँ जाँचें और फिर कोशिश करें।',
  metadataFailed: 'फ़ाइल का विवरण नहीं मिल सका। कुछ देर बाद फिर कोशिश करें।',
}

const zh: Copy = {
  title: '文件下载',
  language: '语言',
  automatic: '自动',
  ready: '可以下载',
  download: '下载文件',
  restart: '重新下载',
  cancel: '取消',
  copy: '复制链接',
  save: '保存文件',
  progress: '下载进度',
  initialMode: '准备好后即可开始下载。',
  pickerMode: '开始下载时，请选择文件的保存位置。',
  blobMode: '下载就绪后，请点击“保存文件”。',
  tooLarge: '此浏览器最多可保存 20 MiB 的文件。请复制链接，在支持保存更大文件的浏览器中打开，例如桌面版 Chrome 或 Edge。',
  keepOpen: '下载期间请保持页面打开。刷新后需从头下载。',
  picking: '请选择文件的保存位置。',
  checking: '正在确认文件状态…',
  downloading: '正在下载…',
  committing: '正在完成下载…',
  saved: '文件已保存到所选位置。',
  blobReady: '文件已准备好，请点击“保存文件”将其保存到设备。',
  cancelled: '下载已取消。重新下载将从头开始。',
  failed: '下载未完成。',
  copied: '链接已复制。',
  copyUnsupported: '请从浏览器地址栏复制链接。',
  copyFailed: '复制失败，请从浏览器地址栏复制链接。',
  unavailable: '文件暂不可用',
  missing: '未找到文件，请向发送者确认链接。',
  gone: '链接已失效，请向发送者索取新链接。',
  rateLimited: '请求过于频繁，请稍后重试。',
  temporary: '服务暂时不可用，请稍后重试。',
  noScript: '请启用 JavaScript 以下载此文件。',
  badMetadata: '文件信息无效，请刷新页面后重试。',
  timeout: '服务器响应超时，请重试。',
  versionChanged: '文件版本已变化，请刷新页面下载最新版本。',
  badRange: '收到的数据与请求的文件片段不匹配，请重新下载。',
  overflow: '服务器返回的数据超出预期范围，请重新下载。',
  writeFailed: '无法写入文件，请检查磁盘空间和写入权限。',
  rollbackFailed: '无法恢复中断的文件片段，请重新下载。',
  incomplete: '收到的文件片段不完整，请重新下载。',
  network: '网络连接中断，请检查网络后重试。',
  longWait: '服务需要较长的等待时间，请稍后重新下载。',
  badPosition: '文件片段写入顺序有误，请重新下载。',
  badLength: '文件大小与预期不符，请重新下载。',
  notComplete: '文件不完整，请重新下载。',
  saveFailed: '无法保存文件，请检查浏览器权限后重试。',
  metadataFailed: '无法读取文件信息，请稍后重试。',
}

const catalog: Record<Locale, Copy> = { en, es, hi, 'zh-CN': zh }

type Phrases = {
  amount: (received: string, total: string) => string
  retry: (seconds: string, attempt: string) => string
  http: (status: number) => string
}

const phrases: Record<Locale, Phrases> = {
  en: {
    amount: (received, total) => `${received} of ${total}`,
    retry: (seconds, attempt) => `Retrying this part in ${seconds} (attempt ${attempt} of 3).`,
    http: status => `Download request failed (HTTP ${status}). Try again.`,
  },
  es: {
    amount: (received, total) => `${received} de ${total}`,
    retry: (seconds, attempt) => `Se reintentará esta parte en ${seconds} (intento ${attempt} de 3).`,
    http: status => `La solicitud de descarga falló (HTTP ${status}). Vuelve a intentarlo.`,
  },
  hi: {
    amount: (received, total) => `${total} में से ${received}`,
    retry: (seconds, attempt) => `${seconds} में इस हिस्से को फिर डाउनलोड करेंगे (3 में से कोशिश ${attempt})।`,
    http: status => `डाउनलोड अनुरोध विफल रहा (HTTP ${status})। फिर कोशिश करें।`,
  },
  'zh-CN': {
    amount: (received, total) => `${received} / ${total}`,
    retry: (seconds, attempt) => `将在 ${seconds}后重试当前片段（第 ${attempt} 次，共 3 次）。`,
    http: status => `下载请求失败（HTTP ${status}），请重试。`,
  },
}

function buildMessages(locale: Locale) {
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const bytes = new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'long' })
  const seconds = new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', unitDisplay: 'long' })
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
  const text = phrases[locale]
  const units = ['KiB', 'MiB', 'GiB', 'TiB']

  function size(value: number): string {
    if (value < 1024) return bytes.format(value)
    const index = Math.min(Math.floor(Math.log2(value) / 10) - 1, units.length - 1)
    return `${numbers.format(value / 1024 ** (index + 1))}\u00a0${units[index]}`
  }

  return {
    ...catalog[locale], size,
    amount: (value: number, total: number) => text.amount(bytes.format(value), bytes.format(total)),
    percent: (fraction: number) => percent.format(Math.floor(fraction * 1000) / 1000),
    retry: (delay: number, attempt: number) => text.retry(seconds.format(delay), numbers.format(attempt)),
    http: text.http,
  }
}

// 进度回调可能每次收到一段数据就触发，每种语言只初始化一次数字格式器。
const cachedMessages = new Map<Locale, ReturnType<typeof buildMessages>>()

export function messages(locale: Locale): ReturnType<typeof buildMessages> {
  const cached = cachedMessages.get(locale)
  if (cached) return cached
  const result = buildMessages(locale)
  cachedMessages.set(locale, result)
  return result
}
