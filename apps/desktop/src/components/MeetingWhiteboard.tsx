import { useRoomContext } from '@livekit/components-react'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'
import {
  ArrowRight,
  Circle,
  Download,
  Eraser,
  GitBranch,
  MousePointer2,
  Paintbrush,
  RotateCcw,
  Square,
  Trash2,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type WhiteboardTool = 'select' | 'pen' | 'eraser' | 'text' | 'arrow' | 'process' | 'decision' | 'terminator'
type ShapeType = 'process' | 'decision' | 'terminator'

type WhiteboardPoint = {
  x: number
  y: number
}

type WhiteboardBase = {
  id: string
  color: string
  authorId: string
  authorName: string
}

type WhiteboardStroke = WhiteboardBase & {
  kind: 'stroke'
  points: WhiteboardPoint[]
  width: number
}

type WhiteboardText = WhiteboardBase & {
  kind: 'text'
  x: number
  y: number
  width: number
  height: number
  text: string
}

type WhiteboardShape = WhiteboardBase & {
  kind: 'shape'
  shape: ShapeType
  x: number
  y: number
  width: number
  height: number
  fill: string
}

type WhiteboardArrow = WhiteboardBase & {
  kind: 'arrow'
  start: WhiteboardPoint
  end: WhiteboardPoint
  width: number
}

export type WhiteboardItem = WhiteboardStroke | WhiteboardText | WhiteboardShape | WhiteboardArrow
type DraftItem = WhiteboardStroke | WhiteboardText | WhiteboardShape | WhiteboardArrow

type MoveState = {
  item: WhiteboardItem
  startPoint: WhiteboardPoint
  moved: boolean
}

type TextEditorState = {
  itemId: string
  value: string
}

type WhiteboardMessage =
  | { type: 'whiteboard:add'; item: WhiteboardItem }
  | { type: 'whiteboard:remove'; itemId: string }
  | { type: 'whiteboard:clear' }

type ViewBox = {
  x: number
  y: number
  width: number
  height: number
}

const WHITEBOARD_TOPIC = 'aleph:whiteboard'
const BOARD_WIDTH = 1000
const BOARD_HEIGHT = 600
const BOARD_ASPECT = BOARD_WIDTH / BOARD_HEIGHT
const GRID_SIZE = 25
const MIN_VIEW_WIDTH = 180
const MIN_SHAPE_SIZE = 24
const DEFAULT_SHAPE_WIDTH = 180
const DEFAULT_SHAPE_HEIGHT = 90
const DEFAULT_TEXT_WIDTH = 210
const DEFAULT_TEXT_HEIGHT = 80
const DEFAULT_ARROW_LENGTH = 160
const INITIAL_VIEW_BOX: ViewBox = { x: 0, y: 0, width: BOARD_WIDTH, height: BOARD_HEIGHT }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampViewBox(viewBox: ViewBox): ViewBox {
  const width = clamp(viewBox.width, MIN_VIEW_WIDTH, BOARD_WIDTH)
  const height = width / BOARD_ASPECT
  return {
    x: clamp(viewBox.x, 0, BOARD_WIDTH - width),
    y: clamp(viewBox.y, 0, BOARD_HEIGHT - height),
    width,
    height,
  }
}

function author(room: ReturnType<typeof useRoomContext>): Pick<WhiteboardBase, 'authorId' | 'authorName'> {
  return {
    authorId: room.localParticipant.identity,
    authorName: room.localParticipant.name || room.localParticipant.identity,
  }
}

function readWhiteboardMessage(payload: Uint8Array): WhiteboardMessage | null {
  try {
    const parsed = JSON.parse(decoder.decode(payload)) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const message = parsed as Partial<WhiteboardMessage>
    if (message.type === 'whiteboard:clear') return { type: 'whiteboard:clear' }
    if (message.type === 'whiteboard:remove' && typeof message.itemId === 'string') {
      return { type: 'whiteboard:remove', itemId: message.itemId }
    }
    if (message.type === 'whiteboard:add' && 'item' in message) return message as WhiteboardMessage
    return null
  } catch {
    return null
  }
}

function compactStroke(stroke: WhiteboardStroke): WhiteboardStroke {
  if (stroke.points.length <= 420) return stroke
  const step = Math.ceil(stroke.points.length / 420)
  return {
    ...stroke,
    points: stroke.points.filter((_point, index) => index === 0 || index === stroke.points.length - 1 || index % step === 0),
  }
}

function pointsToPath(points: WhiteboardPoint[]): string {
  if (!points.length) return ''
  const first = points[0]!
  const rest = points.slice(1)
  return [
    `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`,
    ...rest.map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
  ].join(' ')
}

function arrowHeadPoints(arrow: WhiteboardArrow): string {
  const angle = Math.atan2(arrow.end.y - arrow.start.y, arrow.end.x - arrow.start.x)
  const length = 18
  const width = 11
  const base = {
    x: arrow.end.x - Math.cos(angle) * length,
    y: arrow.end.y - Math.sin(angle) * length,
  }
  const normal = {
    x: Math.cos(angle + Math.PI / 2) * width,
    y: Math.sin(angle + Math.PI / 2) * width,
  }
  return [
    `${arrow.end.x},${arrow.end.y}`,
    `${base.x + normal.x},${base.y + normal.y}`,
    `${base.x - normal.x},${base.y - normal.y}`,
  ].join(' ')
}

function normalizeBox<T extends WhiteboardShape | WhiteboardText>(item: T): T {
  let { x, y, width, height } = item
  if (width < 0) {
    x += width
    width = Math.abs(width)
  }
  if (height < 0) {
    y += height
    height = Math.abs(height)
  }
  return {
    ...item,
    x: clamp(x, 0, BOARD_WIDTH),
    y: clamp(y, 0, BOARD_HEIGHT),
    width: clamp(width, MIN_SHAPE_SIZE, BOARD_WIDTH),
    height: clamp(height, MIN_SHAPE_SIZE, BOARD_HEIGHT),
  }
}

function defaultShapeAt(item: WhiteboardShape): WhiteboardShape {
  return {
    ...item,
    x: clamp(item.x - DEFAULT_SHAPE_WIDTH / 2, 0, BOARD_WIDTH - DEFAULT_SHAPE_WIDTH),
    y: clamp(item.y - DEFAULT_SHAPE_HEIGHT / 2, 0, BOARD_HEIGHT - DEFAULT_SHAPE_HEIGHT),
    width: DEFAULT_SHAPE_WIDTH,
    height: DEFAULT_SHAPE_HEIGHT,
  }
}

function defaultTextAt(item: WhiteboardText): WhiteboardText {
  return {
    ...item,
    x: clamp(item.x - DEFAULT_TEXT_WIDTH / 2, 0, BOARD_WIDTH - DEFAULT_TEXT_WIDTH),
    y: clamp(item.y - DEFAULT_TEXT_HEIGHT / 2, 0, BOARD_HEIGHT - DEFAULT_TEXT_HEIGHT),
    width: DEFAULT_TEXT_WIDTH,
    height: DEFAULT_TEXT_HEIGHT,
  }
}

function defaultArrowAt(item: WhiteboardArrow): WhiteboardArrow {
  return {
    ...item,
    end: {
      x: clamp(item.start.x + DEFAULT_ARROW_LENGTH, 0, BOARD_WIDTH),
      y: item.start.y,
    },
  }
}

function pointSegmentDistance(point: WhiteboardPoint, start: WhiteboardPoint, end: WhiteboardPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1)
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

function pointInBox(point: WhiteboardPoint, item: WhiteboardShape | WhiteboardText): boolean {
  return point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height
}

function clampDelta(bounds: { minX: number; minY: number; maxX: number; maxY: number }, dx: number, dy: number): WhiteboardPoint {
  return {
    x: clamp(dx, -bounds.minX, BOARD_WIDTH - bounds.maxX),
    y: clamp(dy, -bounds.minY, BOARD_HEIGHT - bounds.maxY),
  }
}

function strokeBounds(points: WhiteboardPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
}

function translateItem(item: WhiteboardItem, dx: number, dy: number): WhiteboardItem {
  if (item.kind === 'shape' || item.kind === 'text') {
    return {
      ...item,
      x: clamp(item.x + dx, 0, BOARD_WIDTH - item.width),
      y: clamp(item.y + dy, 0, BOARD_HEIGHT - item.height),
    }
  }

  if (item.kind === 'arrow') {
    const bounds = {
      minX: Math.min(item.start.x, item.end.x),
      minY: Math.min(item.start.y, item.end.y),
      maxX: Math.max(item.start.x, item.end.x),
      maxY: Math.max(item.start.y, item.end.y),
    }
    const delta = clampDelta(bounds, dx, dy)
    return {
      ...item,
      start: { x: item.start.x + delta.x, y: item.start.y + delta.y },
      end: { x: item.end.x + delta.x, y: item.end.y + delta.y },
    }
  }

  const delta = clampDelta(strokeBounds(item.points), dx, dy)
  return {
    ...item,
    points: item.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })),
  }
}

