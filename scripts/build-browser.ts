import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

export async function buildBrowser(): Promise<void> {
  await mkdir('.local/browser', { recursive: true })
  // 页面只有一个同源脚本入口；把共享的语言模块一起打包，避免浏览器请求未发布的模块。
  const bundle = await build({
    entryPoints: ['src/browser/download-ui.ts'],
    platform: 'browser', format: 'esm', target: 'es2022',
    bundle: true, write: false, charset: 'utf8',
  })
  const browserScript = bundle.outputFiles[0].text
  const browserCss = await readFile('src/browser/download.css', 'utf8')
  // 编译为静态字符串模块，避免测试专用 RPC 包装入口遗漏 Wrangler 的外置 Text 模块。
  await writeFile('.local/browser/assets.ts', `export const browserScript = ${JSON.stringify(browserScript)}\nexport const browserCss = ${JSON.stringify(browserCss)}\n`, 'utf8')
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/build-browser.ts')) await buildBrowser()
