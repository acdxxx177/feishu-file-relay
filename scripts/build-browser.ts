import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export async function buildBrowser(): Promise<void> {
  await mkdir('.local/browser', { recursive: true })
  // TypeScript 7 不再导出旧 transpileModule API，使用项目锁定的编译器 CLI。
  await promisify(execFile)(process.execPath, [resolve('node_modules/typescript/lib/tsc.js'), '-p', 'tsconfig.browser.json', '--noEmit', 'false', '--outDir', '.local/browser'], { windowsHide: true })
  const browserScript = await readFile('.local/browser/download-controller.js', 'utf8')
  const browserCss = await readFile('src/browser/download.css', 'utf8')
  // 编译为静态字符串模块，避免测试专用 RPC 包装入口遗漏 Wrangler 的外置 Text 模块。
  await writeFile('.local/browser/assets.ts', `export const browserScript = ${JSON.stringify(browserScript)}\nexport const browserCss = ${JSON.stringify(browserCss)}\n`, 'utf8')
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/build-browser.ts')) await buildBrowser()
