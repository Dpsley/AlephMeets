import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const buildDir = resolve(here, '../build')
const svgPath = resolve(here, '../src/assets/featherIcon.svg')
const pngPath = resolve(buildDir, 'icon.png')
const icoPath = resolve(buildDir, 'icon.ico')

await mkdir(buildDir, { recursive: true })
const transparent = { r: 0, g: 0, b: 0, alpha: 0 }
const svg = await readFile(svgPath)

async function renderSystemIcon(size) {
  const circle = Buffer.from(`
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.46}"
        fill="#ffffff" stroke="#dfe3f5" stroke-width="${Math.max(1, size * 0.014)}" />
    </svg>
  `)
  const logo = await sharp(svg)
    .resize(Math.round(size * 0.62), Math.round(size * 0.62), {
      fit: 'contain',
      background: transparent,
    })
    .png()
    .toBuffer()

  return sharp({
    create: { width: size, height: size, channels: 4, background: transparent },
  })
    .composite([
      { input: circle, gravity: 'center' },
      { input: logo, gravity: 'center' },
    ])
    .png()
    .toBuffer()
}

await writeFile(pngPath, await renderSystemIcon(1024))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = await Promise.all(sizes.map(renderSystemIcon))
await writeFile(icoPath, await pngToIco(frames))
