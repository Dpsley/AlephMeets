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
await sharp(svgPath)
  .resize(1024, 1024, { fit: 'contain', background: transparent })
  .png()
  .toFile(pngPath)

const svg = await readFile(svgPath)
const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = await Promise.all(
  sizes.map((size) => sharp(svg)
    .resize(size, size, { fit: 'contain', background: transparent })
    .png()
    .toBuffer()),
)
await writeFile(icoPath, await pngToIco(frames))