function itemHitDistance(item: WhiteboardItem, point: WhiteboardPoint): number {
  if (item.kind === 'text' || item.kind === 'shape') return pointInBox(point, item) ? 0 : Infinity
  if (item.kind === 'arrow') return pointSegmentDistance(point, item.start, item.end)
  let nearest = Infinity
  for (let index = 1; index < item.points.length; index += 1) {
    nearest = Math.min(nearest, pointSegmentDistance(point, item.points[index - 1]!, item.points[index]!))
  }
  return nearest
}

function textLines(item: WhiteboardText): string[] {
  return item.text.split('\n').map((line) => line.trimEnd()).filter((line) => line.length)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Не удалось подготовить PNG.'))
    reader.readAsDataURL(blob)
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Не удалось создать PNG.'))
    }, 'image/png')
  })
}

function exportFilename(): string {
  const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace(/Z$/, '')
  return `aleph-whiteboard-${stamp}.png`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function svgNonTextItem(item: Exclude<WhiteboardItem, WhiteboardText>): string {
  if (item.kind === 'stroke') {
    return `<path d="${pointsToPath(item.points)}" stroke="${escapeXml(item.color)}" stroke-width="${item.width}" stroke-linecap="round" stroke-linejoin="round" fill="none" />`
  }
  if (item.kind === 'arrow') {
    return [
      `<line x1="${item.start.x}" y1="${item.start.y}" x2="${item.end.x}" y2="${item.end.y}" stroke="${escapeXml(item.color)}" stroke-width="${item.width}" stroke-linecap="round" />`,
      `<polygon points="${arrowHeadPoints(item)}" fill="${escapeXml(item.color)}" />`,
    ].join('')
  }
  if (item.shape === 'decision') {
    const points = [
      `${item.x + item.width / 2},${item.y}`,
      `${item.x + item.width},${item.y + item.height / 2}`,
      `${item.x + item.width / 2},${item.y + item.height}`,
      `${item.x},${item.y + item.height / 2}`,
    ].join(' ')
    return `<polygon points="${points}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.color)}" stroke-width="3" />`
  }
  if (item.shape === 'terminator') {
    return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="${item.height / 2}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.color)}" stroke-width="3" />`
  }
  return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="12" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.color)}" stroke-width="3" />`
}

function svgTextItem(item: WhiteboardText): string {
  const lines = textLines(item)
  const tspans = (lines.length ? lines : ['Текст']).map((line, index) => (
    `<tspan x="${item.x + 11}" dy="${index === 0 ? 0 : 27}">${escapeXml(line)}</tspan>`
  )).join('')
  return [
    `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="8" fill="transparent" stroke="${escapeXml(item.color)}" stroke-width="2" stroke-dasharray="7 5" />`,
    `<text x="${item.x + 11}" y="${item.y + 28}" fill="${escapeXml(item.color)}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="22" font-weight="700">${tspans}</text>`,
  ].join('')
}

export function whiteboardItemsToSvgSource(items: readonly WhiteboardItem[]): string {
  const nonText = items.filter((item): item is Exclude<WhiteboardItem, WhiteboardText> => item.kind !== 'text')
  const text = items.filter((item): item is WhiteboardText => item.kind === 'text')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_WIDTH * 2}" height="${BOARD_HEIGHT * 2}" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}">
  <defs>
    <pattern id="whiteboard-grid" width="${GRID_SIZE}" height="${GRID_SIZE}" patternUnits="userSpaceOnUse">
      <path d="M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}" fill="none" stroke="#e0e7ef" stroke-width="1" />
    </pattern>
    <pattern id="whiteboard-grid-large" width="${GRID_SIZE * 4}" height="${GRID_SIZE * 4}" patternUnits="userSpaceOnUse">
      <rect width="${GRID_SIZE * 4}" height="${GRID_SIZE * 4}" fill="url(#whiteboard-grid)" />
      <path d="M ${GRID_SIZE * 4} 0 L 0 0 0 ${GRID_SIZE * 4}" fill="none" stroke="#c9d4e1" stroke-width="1.4" />
    </pattern>
  </defs>
  <rect width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" rx="18" fill="#f7f8fa" />
  <rect width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" rx="18" fill="url(#whiteboard-grid-large)" />
  <g>${nonText.map(svgNonTextItem).join('')}</g>
  <g>${text.map(svgTextItem).join('')}</g>
</svg>`
}

export async function whiteboardItemsToPngBlob(items: readonly WhiteboardItem[]): Promise<Blob> {
  const svgSource = whiteboardItemsToSvgSource(items)
  const url = URL.createObjectURL(new Blob([svgSource], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Не удалось отрисовать доску в PNG.'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = BOARD_WIDTH * 2
    canvas.height = BOARD_HEIGHT * 2
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas недоступен.')
    context.fillStyle = '#f7f8fa'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvasToBlob(canvas)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function renderNonTextItem(item: Exclude<WhiteboardItem, WhiteboardText>): React.JSX.Element {
  if (item.kind === 'stroke') {
    return (
      <path
        key={item.id}
        d={pointsToPath(item.points)}
        stroke={item.color}
        strokeWidth={item.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        pointerEvents="none"
      />
    )
  }
  if (item.kind === 'arrow') {
    return (
      <g key={item.id} pointerEvents="none">
        <line
          x1={item.start.x}
          y1={item.start.y}
          x2={item.end.x}
          y2={item.end.y}
          stroke={item.color}
          strokeWidth={item.width}
          strokeLinecap="round"
        />
        <polygon points={arrowHeadPoints(item)} fill={item.color} />
      </g>
    )
  }
  if (item.shape === 'decision') {
    const points = [
      `${item.x + item.width / 2},${item.y}`,
      `${item.x + item.width},${item.y + item.height / 2}`,
      `${item.x + item.width / 2},${item.y + item.height}`,
      `${item.x},${item.y + item.height / 2}`,
    ].join(' ')
    return <polygon key={item.id} points={points} fill={item.fill} stroke={item.color} strokeWidth="3" pointerEvents="none" />
  }
  if (item.shape === 'terminator') {
    return <rect key={item.id} x={item.x} y={item.y} width={item.width} height={item.height} rx={item.height / 2} fill={item.fill} stroke={item.color} strokeWidth="3" pointerEvents="none" />
  }
  return <rect key={item.id} x={item.x} y={item.y} width={item.width} height={item.height} rx="12" fill={item.fill} stroke={item.color} strokeWidth="3" pointerEvents="none" />
}

function renderTextItem(item: WhiteboardText): React.JSX.Element {
  const lines = textLines(item)
  return (
    <g key={item.id} className="whiteboard-text-item" pointerEvents="none">
      <rect
        x={item.x}
        y={item.y}
        width={item.width}
        height={item.height}
        rx="8"
        fill="transparent"
        stroke={item.color}
        strokeWidth="2"
        strokeDasharray="7 5"
      />
      <text
        x={item.x + 11}
        y={item.y + 28}
        fill={item.color}
        fontFamily='Inter, "Segoe UI", Arial, sans-serif'
        fontSize="22"
        fontWeight="700"
      >
        {(lines.length ? lines : ['Текст']).map((line, index) => (
          <tspan key={`${item.id}-${index}`} x={item.x + 11} dy={index === 0 ? 0 : 27}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  )
}

export function MeetingWhiteboard({
  initialItems = [],
  onClose,
  onError,
  onItemsChange,
}: {
  initialItems?: WhiteboardItem[]
  onClose: () => void
  onError: (message: string) => void
  onItemsChange?: (items: WhiteboardItem[]) => void
}): React.JSX.Element {
  const room = useRoomContext()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const activeItemRef = useRef<DraftItem | null>(null)
  const pointerStartRef = useRef<WhiteboardPoint | null>(null)
  const erasingRef = useRef(false)
  const panningRef = useRef<{ clientX: number; clientY: number; viewBox: ViewBox } | null>(null)
  const movingRef = useRef<MoveState | null>(null)
  const [items, setItems] = useState<WhiteboardItem[]>(() => initialItems)
  const [tool, setTool] = useState<WhiteboardTool>('pen')
  const [color, setColor] = useState('#2563eb')
  const [viewBox, setViewBox] = useState<ViewBox>(INITIAL_VIEW_BOX)
  const [exporting, setExporting] = useState(false)
  const [editingText, setEditingText] = useState<TextEditorState | null>(null)

  useEffect(() => {
    onItemsChange?.(items)
  }, [items, onItemsChange])
  const zoomPercent = Math.round((BOARD_WIDTH / viewBox.width) * 100)

  const applyItem = useCallback((item: WhiteboardItem): void => {
    setItems((current) => {
      const index = current.findIndex((existing) => existing.id === item.id)
      if (index === -1) return [...current, item]
      const next = [...current]
      next[index] = item
      return next
    })
  }, [])

  const removeItem = useCallback((itemId: string): void => {
    setItems((current) => current.filter((item) => item.id !== itemId))
  }, [])

  const replaceItem = (item: WhiteboardItem): void => applyItem(item)

  const publish = useCallback(async (message: WhiteboardMessage): Promise<void> => {
    try {
      await room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), {
        reliable: true,
        topic: WHITEBOARD_TOPIC,
      })
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось синхронизировать доску.')
    }
  }, [onError, room])

  useEffect(() => {
    const handleData = (
      payload: Uint8Array,
      _participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ): void => {
      if (topic !== WHITEBOARD_TOPIC) return
      const message = readWhiteboardMessage(payload)
      if (!message) return
      if (message.type === 'whiteboard:clear') {
        setItems([])
      } else if (message.type === 'whiteboard:remove') {
        removeItem(message.itemId)
      } else {
        applyItem(message.item)
      }
    }
    room.on(RoomEvent.DataReceived, handleData)
    return () => {
      room.off(RoomEvent.DataReceived, handleData)
    }
  }, [applyItem, removeItem, room])

  const clientPoint = (clientX: number, clientY: number): WhiteboardPoint => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()?.inverse()
    if (!svg || !matrix) return { x: 0, y: 0 }
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const transformed = point.matrixTransform(matrix)
    return {
      x: clamp(transformed.x, 0, BOARD_WIDTH),
      y: clamp(transformed.y, 0, BOARD_HEIGHT),
    }
  }

  const boardPoint = (event: React.PointerEvent<SVGSVGElement>): WhiteboardPoint => clientPoint(event.clientX, event.clientY)

  const itemBase = (): WhiteboardBase => ({
    id: crypto.randomUUID(),
    color,
    ...author(room),
  })

  const eraseAt = useCallback((point: WhiteboardPoint): void => {
    const hit = [...items].reverse().find((item) => itemHitDistance(item, point) <= 13)
    if (!hit) return
    removeItem(hit.id)
    void publish({ type: 'whiteboard:remove', itemId: hit.id })
  }, [items, publish, removeItem])

  const zoomAt = (clientX: number, clientY: number, factor: number): void => {
    const point = clientPoint(clientX, clientY)
    setViewBox((current) => {
      const width = clamp(current.width * factor, MIN_VIEW_WIDTH, BOARD_WIDTH)
      const height = width / BOARD_ASPECT
      const scaleX = width / current.width
      const scaleY = height / current.height
      return clampViewBox({
        x: point.x - (point.x - current.x) * scaleX,
        y: point.y - (point.y - current.y) * scaleY,
        width,
        height,
      })
    })
  }

  const zoomFromCenter = (factor: number): void => {
    const svg = svgRef.current
    const bounds = svg?.getBoundingClientRect()
    if (bounds) zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, factor)
  }

  const findTextAt = useCallback((point: WhiteboardPoint): WhiteboardText | undefined => (
    [...items].reverse().find((candidate): candidate is WhiteboardText => (
      candidate.kind === 'text' && pointInBox(point, candidate)
    ))
  ), [items])

  const topItemAt = useCallback((point: WhiteboardPoint): WhiteboardItem | undefined => (
    [...items].reverse().find((item) => itemHitDistance(item, point) <= 13)
  ), [items])

  const editTextAt = (point: WhiteboardPoint): void => {
    const item = findTextAt(point)
    if (!item) return
    setEditingText({ itemId: item.id, value: item.text })
  }

  const saveTextEditor = (): void => {
    if (!editingText) return
    const item = items.find((candidate): candidate is WhiteboardText => (
      candidate.kind === 'text' && candidate.id === editingText.itemId
    ))
    if (!item) {
      setEditingText(null)
      return
    }
    const text = editingText.value.trim()
    if (!text) return
    const next = { ...item, text }
    replaceItem(next)
    void publish({ type: 'whiteboard:add', item: next })
    setEditingText(null)
  }

  const beginDraft = (event: React.PointerEvent<SVGSVGElement>): void => {
    const point = boardPoint(event)
    if (event.detail >= 2) {
      const textItem = findTextAt(point)
      if (textItem) {
        event.preventDefault()
        editTextAt(point)
        return
      }
    }

    if (event.shiftKey || event.button === 1 || event.button === 2) {
      panningRef.current = { clientX: event.clientX, clientY: event.clientY, viewBox }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    if (findTextAt(point) && tool !== 'select' && tool !== 'eraser') return
    if (tool === 'eraser') {
      erasingRef.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      eraseAt(point)
      return
    }
    if (tool === 'select') {
      const item = topItemAt(point)
      if (!item) return
      setEditingText(null)
      movingRef.current = { item, startPoint: point, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    setEditingText(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerStartRef.current = point
    const base = itemBase()
    const draft: DraftItem = tool === 'pen'
      ? { ...base, kind: 'stroke', points: [point], width: 4 }
      : tool === 'text'
        ? { ...base, kind: 'text', x: point.x, y: point.y, width: 1, height: 1, text: 'Текст' }
        : tool === 'arrow'
          ? { ...base, kind: 'arrow', start: point, end: point, width: 4 }
          : { ...base, kind: 'shape', shape: tool, x: point.x, y: point.y, width: 1, height: 1, fill: '#ffffff' }
    activeItemRef.current = draft
    applyItem(draft)
  }

  const continueDraft = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (panningRef.current) {
      const bounds = svgRef.current?.getBoundingClientRect()
      if (!bounds) return
      const pan = panningRef.current
      const dx = ((event.clientX - pan.clientX) / bounds.width) * pan.viewBox.width
      const dy = ((event.clientY - pan.clientY) / bounds.height) * pan.viewBox.height
      setViewBox(clampViewBox({ ...pan.viewBox, x: pan.viewBox.x - dx, y: pan.viewBox.y - dy }))
      return
    }
    const point = boardPoint(event)
    if (erasingRef.current) {
      eraseAt(point)
      return
    }
    if (movingRef.current) {
      const dx = point.x - movingRef.current.startPoint.x
      const dy = point.y - movingRef.current.startPoint.y
      const next = translateItem(movingRef.current.item, dx, dy)
      movingRef.current = { ...movingRef.current, moved: movingRef.current.moved || Math.hypot(dx, dy) > 1 }
      replaceItem(next)
      return
    }

    const draft = activeItemRef.current
    if (!draft) return
    if (draft.kind === 'stroke') {
      const previous = draft.points[draft.points.length - 1]
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 3) return
      const next = { ...draft, points: [...draft.points, point] }
      activeItemRef.current = next
      replaceItem(next)
      return
    }
    if (draft.kind === 'arrow') {
      const next = { ...draft, end: point }
      activeItemRef.current = next
      replaceItem(next)
      return
    }
    const start = pointerStartRef.current ?? { x: draft.x, y: draft.y }
    const next = normalizeBox({
      ...draft,
      x: start.x,
      y: start.y,
      width: point.x - start.x,
      height: point.y - start.y,
    })
    activeItemRef.current = next
    replaceItem(next)
  }

  const finishDraft = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (panningRef.current) {
      panningRef.current = null
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* noop */ }
      return
    }
    if (erasingRef.current) {
      erasingRef.current = false
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* noop */ }
      return
    }
    if (movingRef.current) {
      const point = boardPoint(event)
      const dx = point.x - movingRef.current.startPoint.x
      const dy = point.y - movingRef.current.startPoint.y
      const next = translateItem(movingRef.current.item, dx, dy)
      const moved = movingRef.current.moved || Math.hypot(dx, dy) > 1
      movingRef.current = null
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* noop */ }
      if (moved) {
        replaceItem(next)
        void publish({ type: 'whiteboard:add', item: next })
      }
      return
    }

    const draft = activeItemRef.current
    if (!draft) return
    activeItemRef.current = null
    pointerStartRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released when the cursor leaves the board.
    }

    if (draft.kind === 'stroke') {
      if (draft.points.length < 2) {
        removeItem(draft.id)
        return
      }
      const compacted = compactStroke(draft)
      replaceItem(compacted)
      void publish({ type: 'whiteboard:add', item: compacted })
      return
    }

    if (draft.kind === 'arrow') {
      const length = Math.hypot(draft.end.x - draft.start.x, draft.end.y - draft.start.y)
      const finalArrow = length < 18 ? defaultArrowAt(draft) : draft
      replaceItem(finalArrow)
      void publish({ type: 'whiteboard:add', item: finalArrow })
      return
    }

    if (draft.kind === 'text') {
      const finalText = draft.width < MIN_SHAPE_SIZE || draft.height < MIN_SHAPE_SIZE
        ? defaultTextAt(draft)
        : normalizeBox(draft)
      replaceItem(finalText)
      void publish({ type: 'whiteboard:add', item: finalText })
      return
    }

    const finalShape = draft.width < MIN_SHAPE_SIZE || draft.height < MIN_SHAPE_SIZE
      ? defaultShapeAt(draft)
      : normalizeBox(draft)
    replaceItem(finalShape)
    void publish({ type: 'whiteboard:add', item: finalShape })
  }

  const clear = (): void => {
    setItems([])
    void publish({ type: 'whiteboard:clear' })
  }

  const exportPng = async (): Promise<void> => {
    const svg = svgRef.current
    if (!svg || exporting) return
    setExporting(true)
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(BOARD_WIDTH * 2))
      clone.setAttribute('height', String(BOARD_HEIGHT * 2))
      clone.setAttribute('viewBox', `0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`)
      const svgSource = new XMLSerializer().serializeToString(clone)
      const url = URL.createObjectURL(new Blob([svgSource], { type: 'image/svg+xml;charset=utf-8' }))
      try {
        const image = new Image()
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('Не удалось отрисовать доску в PNG.'))
          image.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = BOARD_WIDTH * 2
        canvas.height = BOARD_HEIGHT * 2
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas недоступен.')
        context.fillStyle = '#f7f8fa'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const dataUrl = await blobToDataUrl(await canvasToBlob(canvas))
        const filename = exportFilename()
        if (window.alephDesktop?.saveDataUrl) {
          await window.alephDesktop.saveDataUrl(dataUrl, filename)
        } else {
          const link = document.createElement('a')
          link.href = dataUrl
          link.download = filename
          link.click()
        }
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось экспортировать доску.')
    } finally {
      setExporting(false)
    }
  }

  const nonTextItems = items.filter((item): item is Exclude<WhiteboardItem, WhiteboardText> => item.kind !== 'text')
  const textItems = items.filter((item): item is WhiteboardText => item.kind === 'text')

  return (
    <section className="meeting-whiteboard">
      <header>
        <div>
          <strong>Интерактивная доска</strong>
          <small>Колесо мыши масштабирует, Shift + перетаскивание двигает доску. Текст редактируется двойным кликом.</small>
        </div>
        <button type="button" onClick={onClose} title="Закрыть доску"><X size={18} /></button>
      </header>
      <div className="whiteboard-toolbar">
        <button type="button" className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}><MousePointer2 size={17} />Переместить</button>
        <button type="button" className={tool === 'pen' ? 'active' : ''} onClick={() => setTool('pen')}><Paintbrush size={17} />Перо</button>
        <button type="button" className={tool === 'eraser' ? 'active' : ''} onClick={() => setTool('eraser')}><Eraser size={17} />Ластик</button>
        <button type="button" className={tool === 'text' ? 'active' : ''} onClick={() => setTool('text')}><Type size={17} />Текст</button>
        <button type="button" className={tool === 'arrow' ? 'active' : ''} onClick={() => setTool('arrow')}><ArrowRight size={17} />Стрелка</button>
        <button type="button" className={tool === 'process' ? 'active' : ''} onClick={() => setTool('process')}><Square size={17} />Процесс</button>
        <button type="button" className={tool === 'decision' ? 'active' : ''} onClick={() => setTool('decision')}><GitBranch size={17} />Решение</button>
        <button type="button" className={tool === 'terminator' ? 'active' : ''} onClick={() => setTool('terminator')}><Circle size={17} />Старт</button>
        <label>
          <span>Цвет</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </label>
        <div className="whiteboard-zoom">
          <button type="button" onClick={() => zoomFromCenter(1.2)} title="Уменьшить"><ZoomOut size={16} /></button>
          <strong>{zoomPercent}%</strong>
          <button type="button" onClick={() => zoomFromCenter(0.82)} title="Увеличить"><ZoomIn size={16} /></button>
          <button type="button" onClick={() => setViewBox(INITIAL_VIEW_BOX)} title="Сбросить масштаб"><RotateCcw size={16} /></button>
        </div>
        <button type="button" onClick={() => void exportPng()} disabled={exporting}><Download size={17} />{exporting ? 'Экспорт...' : 'PNG'}</button>
        <button type="button" className="danger" onClick={clear} disabled={!items.length}><Trash2 size={17} />Очистить</button>
      </div>
      <svg
        ref={svgRef}
        className={`whiteboard-canvas ${tool}`}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        onContextMenu={(event) => event.preventDefault()}
        onDoubleClick={(event) => editTextAt(clientPoint(event.clientX, event.clientY))}
        onWheel={(event) => {
          event.preventDefault()
          zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 1.12 : 0.88)
        }}
        onPointerDown={beginDraft}
        onPointerMove={continueDraft}
        onPointerUp={finishDraft}
        onPointerCancel={finishDraft}
      >
        <defs>
          <pattern id="whiteboard-grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} fill="none" stroke="#e0e7ef" strokeWidth="1" />
          </pattern>
          <pattern id="whiteboard-grid-large" width={GRID_SIZE * 4} height={GRID_SIZE * 4} patternUnits="userSpaceOnUse">
            <rect width={GRID_SIZE * 4} height={GRID_SIZE * 4} fill="url(#whiteboard-grid)" />
            <path d={`M ${GRID_SIZE * 4} 0 L 0 0 0 ${GRID_SIZE * 4}`} fill="none" stroke="#c9d4e1" strokeWidth="1.4" />
          </pattern>
        </defs>
        <rect className="whiteboard-background" width={BOARD_WIDTH} height={BOARD_HEIGHT} rx="18" fill="#f7f8fa" />
        <rect className="whiteboard-grid-fill" width={BOARD_WIDTH} height={BOARD_HEIGHT} rx="18" fill="url(#whiteboard-grid-large)" />
        <g>{nonTextItems.map(renderNonTextItem)}</g>
        <g>{textItems.map(renderTextItem)}</g>
      </svg>
      {editingText ? (
        <div className="whiteboard-text-editor">
          <strong>Изменить текст</strong>
          <textarea
            autoFocus
            value={editingText.value}
            onChange={(event) => setEditingText({ ...editingText, value: event.target.value })}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') saveTextEditor()
              if (event.key === 'Escape') setEditingText(null)
            }}
          />
          <div>
            <button type="button" onClick={() => setEditingText(null)}>Отмена</button>
            <button type="button" className="primary" onClick={saveTextEditor} disabled={!editingText.value.trim()}>Сохранить</button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
