import { build } from 'esbuild'
import { buildBrowser } from './build-browser.ts'

await buildBrowser()
await build({ entryPoints: ['src/vps/main.ts'], outfile: 'dist/vps/main.js', bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true })
