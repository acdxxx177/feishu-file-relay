function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function renderDownloadPage(file: { name: string; size: number } | null, status = 200): string {
  const error = status === 410 ? '文件链接已撤销或源文件已失效。' : status === 404 ? '未找到该文件，请向发送者确认链接。' : '服务暂时不可用，请稍后刷新。'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>文件下载</title><link rel="stylesheet" href="/assets/download.css"><script type="module" src="/assets/download.js"></script></head><body><main><h1>文件下载</h1><section aria-label="文件信息"><p id="filename">${file ? escape(file.name) : '文件暂不可用'}</p><p id="filesize">${file ? `${file.size.toLocaleString('zh-CN')} 字节 · 可下载` : escape(error)}</p></section><section aria-label="下载操作"><p id="mode">点击下载后选择保存位置。页面打开不会自动下载文件。</p><progress id="progress" max="100" value="0" aria-label="下载进度"></progress><p id="amount">0% · 0 字节</p><p id="status" role="status" aria-live="polite">${file ? '准备就绪' : escape(error)}</p><div class="actions"><button id="download" ${file ? '' : 'disabled'}>下载文件</button><button id="cancel" disabled>取消</button><button id="copy">复制链接</button><a id="save" hidden>保存已下载文件</a></div><p id="error" role="alert"></p></section><footer>下载期间请保持页面打开。中断将自动重试当前分片；刷新页面后需重新开始。</footer></main></body></html>`
}
