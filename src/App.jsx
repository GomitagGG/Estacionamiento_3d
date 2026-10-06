import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { pad, useGamepad } from './gamepad.js'
import PadOverlay from './PadOverlay.jsx'

// Subsuelo -2: garaje de hormigón, entrada recta al mismo nivel que la calle
const ROOM_W = 40
const ROOM_D = 30
const CEIL_H = 4.3 // techo alto: cabe el auto y la cámara externa
const WALL_H = CEIL_H + 0.5 // alto del muro sobre el piso
const GROUND = 0 // la calle está al mismo nivel que el garaje (sin rampa)
const EYE = 1.65
const RAMP_L = 24
const RAMP_W = 6

const SLOT_W = 2.7
const SLOT_L = 5
const N = 12
const DIVS = Array.from({ length: N + 1 }, (_, k) => (k - N / 2) * SLOT_W)
const CENTERS = Array.from({ length: N }, (_, k) => (k - N / 2 + 0.5) * SLOT_W)
// dir = hacia dónde mira el frente del auto (estacionado de frente)
const ROWS = [
  { id: 'A', z: 12.5, dir: 1 },
  { id: 'B', z: 2.5, dir: -1 },
  { id: 'C', z: -2.5, dir: 1 },
  { id: 'D', z: -12.5, dir: -1 },
]
const AISLES = [-7.5, 7.5]

const C = {
  concrete: '#6b7280',
  concreteDark: '#4b5160',
  floor: '#3d4352',
  yellow: '#eab308',
  white: '#e2e8f0',
}

const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647

const PAINT = ['#e11d48', '#94a3b8', '#facc15', '#0ea5e9', '#22c55e', '#f97316', '#a855f7', '#e2e8f0']
// ocupación viva: cada auto es un objeto mutable y los espacios se calculan según dónde está cada auto
const SLOT_DATA = (() => {
  const r = rng(5)
  return ROWS.map((row) => ({
    id: row.id,
    slots: CENTERS.map((x) => {
      const occupied = r() < 0.5
      return { x, occupied, by: null, color: occupied ? PAINT[Math.floor(r() * PAINT.length)] : null }
    }),
  }))
})()
// h = rumbo del auto: su frente apunta a (sin h, cos h)
const CARS = ROWS.flatMap((row, ri) =>
  SLOT_DATA[ri].slots.flatMap((sl, i) => {
    if (!sl.occupied) return []
    const id = `${row.id}${i + 1}`
    sl.by = id
    return [{ id, x: sl.x, z: row.z, h: row.dir < 0 ? Math.PI : 0, v: 0, color: sl.color, driven: false }]
  }),
)
const TOTAL_SLOTS = N * ROWS.length
const freeCount = () => SLOT_DATA.reduce((a, r) => a + r.slots.filter((sl) => !sl.occupied).length, 0)
const slotLabel = (ri, i) => `${ROWS[ri].id}${i + 1}`

function slotAt(x, z) {
  for (let ri = 0; ri < ROWS.length; ri++) {
    if (Math.abs(z - ROWS[ri].z) <= SLOT_L / 2) {
      const i = Math.floor((x - DIVS[0]) / SLOT_W)
      if (i >= 0 && i < N) return [ri, i]
    }
  }
  return null
}

// puntos de muestra sobre la huella del auto (0.95 × 2.2 = medio ancho × medio largo)
const FOOT = (() => {
  const pts = []
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 8; j++) pts.push([(i / 4 - 0.5) * 1.9, (j / 8 - 0.5) * 4.4])
  return pts
})()

// recalcula qué espacios están ocupados y devuelve los avisos del auto que conduces
function updateOccupancy() {
  const next = SLOT_DATA.map(() => Array(N).fill(null))
  for (const c of CARS) {
    // se revisa toda la huella del auto (no solo su centro): atravesado = ocupa todos los espacios que toca
    const sn = Math.sin(c.h)
    const cs = Math.cos(c.h)
    const hits = new Map()
    for (const [lx, lz] of FOOT) {
      const at = slotAt(c.x + lx * cs + lz * sn, c.z - lx * sn + lz * cs)
      if (at) hits.set(at[0] * N + at[1], (hits.get(at[0] * N + at[1]) || 0) + 1)
    }
    for (const [k, n] of hits) {
      if (n < 3) continue // roce mínimo con el espacio vecino: no cuenta
      const ri = Math.floor(k / N)
      const i = k % N
      const sl = SLOT_DATA[ri].slots[i]
      // un auto en movimiento no ocupa un espacio nuevo, solo conserva el que ya tenía
      if (c.driven && Math.abs(c.v) > 1.2 && sl.by !== c.id) continue
      next[ri][i] = c.id
    }
  }
  const drivenId = CARS.find((c) => c.driven)?.id
  const events = []
  let changed = false
  SLOT_DATA.forEach((row, ri) =>
    row.slots.forEach((sl, i) => {
      const by = next[ri][i]
      if (sl.by === by) return
      const prev = sl.by
      sl.by = by
      sl.occupied = by !== null
      changed = true
      if (!by && prev && prev === drivenId) events.push(`${slotLabel(ri, i)} quedó LIBRE`)
      else if (by && by === drivenId) events.push(`Estacionaste en ${slotLabel(ri, i)}`)
    }),
  )
  return { changed, events }
}

// filas que cada pilar tiene a su lado (para resaltarlas en su pantalla)
const HERE = { '-12.5': ['D'], 0: ['B', 'C'], 12.5: ['A'] }
const PILLARS = [2, 6, 10].flatMap((k, xi) =>
  [-12.5, 0, 12.5].map((z, zi) => ({
    x: DIVS[k],
    z,
    name: `${'CBA'[zi]}${xi + 1}`,
    here: HERE[z],
  })),
)

const LIMITS = {
  minX: -ROOM_W / 2 + 0.6,
  maxX: ROOM_W / 2 - 0.6,
  minZ: -ROOM_D / 2 + 0.6,
  maxZ: ROOM_D / 2 - 0.6,
}
const OBSTACLES = [
  ...PILLARS.map(({ x, z }) => ({ x, z, hx: 0.5, hz: 0.5 })),
]
const RADIUS = 0.45

const TUBES = [-16, -5.4, 5.4, 16].flatMap((x) => [-12.5, -7.5, 0, 7.5, 12.5].map((z) => [x, z]))
const LAMPS = [-14, -5, 5, 14].flatMap((x) => [-7.5, 0, 7.5].map((z) => [x, z]))

const DOOR = { cx: 0, y0: 0.02, w: RAMP_W, h: 3.4 }
const ELEV = { cx: 5, y0: 0.02, w: 1.4, h: 2.2 } // z mundo = -5
const STAIR = { cx: -5, y0: 0.02, w: 1.3, h: 2.2 } // z mundo = +5
const WALLS = [
  { width: ROOM_W, position: [0, 0, -ROOM_D / 2], rotY: 0, holes: [] },
  { width: ROOM_W, position: [0, 0, ROOM_D / 2], rotY: Math.PI, holes: [] },
  { width: ROOM_D, position: [ROOM_W / 2, 0, 0], rotY: -Math.PI / 2, holes: [DOOR] },
  { width: ROOM_D, position: [-ROOM_W / 2, 0, 0], rotY: Math.PI / 2, holes: [ELEV, STAIR] },
]

/* ---------- texturas procedurales (sin archivos externos, sin costuras) ---------- */

const hash2 = (x, y, s) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 144665)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
function vnoise(x, y, px, py, s) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const w = (i, p) => ((i % p) + p) % p
  const a = hash2(w(xi, px), w(yi, py), s)
  const b = hash2(w(xi + 1, px), w(yi, py), s)
  const c = hash2(w(xi, px), w(yi + 1, py), s)
  const d = hash2(w(xi + 1, px), w(yi + 1, py), s)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
function fbm(u, v, px, py, s = 0, oct = 5) {
  let a = 0.5
  let t = 0
  let f = 1
  for (let i = 0; i < oct; i++) {
    t += a * vnoise(u * px * f, v * py * f, px * f, py * f, s + i * 17)
    f *= 2
    a *= 0.5
  }
  return t / (1 - 0.5 ** oct)
}
function paintCanvas(size, fn) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const img = g.createImageData(size, size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, gg, b] = fn(x / size, y / size)
      const i = (y * size + x) * 4
      img.data[i] = r
      img.data[i + 1] = gg
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
  g.putImageData(img, 0, 0)
  return c
}
const rnd = Math.random
const TEX_DEFS = {
  concrete: (u, v) => {
    let c = 0.5 + (fbm(u, v, 6, 6, 1) - 0.5) * 0.4 + (fbm(u, v, 40, 40, 5, 3) - 0.5) * 0.14 + (rnd() - 0.5) * 0.06
    if (fbm(u, v, 3, 3, 9, 3) > 0.62) c *= 0.82
    if (u % 0.5 < 0.004 || v % 0.5 < 0.004) c *= 0.6
    return [c * 232, c * 238, c * 248]
  },
  floor: (u, v) => {
    let c = 0.3 + (fbm(u, v, 6, 6, 2) - 0.5) * 0.22 + (fbm(u, v, 48, 48, 6, 2) - 0.5) * 0.08 + (rnd() - 0.5) * 0.04
    if (fbm(u, v, 4, 4, 11, 3) > 0.64) c *= 0.62
    if (u % 0.5 < 0.003 || v % 0.5 < 0.003) c *= 0.55
    return [c * 220, c * 226, c * 240]
  },
  asphalt: (u, v) => {
    const s = rnd()
    let c = 0.17 + (fbm(u, v, 8, 8, 3) - 0.5) * 0.12 + (s - 0.5) * 0.06
    if (s > 0.985) c += 0.22
    return [c * 250, c * 252, c * 262]
  },
  grass: (u, v) => {
    const n = fbm(u, v, 6, 6, 4)
    const m = fbm(u, v, 64, 64, 8, 2)
    const g = rnd()
    return [38 + n * 55 + m * 30 + g * 22, 92 + n * 70 + m * 45 + g * 34, 24 + n * 22 + g * 14]
  },
  bark: (u, v) => {
    const n = fbm(u, v, 18, 3, 5, 4)
    const c = n < 0.38 ? 0.18 : 0.3 + n * 0.55
    return [c * 160, c * 112, c * 76]
  },
  leaf: (u, v) => {
    const n = fbm(u, v, 20, 20, 7, 3)
    const c = n < 0.34 ? 0.4 : 0.62 + n * 0.5 + (rnd() - 0.5) * 0.12
    return [c * 215, c * 255, c * 190]
  },
}
const TEXCACHE = {}
function tex(name) {
  if (!TEXCACHE[name]) {
    const t = new THREE.CanvasTexture(paintCanvas(name === 'bark' || name === 'leaf' ? 256 : 512, TEX_DEFS[name]))
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    TEXCACHE[name] = t
  }
  return TEXCACHE[name]
}
function tiled(name, rx, ry) {
  const t = tex(name).clone()
  t.repeat.set(rx, ry)
  t.needsUpdate = true
  return t
}
const ENV = { tex: null }

/* ---------- utilidades ---------- */

function Label({ text, size, bg, fg = '#e2e8f0', res = 256, ...props }) {
  const map = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = res
    c.height = Math.round((res * size[1]) / size[0])
    const g = c.getContext('2d')
    if (bg) {
      g.fillStyle = bg
      g.fillRect(0, 0, c.width, c.height)
    }
    g.fillStyle = fg
    g.font = `bold ${c.height * 0.7}px system-ui, sans-serif`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, c.width / 2, c.height / 2 + c.height * 0.04)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [text, bg, fg, res, size[0], size[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <mesh {...props}>
      <planeGeometry args={size} />
      <meshBasicMaterial map={map} transparent toneMapped={!bg} color={bg ? '#fff' : '#9aa3b2'} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} depthWrite={false} />
    </mesh>
  )
}

function Instances({ items, children }) {
  const ref = useRef()
  useLayoutEffect(() => {
    const o = new THREE.Object3D()
    items.forEach((it, i) => {
      o.position.set(...it.p)
      o.scale.set(...it.s)
      o.rotation.set(0, it.r || 0, 0)
      o.updateMatrix()
      ref.current.setMatrixAt(i, o.matrix)
      if (it.c) ref.current.setColorAt(i, it.c)
    })
    ref.current.instanceMatrix.needsUpdate = true
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true
  }, [items])
  return (
    <instancedMesh ref={ref} args={[null, null, items.length]} frustumCulled={false}>
      {children}
    </instancedMesh>
  )
}

function Box({ p, s, color, ...m }) {
  return (
    <mesh position={p}>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} roughness={0.8} {...m} />
    </mesh>
  )
}

/* ---------- pantallas LED ---------- */

const GREEN = '#22e06b'
const RED = '#ff3b3b'
const texCache = new Map()

function ledMask(g, W, H, step) {
  // rejilla oscura que simula los píxeles del LED
  g.fillStyle = 'rgba(0,0,0,0.38)'
  for (let x = 0; x < W; x += step) g.fillRect(x, 0, 1, H)
  for (let y = 0; y < H; y += step) g.fillRect(0, y, W, 1)
}

// plano visto desde arriba (x → derecha, z → abajo), calcado del garaje 3D
function drawMap(g, { cx, cy, s, rot = false, here = [], detail = false, marker = null, clip = null }) {
  if (clip) {
    g.save()
    g.beginPath()
    g.rect(clip[0], clip[1], clip[2], clip[3])
    g.clip()
  }
  const k = rot ? -1 : 1
  const X = (x) => cx + k * x * s
  const Z = (z) => cy + k * z * s
  const rect = (x, z, w, d) => g.fillRect(X(x) - (w * s) / 2, Z(z) - (d * s) / 2, w * s, d * s)
  const frame = (x, z, w, d) => g.strokeRect(X(x) - (w * s) / 2, Z(z) - (d * s) / 2, w * s, d * s)
  const line = (x1, z1, x2, z2) => {
    g.beginPath()
    g.moveTo(X(x1), Z(z1))
    g.lineTo(X(x2), Z(z2))
    g.stroke()
  }
  const text = (t, x, z, font, color, stroke) => {
    g.font = font
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    if (stroke) {
      g.lineWidth = 3
      g.strokeStyle = stroke
      g.strokeText(t, X(x), Z(z))
    }
    g.fillStyle = color
    g.fillText(t, X(x), Z(z))
  }
  const hw = ROOM_W / 2
  const hd = ROOM_D / 2
  const thin = Math.max(1, 0.12 * s)

  // calle de acceso, ascensor y escaleras
  g.fillStyle = '#2b2f38'
  rect(hw + 1.6, 0, 3.2, RAMP_W)
  g.fillStyle = '#1e3a8a'
  rect(-hw - 1.2, -5, 2.4, 2.2)
  g.fillStyle = '#14532d'
  rect(-hw - 1.2, 5, 2.4, 2.2)

  // piso
  g.fillStyle = '#1b2130'
  rect(0, 0, ROOM_W, ROOM_D)

  // espacios: verde = libre, rojo = ocupado
  ROWS.forEach((row, ri) => {
    SLOT_DATA[ri].slots.forEach((sl) => {
      g.fillStyle = sl.occupied ? 'rgba(255,59,59,0.5)' : 'rgba(34,224,107,0.5)'
      rect(sl.x, row.z, SLOT_W - 0.14, SLOT_L - 0.14)
    })
  })

  // líneas blancas de los espacios
  g.strokeStyle = '#e2e8f0'
  g.lineWidth = thin
  g.lineCap = 'butt'
  ROWS.forEach((row) => {
    DIVS.forEach((x) => line(x, row.z - SLOT_L / 2, x, row.z + SLOT_L / 2))
    line(DIVS[0], row.z - SLOT_L / 2, DIVS[N], row.z - SLOT_L / 2)
    line(DIVS[0], row.z + SLOT_L / 2, DIVS[N], row.z + SLOT_L / 2)
  })

  // topes amarillos
  g.fillStyle = C.yellow
  ROWS.forEach((row) => CENTERS.forEach((x) => rect(x, row.z + row.dir * 2.4, 1.6, 0.2)))

  // autos en vivo (misma posición, giro y color que en el 3D)
  CARS.forEach((c) => {
    g.save()
    g.translate(X(c.x), Z(c.z))
    g.rotate(k > 0 ? -c.h : Math.PI - c.h)
    const r = (x, y, w, h) => g.fillRect((x - w / 2) * s, (y - h / 2) * s, w * s, h * s)
    g.fillStyle = c.color
    r(0, 0, 1.9, 4.4)
    g.fillStyle = 'rgba(0,0,0,0.28)'
    r(0, -0.15, 1.5, 1.8)
    g.fillStyle = '#0d1424'
    r(0, 1.15, 1.5, 0.55)
    r(0, -1.5, 1.4, 0.45)
    g.fillStyle = '#f8fafc'
    r(0, 2.15, 1.5, 0.12)
    g.fillStyle = '#ef4444'
    r(0, -2.15, 1.5, 0.12)
    if (c.driven) {
      g.strokeStyle = '#facc15'
      g.lineWidth = 2
      g.strokeRect(-1.1 * s, -2.4 * s, 2.2 * s, 4.8 * s)
    }
    g.restore()
  })

  // líneas amarillas de los pasillos
  g.strokeStyle = C.yellow
  g.lineWidth = thin
  g.setLineDash([0.8 * s, 0.8 * s])
  AISLES.forEach((z) => line(-17.6, z, 18.4, z))
  g.setLineDash([])

  // pilares
  PILLARS.forEach((p) => {
    g.fillStyle = C.yellow
    rect(p.x, p.z, 0.95, 0.95)
    g.fillStyle = C.concrete
    rect(p.x, p.z, 0.75, 0.75)
  })

  // muros
  g.strokeStyle = '#94a3b8'
  g.lineWidth = Math.max(2, 0.4 * s)
  g.lineCap = 'square'
  line(-hw, -hd, hw, -hd)
  line(-hw, hd, hw, hd)
  line(hw, -hd, hw, -RAMP_W / 2)
  line(hw, RAMP_W / 2, hw, hd)
  line(-hw, -hd, -hw, -6.1)
  line(-hw, -3.9, -hw, 3.9)
  line(-hw, 6.1, -hw, hd)
  g.lineWidth = Math.max(1, 0.2 * s)
  frame(-hw - 1.2, -5, 2.4, 2.2)
  frame(-hw - 1.2, 5, 2.4, 2.2)
  // barrera de la entrada
  g.strokeStyle = '#dc2626'
  g.lineWidth = Math.max(2, 0.3 * s)
  line(hw + 0.35, -RAMP_W / 2, hw + 0.35, RAMP_W / 2)

  // fila donde está el pilar
  g.strokeStyle = '#facc15'
  g.lineWidth = 2
  ROWS.forEach((row) => {
    if (here.includes(row.id)) frame(0, row.z, SLOT_W * N + 0.5, SLOT_L + 0.5)
  })

  // letras de fila
  ROWS.forEach((row) => {
    const mine = here.includes(row.id)
    text(row.id, -18.3, row.z, `bold ${Math.round(2 * s)}px system-ui, sans-serif`, mine ? '#facc15' : '#e2e8f0')
  })

  if (detail) {
    ROWS.forEach((row, ri) =>
      SLOT_DATA[ri].slots.forEach((sl, i) =>
        text(`${row.id}${i + 1}`, sl.x, row.z, 'bold 15px system-ui, sans-serif', '#ffffff', '#000000'),
      ),
    )
    g.setLineDash([])
    text('→', -8, 8.9, 'bold 26px system-ui, sans-serif', '#e2e8f0')
    text('→', 8, 8.9, 'bold 26px system-ui, sans-serif', '#e2e8f0')
    text('←', -8, -8.9, 'bold 26px system-ui, sans-serif', '#e2e8f0')
    text('←', 8, -8.9, 'bold 26px system-ui, sans-serif', '#e2e8f0')
    text('ASC', -hw - 1.2, -5, 'bold 15px system-ui, sans-serif', '#bfdbfe')
    text('ESC', -hw - 1.2, 5, 'bold 15px system-ui, sans-serif', '#bbf7d0')
    text('SALIDA', hw + 1.9, 0, 'bold 13px system-ui, sans-serif', '#bbf7d0')
  }

  if (marker) {
    g.strokeStyle = '#facc15'
    g.lineWidth = 2
    g.beginPath()
    g.arc(X(marker.x), Z(marker.z), 7, 0, Math.PI * 2)
    g.stroke()
    g.fillStyle = '#facc15'
    g.beginPath()
    g.arc(X(marker.x), Z(marker.z), 3, 0, Math.PI * 2)
    g.fill()
  }
  if (clip) g.restore()
}

const freeIn = (ri) => SLOT_DATA[ri].slots.filter((s) => !s.occupied).length

// panel grande: plano a la izquierda, resumen a la derecha
function drawBoard(g, W, H) {
  g.fillStyle = '#02060d'
  g.fillRect(0, 0, W, H)
  drawMap(g, { cx: 460, cy: 360, s: 20, detail: true, clip: [0, 0, 930, 720] })

  const px = 950
  g.fillStyle = '#0b1220'
  g.fillRect(936, 24, W - 940, H - 48)
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillStyle = '#38bdf8'
  g.font = 'bold 46px system-ui, sans-serif'
  g.fillText('SUBSUELO -2', px, 70)
  g.fillStyle = '#94a3b8'
  g.font = '20px system-ui, sans-serif'
  g.fillText('PLANO DE OCUPACIÓN', px, 108)
  g.fillStyle = '#e2e8f0'
  g.font = 'bold 24px system-ui, sans-serif'
  g.fillText('LIBRES', px, 168)
  g.fillStyle = freeCount() > 0 ? GREEN : RED
  g.font = 'bold 140px system-ui, sans-serif'
  g.fillText(String(freeCount()), px, 260)
  g.fillStyle = '#94a3b8'
  g.font = '24px system-ui, sans-serif'
  g.fillText(`de ${TOTAL_SLOTS} espacios`, px, 346)
  g.fillStyle = RED
  g.font = 'bold 28px system-ui, sans-serif'
  g.fillText(`OCUPADOS  ${TOTAL_SLOTS - freeCount()}`, px, 396)

  SLOT_DATA.forEach((row, ri) => {
    const y = 452 + ri * 42
    const f = freeIn(ri)
    g.fillStyle = '#e2e8f0'
    g.font = 'bold 28px system-ui, sans-serif'
    g.fillText(row.id, px, y)
    g.fillStyle = GREEN
    g.fillRect(px + 50, y - 10, 20, 20)
    g.font = 'bold 26px system-ui, sans-serif'
    g.fillText(String(f), px + 80, y)
    g.fillStyle = RED
    g.fillRect(px + 150, y - 10, 20, 20)
    g.fillText(String(N - f), px + 180, y)
  })

  g.font = 'bold 22px system-ui, sans-serif'
  g.fillStyle = GREEN
  g.fillRect(px, 640, 20, 20)
  g.fillText('LIBRE', px + 30, 651)
  g.fillStyle = RED
  g.fillRect(px + 140, 640, 20, 20)
  g.fillText('OCUPADO', px + 170, 651)
  ledMask(g, W, H, 4)
}

// pantalla de pilar: el mismo plano, girado para quien mira la pantalla, con "estás aquí"
function drawPillar(g, W, H, p, rot) {
  g.fillStyle = '#02060d'
  g.fillRect(0, 0, W, H)
  g.textBaseline = 'middle'
  g.textAlign = 'center'
  g.fillStyle = '#94a3b8'
  g.font = 'bold 17px system-ui, sans-serif'
  g.fillText('ESPACIOS LIBRES', W / 2, 16)
  g.fillStyle = freeCount() > 0 ? GREEN : RED
  g.font = 'bold 54px system-ui, sans-serif'
  g.fillText(String(freeCount()), W / 2 - 22, 56)
  g.fillStyle = '#94a3b8'
  g.font = '22px system-ui, sans-serif'
  g.fillText(`/ ${TOTAL_SLOTS}`, W / 2 + 50, 60)

  drawMap(g, { cx: 127, cy: 168, s: 5.4, rot, here: p.here, marker: { x: p.x, z: p.z }, clip: [0, 70, 256, 190] })

  g.fillStyle = '#facc15'
  g.font = 'bold 20px system-ui, sans-serif'
  g.fillText('● ESTÁS AQUÍ', W / 2, 272)
  g.fillStyle = '#e2e8f0'
  g.font = '16px system-ui, sans-serif'
  g.fillText(`FILA ${p.here.join(' / ')}`, W / 2, 294)
  g.font = 'bold 13px system-ui, sans-serif'
  g.textAlign = 'left'
  g.fillStyle = GREEN
  g.fillRect(52, 312, 12, 12)
  g.fillText('LIBRE', 70, 319)
  g.fillStyle = RED
  g.fillRect(132, 312, 12, 12)
  g.fillText('OCUPADO', 150, 319)
  ledMask(g, W, H, 4)
}

const liveTex = []
function getTex(key, W, H, draw, live = true) {
  if (!texCache.has(key)) {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d')
    draw(g, W, H)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    texCache.set(key, t)
    if (live) liveTex.push({ g, W, H, draw, t })
  }
  return texCache.get(key)
}

// vuelve a dibujar todas las pantallas LED con el estado actual del garaje
function refreshTextures() {
  for (const e of liveTex) {
    e.draw(e.g, e.W, e.H)
    e.t.needsUpdate = true
  }
}

const boardTex = () => getTex('board', 1280, 720, drawBoard)
const pillarTex = (p, rot) => getTex(`pillar-${p.name}-${rot}`, 256, 330, (g, W, H) => drawPillar(g, W, H, p, rot))

// el frente queda en z = 0 del grupo, el marco hacia atrás (-z)
function Led({ tex, size, depth = 0.07, ...props }) {
  return (
    <group {...props}>
      <Box p={[0, 0, -depth / 2]} s={[size[0] + 0.1, size[1] + 0.1, depth]} color="#0b0f17" roughness={0.5} metalness={0.6} />
      <mesh position={[0, 0, 0.003]}>
        <planeGeometry args={size} />
        <meshBasicMaterial map={tex} toneMapped={false} polygonOffset polygonOffsetFactor={-3} polygonOffsetUnits={-3} />
      </mesh>
    </group>
  )
}

// panel grande junto a la barrera: doble cara, sobre dos postes
const BOARD = { x: 21.3, z: -6.4, w: 6.4, h: 3.6, y: 3.1 }
function BigBoard() {
  const tex = boardTex()
  return (
    <group position={[BOARD.x, 0, BOARD.z]}>
      {[-1, 1].map((s) => (
        <Box key={s} p={[0, (BOARD.y - BOARD.h / 2) / 2, s * (BOARD.w / 2 - 0.4)]} s={[0.22, BOARD.y - BOARD.h / 2, 0.22]} color={C.concreteDark} roughness={0.7} />
      ))}
      <Led tex={tex} size={[BOARD.w, BOARD.h]} position={[0.07, BOARD.y, 0]} rotation={[0, Math.PI / 2, 0]} />
      <Led tex={tex} size={[BOARD.w, BOARD.h]} position={[-0.07, BOARD.y, 0]} rotation={[0, -Math.PI / 2, 0]} />
    </group>
  )
}

// mismo panel, pegado al muro por dentro para verlo desde el garaje
function WallBoard() {
  return <Led tex={boardTex()} size={[3.8, 2.14]} position={[ROOM_W / 2 - 0.07, 1.45, -8.8]} rotation={[0, -Math.PI / 2, 0]} />
}

/* ---------- estacionamiento ---------- */

function Line({ position, size, color = C.white }) {
  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.8} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  )
}

function Markings() {
  return (
    <group>
      {ROWS.map(({ id, z, dir }) => (
        <group key={id}>
          {DIVS.map((x) => (
            <Line key={x} position={[x, 0.01, z]} size={[0.12, SLOT_L]} />
          ))}
          {[-1, 1].map((e) => (
            <Line key={e} position={[0, 0.01, z + (e * SLOT_L) / 2]} size={[SLOT_W * N + 0.12, 0.14]} />
          ))}
          {CENTERS.map((x, i) => (
            <group key={i}>
              <Box p={[x, 0.07, z + dir * 2.4]} s={[1.6, 0.14, 0.2]} color={C.yellow} />
              <Label
                text={`${id}${i + 1}`}
                size={[1.1, 0.55]}
                position={[x, 0.012, z - dir * 1.9]}
                rotation={[-Math.PI / 2, 0, dir > 0 ? Math.PI : 0]}
              />
            </group>
          ))}
        </group>
      ))}
      {AISLES.map((z) =>
        Array.from({ length: 23 }, (_, i) => (
          <Line key={`${z}-${i}`} position={[-17.6 + i * 1.6, 0.01, z]} size={[0.8, 0.12]} color={C.yellow} />
        )),
      )}
      <Label text="→" size={[1.4, 0.7]} position={[-8, 0.012, 7.5 + 1]} rotation={[-Math.PI / 2, 0, 0]} />
      <Label text="→" size={[1.4, 0.7]} position={[8, 0.012, 7.5 + 1]} rotation={[-Math.PI / 2, 0, 0]} />
      <Label text="←" size={[1.4, 0.7]} position={[-8, 0.012, -7.5 - 1]} rotation={[-Math.PI / 2, 0, 0]} />
      <Label text="←" size={[1.4, 0.7]} position={[8, 0.012, -7.5 - 1]} rotation={[-Math.PI / 2, 0, 0]} />
    </group>
  )
}

const ext = (pts, depth, bev) => {
  const sh = new THREE.Shape()
  pts.forEach(([u, v], i) => (i ? sh.lineTo(u, v) : sh.moveTo(u, v)))
  sh.closePath()
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 6 })
  g.translate(0, 0, -depth / 2)
  g.rotateY(-Math.PI / 2) // largo del perfil -> eje z (frente = +z)
  g.computeVertexNormals()
  return g
}
const CAR_GEO = {
  body: ext([[-2.2, 0.32], [2.2, 0.32], [2.2, 0.62], [2.12, 0.78], [1.5, 0.9], [1.05, 0.97], [-1.4, 0.97], [-2.05, 0.95], [-2.2, 0.82]], 1.7, 0.05),
  glass: ext([[-1.35, 0.95], [-0.85, 1.4], [0.45, 1.42], [1.1, 0.95]], 1.46, 0.03),
  tire: new THREE.CylinderGeometry(0.33, 0.33, 0.24, 24).rotateZ(Math.PI / 2),
  rim: new THREE.CylinderGeometry(0.21, 0.21, 0.26, 16).rotateZ(Math.PI / 2),
  box: new THREE.BoxGeometry(1, 1, 1),
  torus: new THREE.TorusGeometry(0.17, 0.022, 10, 28),
}
const CM = {}
function carMats() {
  if (!CM.tire) {
    const envMap = ENV.tex
    CM.tire = new THREE.MeshStandardMaterial({ color: '#0e1013', roughness: 0.95 })
    CM.rim = new THREE.MeshStandardMaterial({ color: '#c7ccd4', metalness: 1, roughness: 0.22, envMap })
    CM.glass = new THREE.MeshStandardMaterial({ color: '#0a121c', metalness: 0.9, roughness: 0.05, envMap, envMapIntensity: 1.2 })
    CM.inner = new THREE.MeshStandardMaterial({ color: '#1b1d22', roughness: 0.9, side: THREE.BackSide })
    CM.dash = new THREE.MeshStandardMaterial({ color: '#16181d', roughness: 0.7 })
    CM.seat = new THREE.MeshStandardMaterial({ color: '#2a2d35', roughness: 0.95 })
    CM.liner = new THREE.MeshStandardMaterial({ color: '#cfc9bb', roughness: 1 })
    CM.head = new THREE.MeshStandardMaterial({ color: '#f8fafc', emissive: '#ffffff', emissiveIntensity: 1.2 })
    CM.tail = new THREE.MeshStandardMaterial({ color: '#7f1010', emissive: '#ef2222', emissiveIntensity: 1.1 })
    CM.trim = new THREE.MeshStandardMaterial({ color: '#0b0c0f', roughness: 0.6 })
  }
  return CM
}
const paintCache = {}
const paintMat = (c) =>
  (paintCache[c] ||= new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, envMap: ENV.tex, envMapIntensity: 1.1 }))
const Bx = (props) => <mesh geometry={CAR_GEO.box} {...props} />
const PLATE_L = 'BCDFGHJKLPRSTVXYZ'

function Wheel({ x, z, pivot, m }) {
  return (
    <group ref={pivot} position={[x, 0.33, z]}>
      <mesh geometry={CAR_GEO.tire} material={m.tire} />
      <mesh geometry={CAR_GEO.rim} material={m.rim} position={[Math.sign(x) * 0.015, 0, 0]} />
    </group>
  )
}

function Car({ car }) {
  const g = useRef()
  const fl = useRef()
  const fr = useRef()
  const sw = useRef()
  const m = carMats()
  const paint = useMemo(() => paintMat(car.color), [car.color])
  const plate = useMemo(() => {
    const r = rng(car.id.charCodeAt(0) * 131 + Number(car.id.slice(1)) * 17 + 3)
    const L = () => PLATE_L[Math.floor(r() * PLATE_L.length)]
    return `${L()}${L()}${L()}${L()}·${10 + Math.floor(r() * 89)}`
  }, [car.id])
  useFrame(() => {
    g.current.position.set(car.x, 0, car.z)
    g.current.rotation.y = car.h
    const st = car.steer || 0
    fl.current.rotation.y = st
    fr.current.rotation.y = st
    sw.current.rotation.z = -st * 3
  })
  return (
    <group ref={g} position={[car.x, 0, car.z]} rotation={[0, car.h, 0]}>
      <mesh geometry={CAR_GEO.body} material={paint} />
      <mesh geometry={CAR_GEO.body} material={m.inner} />
      <mesh geometry={CAR_GEO.glass} material={m.glass} />
      <Bx material={paint} position={[0, 1.45, -0.2]} scale={[1.46, 0.05, 1.3]} />
      {/* faros, calaveras, parrilla, espejos y patentes */}
      {[-0.6, 0.6].map((x) => (
        <group key={x}>
          <Bx material={m.head} position={[x, 0.7, 2.22]} scale={[0.4, 0.11, 0.06]} />
          <Bx material={m.tail} position={[x, 0.8, -2.22]} scale={[0.46, 0.1, 0.06]} />
        </group>
      ))}
      <Bx material={m.trim} position={[0, 0.52, 2.23]} scale={[0.8, 0.14, 0.05]} />
      <Bx material={m.trim} position={[0, 0.36, 2.22]} scale={[1.7, 0.09, 0.08]} />
      <Bx material={m.trim} position={[0, 0.36, -2.22]} scale={[1.7, 0.09, 0.08]} />
      {[-1, 1].map((s) => (
        <Bx key={s} material={paint} position={[s * 0.98, 1.0, 0.55]} scale={[0.12, 0.09, 0.2]} />
      ))}
      <Label text={plate} size={[0.52, 0.13]} bg="#f1f5f9" fg="#111827" res={256} position={[0, 0.5, -2.255]} rotation={[0, Math.PI, 0]} />
      <Label text={plate} size={[0.52, 0.13]} bg="#f1f5f9" fg="#111827" res={256} position={[0, 0.42, 2.255]} />
      {/* ruedas */}
      <Wheel x={0.9} z={1.45} pivot={fl} m={m} />
      <Wheel x={-0.9} z={1.45} pivot={fr} m={m} />
      <Wheel x={0.9} z={-1.4} m={m} />
      <Wheel x={-0.9} z={-1.4} m={m} />
      {/* interior: se ve desde la primera persona (volante a la izquierda) */}
      <Bx material={m.dash} position={[0, 1.02, 0.72]} scale={[1.5, 0.16, 0.36]} />
      <group position={[0.4, 1.06, 0.5]} rotation={[0.45, 0, 0]}>
        <group ref={sw}>
          <mesh geometry={CAR_GEO.torus} material={m.dash} />
          <Bx material={m.dash} scale={[0.32, 0.03, 0.02]} />
          <Bx material={m.dash} position={[0, -0.08, 0]} scale={[0.03, 0.16, 0.02]} />
        </group>
      </group>
      {[0.4, -0.4].map((x) => (
        <group key={x} position={[x, 0.66, -0.2]}>
          <Bx material={m.seat} scale={[0.5, 0.14, 0.55]} />
          <Bx material={m.seat} position={[0, 0.38, -0.3]} rotation={[-0.15, 0, 0]} scale={[0.48, 0.6, 0.12]} />
        </group>
      ))}
      <Bx material={m.seat} position={[0, 0.66, -1.0]} scale={[1.4, 0.14, 0.5]} />
      <Bx material={m.seat} position={[0, 0.95, -1.27]} scale={[1.4, 0.5, 0.12]} />
      <mesh position={[0, 1.395, -0.2]} rotation={[Math.PI / 2, 0, 0]} material={m.liner}>
        <planeGeometry args={[1.4, 1.3]} />
      </mesh>
    </group>
  )
}

function Pillar({ x, z, name, here }) {
  return (
    <group position={[x, 0, z]}>
      <Box p={[0, CEIL_H / 2, 0]} s={[0.8, CEIL_H, 0.8]} color="#fff" map={tex('concrete')} roughness={0.95} />
      <Box p={[0, 0.5, 0]} s={[0.86, 1, 0.86]} color={C.yellow} />
      <Box p={[0, 0.02, 0]} s={[1, 0.04, 1]} color={C.concreteDark} />
      {[1, -1].map((s) => (
        <Led key={s} tex={pillarTex({ x, z, name, here }, s < 0)} size={[0.66, 0.85]} position={[0, 1.72, s * 0.47]} rotation={[0, s > 0 ? 0 : Math.PI, 0]} />
      ))}
      <mesh position={[0.43, 1.35, 0.2]}>
        <cylinderGeometry args={[0.09, 0.09, 0.45, 10]} />
        <meshStandardMaterial color="#dc2626" roughness={0.4} />
      </mesh>
      {[1, -1].map((s) => (
        <Label
          key={s}
          text={name}
          size={[0.5, 0.25]}
          bg="#1e3a8a"
          position={[0, 2.55, s * 0.405]}
          rotation={[0, s > 0 ? 0 : Math.PI, 0]}
        />
      ))}
    </group>
  )
}

/* ---------- estructura ---------- */

function Wall({ width, position, rotY, holes }) {
  const geo = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(-width / 2, 0)
    s.lineTo(width / 2, 0)
    s.lineTo(width / 2, WALL_H)
    s.lineTo(-width / 2, WALL_H)
    s.closePath()
    holes.forEach(({ cx, y0, w, h }) => {
      const p = new THREE.Path()
      p.moveTo(cx - w / 2, y0)
      p.lineTo(cx - w / 2, y0 + h)
      p.lineTo(cx + w / 2, y0 + h)
      p.lineTo(cx + w / 2, y0)
      p.closePath()
      s.holes.push(p)
    })
    return new THREE.ShapeGeometry(s)
  }, [width, holes])
  const wallTex = useMemo(() => tiled('concrete', 1 / 6, 1 / 6), [])
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <mesh geometry={geo}>
        <meshStandardMaterial color="#fff" map={wallTex} bumpMap={wallTex} bumpScale={0.8} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      <Box p={[0, 0.15, 0.03]} s={[width, 0.3, 0.06]} color={C.yellow} />
      {holes.map((h) => (
        <group key={h.cx}>
          <Box p={[h.cx, h.y0 + h.h + 0.1, 0]} s={[h.w + 0.4, 0.2, 0.3]} color={C.yellow} />
          {[-1, 1].map((s) => (
            <Box key={s} p={[h.cx + (s * h.w) / 2, h.y0 + h.h / 2, 0]} s={[0.2, h.h, 0.3]} color={C.yellow} />
          ))}
        </group>
      ))}
    </group>
  )
}

function Ceiling() {
  const t = useMemo(() => tiled('concrete', ROOM_W / 6, ROOM_D / 6), [])
  return (
    <group>
      <Box p={[0, CEIL_H + 0.25, 0]} s={[ROOM_W, 0.5, ROOM_D]} color={C.concreteDark} roughness={1} />
      <mesh position={[0, CEIL_H - 0.002, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[ROOM_W - 0.02, ROOM_D - 0.02]} />
        <meshStandardMaterial color="#fff" map={t} bumpMap={t} bumpScale={0.6} roughness={1} />
      </mesh>
      {[-10.8, 0, 10.8].map((x) => (
        <Box key={x} p={[x, CEIL_H - 0.25, 0]} s={[0.6, 0.5, ROOM_D]} color={C.concrete} roughness={0.95} />
      ))}
      {[-6.2, 6.2].map((z) => (
        <Box key={z} p={[0, CEIL_H - 0.45, z]} s={[ROOM_W, 0.34, 0.6]} color="#9ca3af" roughness={0.5} metalness={0.6} />
      ))}
      {[-10, -4, 4, 10].map((z) => (
        <mesh key={z} position={[0, CEIL_H - 0.2, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.08, 0.08, ROOM_W, 8]} />
          <meshStandardMaterial color={z > 0 ? '#b91c1c' : '#6b7280'} roughness={0.6} metalness={0.5} />
        </mesh>
      ))}
      {TUBES.map(([x, z]) => (
        <group key={`${x}-${z}`} position={[x, CEIL_H - 0.2, z]}>
          <Box p={[0, 0.04, 0]} s={[1.5, 0.08, 0.3]} color={C.concreteDark} />
          <Box p={[0, -0.03, 0]} s={[1.4, 0.05, 0.2]} color="#fffbeb" emissive="#fef3c7" emissiveIntensity={3} />
        </group>
      ))}
    </group>
  )
}

const PLAYER = { x: 0, z: 7.5 }

const TREES = (() => {
  const r = rng(11)
  const out = []
  while (out.length < 130) {
    const a = r() * Math.PI * 2
    const dist = 27 + r() * 55
    const x = Math.cos(a) * dist
    const z = Math.sin(a) * dist
    if (Math.abs(z) < 5) continue
    if (Math.abs(x) < 24 && Math.abs(z) < 18) continue
    const kind = r() < 0.5 ? 0 : 1 // 0 = frondoso, 1 = conífera
    out.push({ x, z, kind, s: 0.8 + r() * 1.0, rot: r() * 6.28, hue: kind ? 0.38 + r() * 0.05 : 0.22 + r() * 0.1, l: kind ? 0.12 + r() * 0.07 : 0.2 + r() * 0.1 })
  }
  return out
})()

// Todo el mundo es caminable: muros, nichos, árboles y autos colisionan
const WORLD_OBS = [
  ...OBSTACLES,
  { x: 0, z: -ROOM_D / 2, hx: ROOM_W / 2, hz: 0.05 },
  { x: 0, z: ROOM_D / 2, hx: ROOM_W / 2, hz: 0.05 },
  { x: ROOM_W / 2, z: -9, hx: 0.05, hz: 6 }, // muro este con hueco de 6 m
  { x: ROOM_W / 2, z: 9, hx: 0.05, hz: 6 },
  { x: -ROOM_W / 2, z: -10.35, hx: 0.05, hz: 4.65 }, // muro oeste con 2 puertas
  { x: -ROOM_W / 2, z: 0.025, hx: 0.05, hz: 4.325 },
  { x: -ROOM_W / 2, z: 10.325, hx: 0.05, hz: 4.675 },
  ...[-5, 5].flatMap((c) => [
    { x: -ROOM_W / 2 - 2.4, z: c, hx: 0.05, hz: 1.1 },
    { x: -ROOM_W / 2 - 1.2, z: c - 1.1, hx: 1.2, hz: 0.05 },
    { x: -ROOM_W / 2 - 1.2, z: c + 1.1, hx: 1.2, hz: 0.05 },
  ]),
  ...TREES.map((t) => ({ x: t.x, z: t.z, hx: 0.3, hz: 0.3 })),
  { x: 21.3, z: -6.4, hx: 0.2, hz: 3.2 }, // panel LED junto a la barrera
]

// 0 = cerrada, 1 = abierta; se abre sola cuando te acercas
function useOpen(cx, cz, range) {
  const o = useRef(0)
  useFrame((_, dt) => {
    const near = Math.hypot(PLAYER.x - cx, PLAYER.z - cz) < range ? 1 : 0
    o.current += (near - o.current) * Math.min(1, dt * 4)
  })
  return o
}

function Door({ open, pos, size, dz }) {
  const ref = useRef()
  useFrame(() => {
    ref.current.position.z = pos[2] + dz * open.current
  })
  return (
    <mesh ref={ref} position={pos}>
      <boxGeometry args={size} />
      <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.3} />
    </mesh>
  )
}

function Core() {
  const ex = -ROOM_W / 2
  const eo = useOpen(ex, -5, 3.2)
  const so = useOpen(ex, 5, 3.2)
  return (
    <group>
      {[-5, 5].map((z) => (
        <mesh key={z} position={[ex - 1.21, 1.3, z]}>
          <boxGeometry args={[2.38, 2.6, 2.2]} />
          <meshStandardMaterial side={THREE.BackSide} color="#d1d5db" emissive="#e5e7eb" emissiveIntensity={0.5} />
        </mesh>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <Box key={i} p={[ex - 0.5 - i * 0.5, 0.15 * (i + 1), 5]} s={[0.5, 0.3 * (i + 1), 1.2]} color="#9ca3af" />
      ))}
      <Door open={eo} pos={[ex - 0.05, 1.1, -5.35]} size={[0.06, 2.2, 0.7]} dz={-0.7} />
      <Door open={eo} pos={[ex - 0.05, 1.1, -4.65]} size={[0.06, 2.2, 0.7]} dz={0.7} />
      <Door open={so} pos={[ex - 0.05, 1.1, 5]} size={[0.06, 2.2, 1.3]} dz={1.3} />
      <Label text="ASCENSOR" size={[2, 0.5]} bg="#1e3a8a" position={[ex + 0.1, 2.6, -5]} rotation={[0, Math.PI / 2, 0]} />
      <Label text="ESCALERAS" size={[2, 0.5]} bg="#14532d" fg="#bbf7d0" position={[ex + 0.1, 2.6, 5]} rotation={[0, Math.PI / 2, 0]} />
    </group>
  )
}

function Signs() {
  return (
    <>
      <Label text="SUBSUELO -2" size={[6, 1.2]} bg="#1e3a8a" position={[0, 1.9, -ROOM_D / 2 + 0.05]} />
      <Label text="SUBSUELO -2" size={[6, 1.2]} bg="#1e3a8a" position={[0, 1.9, ROOM_D / 2 - 0.05]} rotation={[0, Math.PI, 0]} />
      <Label
        text="SALIDA"
        size={[2.6, 0.45]}
        bg="#14532d"
        fg="#bbf7d0"
        position={[ROOM_W / 2 - 0.06, 3.85, 0]}
        rotation={[0, -Math.PI / 2, 0]}
      />
    </>
  )
}

/* ---------- exterior: rampa y calle ---------- */

function Sky() {
  const ref = useRef()
  const { camera } = useThree()
  useFrame(() => ref.current.position.copy(camera.position))
  return (
    <mesh ref={ref} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[350, 24, 16]} />
      <shaderMaterial
        side={THREE.BackSide}
        depthWrite={false}
        vertexShader="varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }"
        fragmentShader="varying float h; void main(){ vec3 a = vec3(.78,.86,.94); vec3 b = vec3(.25,.52,.86); gl_FragColor = vec4(mix(a, b, smoothstep(0., .55, h)), 1.); }"
      />
    </mesh>
  )
}

// calle de entrada: una sola superficie de asfalto continua (sin rampa ni escalones)
function Road() {
  const len = 270
  const t = useMemo(() => tiled('asphalt', len / 4, RAMP_W / 4), [])
  const dashes = useMemo(() => Array.from({ length: 44 }, (_, i) => ({ p: [50 + i * 6, 0.014, 0], s: [2.6, 0.01, 0.16] })), [])
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ROOM_W / 2 + len / 2, 0, 0]}>
        <planeGeometry args={[len, RAMP_W]} />
        <meshStandardMaterial color="#fff" map={t} bumpMap={t} bumpScale={0.5} roughness={0.92} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
      </mesh>
      {[-1, 1].map((s) => (
        <Box key={s} p={[ROOM_W / 2 + len / 2, 0.07, s * (RAMP_W / 2 + 0.15)]} s={[len, 0.14, 0.3]} color="#9ca3af" roughness={0.9} />
      ))}
      <Instances items={dashes}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#e5e7eb" roughness={0.8} />
      </Instances>
    </group>
  )
}

function mountainGeo(rad, h, seed, snowy) {
  const g = new THREE.ConeGeometry(rad, h, 44, 16, true)
  const p = g.attributes.position
  const col = new Float32Array(p.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i)
    let y = p.getY(i)
    let z = p.getZ(i)
    const t = (y + h / 2) / h
    const u = (x / rad + 1) / 2
    const v = (z / rad + 1) / 2
    const n = fbm(u, v, 5, 5, seed, 5)
    const mm = fbm(u, v, 14, 14, seed + 40, 3)
    const k = 1 + (n - 0.5) * 0.7 * (1 - t * 0.4)
    x *= k
    z *= k
    y += (mm - 0.5) * h * 0.16 * (1 - t)
    p.setXYZ(i, x, y, z)
    const snow = snowy ? t + (mm - 0.5) * 0.25 > 0.72 : t + (mm - 0.5) * 0.3 > 0.88
    if (snow) c.setRGB(0.93, 0.95, 0.98)
    else if (t < 0.3 + (mm - 0.5) * 0.15) c.setHSL(0.3, 0.32, 0.16 + n * 0.1)
    else c.setHSL(0.08, 0.08, 0.28 + n * 0.16)
    col.set([c.r, c.g, c.b], i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

const BLOB = new THREE.SphereGeometry(1, 16, 11)
const inGarage = (x, z) => Math.abs(x) < 24 && Math.abs(z) < 18

function Landscape() {
  const d = useMemo(() => {
    const r = rng(12)
    const trunks = TREES.map((t) => ({ p: [t.x, 1.1 * t.s, t.z], s: [t.s, t.s, t.s], r: t.rot }))
    const blobs = []
    const cones = []
    TREES.forEach((t) => {
      if (t.kind === 0) {
        for (let k = 0; k < 4; k++) {
          const a = r() * 6.28
          const rr = r() * 0.9 * t.s
          const sz = (1.1 + r() * 0.7) * t.s
          blobs.push({ p: [t.x + Math.cos(a) * rr, (2.9 + r() * 1.2) * t.s, t.z + Math.sin(a) * rr], s: [sz, sz * 0.85, sz], r: r() * 6.28, c: new THREE.Color().setHSL(t.hue, 0.5, t.l + (r() - 0.5) * 0.06) })
        }
      } else {
        ;[[2.2, 1.7, 1.5], [3.3, 1.3, 1.3], [4.3, 0.9, 1.1]].forEach(([y, rad, hh]) => {
          cones.push({ p: [t.x, y * t.s, t.z], s: [rad * t.s, hh * t.s, rad * t.s], r: r() * 6.28, c: new THREE.Color().setHSL(t.hue, 0.45, t.l + (r() - 0.5) * 0.04) })
        })
      }
    })
    const bushes = []
    while (bushes.length < 220) {
      const a = r() * 6.28
      const dist = 21 + r() * 55
      const x = Math.cos(a) * dist
      const z = Math.sin(a) * dist
      if (inGarage(x, z) || (x > 0 && Math.abs(z) < 4.5)) continue
      const sz = 0.5 + r() * 0.8
      bushes.push({ p: [x, sz * 0.55, z], s: [sz * 1.2, sz * 0.8, sz * 1.2], r: r() * 6.28, c: new THREE.Color().setHSL(0.22 + r() * 0.12, 0.5, 0.16 + r() * 0.1) })
    }
    const tufts = []
    while (tufts.length < 2200) {
      const a = r() * 6.28
      const dist = 20 + r() * 50
      const x = Math.cos(a) * dist
      const z = Math.sin(a) * dist
      if (inGarage(x, z) || (x > 0 && Math.abs(z) < 4.2)) continue
      const sc = 0.6 + r() * 0.9
      const sy = sc * (0.7 + r() * 0.8)
      tufts.push({ p: [x, 0.25 * sy, z], s: [sc, sy, sc], r: r() * 6, c: new THREE.Color().setHSL(0.22 + r() * 0.1, 0.5, 0.18 + r() * 0.14) })
    }
    const mountains = Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2 + r() * 0.3
      const h = 28 + r() * 30
      const dist = 120 + r() * 70
      const x = Math.cos(a) * dist
      let z = Math.sin(a) * dist
      if (x > 0 && Math.abs(z) < h * 1.1 + 8) z = (z < 0 ? -1 : 1) * (h * 1.1 + 8) // que ninguna monte cruce la calle
      return { x, z, h, geo: mountainGeo(h * 1.1, h, 3 + i * 7, false) }
    })
    mountains.push({ x: 150, z: -110, h: 100, geo: mountainGeo(70, 100, 99, true) })
    const clouds = Array.from({ length: 9 }, () => {
      const a = r() * Math.PI * 2
      const dd = 70 + r() * 150
      const cx = Math.cos(a) * dd
      const cz = Math.sin(a) * dd
      const cy = 80 + r() * 25
      return Array.from({ length: 5 }, () => ({ p: [cx + (r() - 0.5) * 30, cy + (r() - 0.5) * 4, cz + (r() - 0.5) * 16], s: [10 + r() * 8, 3 + r() * 2, 6 + r() * 4] }))
    }).flat()
    const ground = new THREE.Shape()
    ground.absarc(0, 0, 290, 0, Math.PI * 2)
    return { trunks, blobs, cones, bushes, tufts, mountains, clouds, groundGeo: new THREE.ShapeGeometry(ground) }
  }, [])
  const grass = useMemo(() => tiled('grass', 1 / 9, 1 / 9), [])
  const bark = useMemo(() => tiled('bark', 2, 2), [])
  const leaf = useMemo(() => tiled('leaf', 3, 2), [])
  const leafMat = <meshStandardMaterial color="#fff" map={leaf} bumpMap={leaf} bumpScale={1} roughness={1} />

  return (
    <group position={[0, GROUND - 0.08, 0]}>
      <Sky />
      <mesh position={[-60, 85, -110]}>
        <sphereGeometry args={[6, 16, 12]} />
        <meshBasicMaterial color="#fff7d6" fog={false} toneMapped={false} />
      </mesh>
      {d.clouds.map((c, i) => (
        <mesh key={i} position={c.p} scale={c.s}>
          <sphereGeometry args={[1, 14, 10]} />
          <meshBasicMaterial color="#fff" transparent opacity={0.8} fog={false} />
        </mesh>
      ))}
      <mesh geometry={d.groundGeo} rotation={[-Math.PI / 2, 0, 0]}>
        <meshStandardMaterial color="#fff" map={grass} bumpMap={grass} bumpScale={1} roughness={1} side={THREE.DoubleSide} />
      </mesh>
      {d.mountains.map((m, i) => (
        <mesh key={i} geometry={m.geo} position={[m.x, m.h / 2, m.z]}>
          <meshStandardMaterial vertexColors roughness={1} />
        </mesh>
      ))}
      <Instances items={d.trunks}>
        <cylinderGeometry args={[0.1, 0.2, 2.2, 8]} />
        <meshStandardMaterial color="#fff" map={bark} bumpMap={bark} bumpScale={1.5} roughness={1} />
      </Instances>
      <Instances items={d.blobs}>
        <primitive object={BLOB} attach="geometry" />
        {leafMat}
      </Instances>
      <Instances items={d.cones}>
        <coneGeometry args={[1, 1.6, 10, 2]} />
        {leafMat}
      </Instances>
      <Instances items={d.bushes}>
        <primitive object={BLOB} attach="geometry" />
        {leafMat}
      </Instances>
      <Instances items={d.tufts}>
        <coneGeometry args={[0.09, 0.5, 4]} />
        <meshStandardMaterial color="#fff" roughness={1} />
      </Instances>
    </group>
  )
}

function BoomGate() {
  const armLen = RAMP_W + 0.7
  const seg = armLen / 6
  const o = useOpen(ROOM_W / 2 + 0.35, 0, 6)
  const arm = useRef()
  useFrame(() => {
    arm.current.rotation.x = -1.22 * o.current
  })
  return (
    <group position={[ROOM_W / 2 + 0.35, GROUND, 0]}>
      <group position={[0, 0, -(RAMP_W / 2 + 0.35)]}>
        <Box p={[0, 0.08, 0]} s={[0.62, 0.16, 0.62]} color={C.concreteDark} />
        <Box p={[0, 0.64, 0]} s={[0.44, 1.1, 0.44]} color={C.yellow} />
        <Box p={[0, 1.22, 0]} s={[0.48, 0.12, 0.48]} color="#1f2937" />
        <Box p={[0, 0.5, 0.23]} s={[0.26, 0.7, 0.02]} color="#1f2937" />
        <Label text="TARJETA" size={[0.3, 0.12]} bg="#1e3a8a" position={[0, 1.22, 0.26]} />
        <mesh position={[0, 1.36, 0]}>
          <sphereGeometry args={[0.06, 10, 8]} />
          <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={2} />
        </mesh>
        <group ref={arm} position={[0, 1.06, 0.12]}>
          <Box p={[0, 0, -0.12]} s={[0.16, 0.16, 0.3]} color="#1f2937" />
          {Array.from({ length: 6 }, (_, i) => (
            <Box
              key={i}
              p={[0, 0, seg * (i + 0.5)]}
              s={[0.1, 0.14, seg]}
              color={i % 2 ? '#f8fafc' : '#dc2626'}
            />
          ))}
          <Box p={[0, 0, armLen + 0.1]} s={[0.1, 0.16, 0.24]} color="#f8fafc" />
        </group>
      </group>
      {[1, -1].map((s) => (
        <mesh key={s} position={[1.6, 0.45, (s * RAMP_W) / 2]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.09, 0.09, 0.9, 12]} />
          <meshStandardMaterial color="#dc2626" emissive="#ef4444" emissiveIntensity={0.4} />
        </mesh>
      ))}
    </group>
  )
}

/* ---------- señalética ---------- */

const SIGN_DRAW = {
  speed: (g, W, H) => {
    g.clearRect(0, 0, W, H)
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.arc(W / 2, H / 2, W * 0.48, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = '#dc2626'
    g.lineWidth = W * 0.1
    g.beginPath()
    g.arc(W / 2, H / 2, W * 0.43, 0, Math.PI * 2)
    g.stroke()
    g.fillStyle = '#111827'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `bold ${W * 0.36}px system-ui, sans-serif`
    g.fillText('10', W / 2, H / 2 - H * 0.03)
    g.font = `bold ${W * 0.1}px system-ui, sans-serif`
    g.fillText('km/h', W / 2, H / 2 + H * 0.24)
  },
  stop: (g, W, H) => {
    g.clearRect(0, 0, W, H)
    const oct = (r) => {
      g.beginPath()
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + (i * Math.PI) / 4
        const x = W / 2 + Math.cos(a) * r
        const y = H / 2 + Math.sin(a) * r
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      }
      g.closePath()
    }
    g.fillStyle = '#ffffff'
    oct(W * 0.5)
    g.fill()
    g.fillStyle = '#dc2626'
    oct(W * 0.45)
    g.fill()
    g.fillStyle = '#ffffff'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `bold ${W * 0.27}px system-ui, sans-serif`
    g.fillText('PARE', W / 2, H / 2 + H * 0.02)
  },
}

// señal redonda u octogonal; el frente mira a +z del grupo
function Plate({ kind, size = 0.7, ...props }) {
  const tex = getTex(`sign-${kind}`, 256, 256, SIGN_DRAW[kind], false)
  return (
    <group {...props}>
      <mesh position={[0, 0, 0.012]}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial map={tex} transparent alphaTest={0.4} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.004]} rotation={[0, Math.PI, 0]}>
        <circleGeometry args={[(size / 2) * 0.97, kind === 'stop' ? 8 : 40]} />
        <meshStandardMaterial color="#6b7280" roughness={0.8} />
      </mesh>
    </group>
  )
}

function PoleSign({ kind, position, rotY, size = 0.75 }) {
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <Box p={[0, 1.15, 0]} s={[0.07, 2.3, 0.07]} color="#374151" />
      <Plate kind={kind} size={size} position={[0, 2.0, 0.06]} />
    </group>
  )
}

// letrero colgante: solo se lee desde su frente (+z del grupo); por detrás es una placa oscura
function Hang({ x, z, rotY, text, bg, fg, back, backBg, w = 3.2, h = 0.56, y = CEIL_H - 1.15, ceil = CEIL_H }) {
  const chain = ceil - y - h / 2
  return (
    <group position={[x, y, z]} rotation={[0, rotY, 0]}>
      <Box p={[0, 0, 0]} s={[w + 0.1, h + 0.1, 0.05]} color="#111827" />
      <Label text={text} size={[w, h]} bg={bg} fg={fg} res={768} position={[0, 0, 0.031]} />
      {back && (
        <Label text={back} size={[w, h]} bg={backBg || bg} fg={fg} res={768} position={[0, 0, -0.031]} rotation={[0, Math.PI, 0]} />
      )}
      {[-1, 1].map((sg) => (
        <Box key={sg} p={[sg * (w / 2 - 0.2), h / 2 + chain / 2, 0]} s={[0.03, chain, 0.03]} color="#6b7280" />
      ))}
    </group>
  )
}

function Signage() {
  const G = { bg: '#14532d', fg: '#bbf7d0' }
  const B = { bg: '#1e3a8a', fg: '#e2e8f0' }
  const W = -Math.PI / 2 // mira al oeste (lo leen quienes van hacia el este)
  const E = Math.PI / 2 // mira al este (lo leen quienes van hacia el oeste)
  return (
    <>
      {/* dentro del garaje */}
      <Hang x={14.5} z={7.5} rotY={W} text="SALIDA ←" {...G} />
      <Hang x={-3.5} z={7.5} rotY={W} text="SALIDA ↑" {...G} />
      <Hang x={-9} z={-7.5} rotY={E} text="ASCENSOR ↑" {...B} />
      <Hang x={-13.5} z={-7.5} rotY={E} text="ESCALERAS ↑" {...G} />
      <Hang x={18.6} z={0} rotY={E} text="PARKING ↑" {...B} />
      <Plate kind="speed" size={0.75} position={[ROOM_W / 2 - 0.03, 1.7, -4.7]} rotation={[0, W, 0]} />
      <PoleSign kind="stop" position={[19.3, 0, 3.7]} rotY={W} />
      <Line position={[18.4, 0.011, 0]} size={[0.35, 6]} />
      <Label text="PARE" size={[1.6, 0.6]} position={[17.3, 0.012, 1.5]} rotation={[-Math.PI / 2, 0, -Math.PI / 2]} />

      {/* en la calle, junto a la barrera */}
      <PoleSign kind="stop" position={[23.4, 0, -3.8]} rotY={E} />
      <PoleSign kind="speed" position={[28, 0, -3.8]} rotY={E} />
      <group position={[33, 0, 0]}>
        {[-1, 1].map((sg) => (
          <Box key={sg} p={[0, 2.15, sg * 4.2]} s={[0.3, 4.3, 0.3]} color="#374151" />
        ))}
        <Box p={[0, 4.3, 0]} s={[0.3, 0.3, 8.7]} color="#374151" />
      </group>
      <Hang x={33} z={0} rotY={E} y={3.55} ceil={4.15} w={4.4} h={0.7} text="ENTRADA" {...G} back="HASTA PRONTO" backBg="#1e3a8a" />
    </>
  )
}

/* ---------- jugador y conducción ---------- */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const CAR_HX = 0.95
const CAR_HZ = 2.2
const camGoal = new THREE.Vector3()

// empuja un círculo fuera de muros, pilares, árboles y autos estacionados
function resolve(x, z, radius = RADIUS, skip = null) {
  let nx = x
  let nz = z
  const d = Math.hypot(nx, nz)
  if (d > 60) {
    nx *= 60 / d
    nz *= 60 / d
  }
  const push = (o) => {
    const dx = nx - o.x
    const dz = nz - o.z
    const ox = o.hx + radius - Math.abs(dx)
    const oz = o.hz + radius - Math.abs(dz)
    if (ox > 0 && oz > 0) {
      if (ox < oz) nx = o.x + Math.sign(dx || 1) * (o.hx + radius)
      else nz = o.z + Math.sign(dz || 1) * (o.hz + radius)
    }
  }
  for (const o of WORLD_OBS) push(o)
  for (const c of CARS) {
    if (c === skip) continue
    const sn = Math.abs(Math.sin(c.h))
    const cs = Math.abs(Math.cos(c.h))
    push({ x: c.x, z: c.z, hx: sn * CAR_HZ + cs * CAR_HX + 0.1, hz: cs * CAR_HZ + sn * CAR_HX + 0.15 })
  }
  return [nx, nz]
}

// distancia de un punto al borde del auto
function carGap(c, x, z) {
  const dx = x - c.x
  const dz = z - c.z
  const lz = dx * Math.sin(c.h) + dz * Math.cos(c.h)
  const lx = -dx * Math.cos(c.h) + dz * Math.sin(c.h)
  return Math.hypot(Math.max(Math.abs(lx) - CAR_HX, 0), Math.max(Math.abs(lz) - CAR_HZ, 0))
}

function Player({ onLockChange, onHud }) {
  const { camera, gl } = useThree()
  const keys = useRef(new Set())
  const pos = useRef(new THREE.Vector3(0, EYE, 7.5))
  const vel = useRef(new THREE.Vector3())
  const look = useRef({ yaw: -Math.PI / 2, pitch: 0 })
  const bob = useRef(0)
  const act = useRef({ use: false, cam: false })
  const D = useRef({
    car: null,
    cam: 1,
    steer: 0,
    snap: false,
    outside: false,
    off: { yaw: 0, pitch: 0 },
    toast: '',
    toastT: 0,
    mapT: 0,
    dirty: false,
    hud: '',
  })

  useEffect(() => {
    const canvas = gl.domElement
    const handleLock = () => onLockChange(document.pointerLockElement === canvas)
    const onMouseMove = (e) => {
      if (document.pointerLockElement !== canvas) return
      const d = D.current
      if (d.car) {
        d.off.yaw = clamp(d.off.yaw - e.movementX * 0.0022, -2.6, 2.6)
        d.off.pitch = clamp(d.off.pitch - e.movementY * 0.0022, -0.8, 0.9)
        return
      }
      look.current.yaw -= e.movementX * 0.0022
      look.current.pitch = Math.max(-1.2, Math.min(1.2, look.current.pitch - e.movementY * 0.0022))
    }
    const onKeyDown = (e) => {
      keys.current.add(e.code)
      if (e.code === 'Space') e.preventDefault()
      if (!e.repeat && e.code === 'KeyE') act.current.use = true
      if (!e.repeat && e.code === 'KeyV') act.current.cam = true
    }
    const onKeyUp = (e) => keys.current.delete(e.code)
    const onClick = () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock()
    }
    document.addEventListener('pointerlockchange', handleLock)
    document.addEventListener('mousemove', onMouseMove)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('pointerlockchange', handleLock)
      document.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      canvas.removeEventListener('click', onClick)
    }
  }, [gl, onLockChange])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05)
    const d = D.current
    const k = keys.current
    const say = (t) => {
      d.toast = t
      d.toastT = 3.4
    }
    let prompt = ''
    let warn = ''
    let kmh = 0

    // el mando repite lo que hacen E y V, y su stick derecho mueve la cámara
    if (pad.use) {
      act.current.use = true
      pad.use = false
    }
    if (pad.cam) {
      act.current.cam = true
      pad.cam = false
    }
    if (pad.lookX || pad.lookY) {
      if (d.car) {
        d.off.yaw = clamp(d.off.yaw - pad.lookX * dt * 2.6, -2.6, 2.6)
        d.off.pitch = clamp(d.off.pitch - pad.lookY * dt * 2.6, -0.8, 0.9)
      } else {
        look.current.yaw -= pad.lookX * dt * 2.6
        look.current.pitch = Math.max(-1.2, Math.min(1.2, look.current.pitch - pad.lookY * dt * 2.6))
      }
    }

    if (!d.car) {
      /* ---- a pie ---- */
      const speed = k.has('ShiftLeft') || k.has('ShiftRight') || pad.run ? 6.5 : 3.4
      // teclado y mando se suman y luego se normalizan: el analógico conserva
      // la intensidad y solo se recorta cuando se pide más de lo que hay
      const forward =
        Number(k.has('KeyW') || k.has('ArrowUp')) -
        Number(k.has('KeyS') || k.has('ArrowDown')) +
        pad.moveY +
        pad.throttle
      const strafe =
        Number(k.has('KeyD') || k.has('ArrowRight')) -
        Number(k.has('KeyA') || k.has('ArrowLeft')) +
        pad.moveX
      const len = Math.hypot(forward, strafe)
      const norm = len > 1 ? 1 / len : 1
      const f = forward * norm
      const s = strafe * norm
      const { yaw, pitch } = look.current
      const sin = Math.sin(yaw)
      const cos = Math.cos(yaw)
      const wishX = (-sin * f + cos * s) * speed
      const wishZ = (-cos * f - sin * s) * speed
      vel.current.x += (wishX - vel.current.x) * Math.min(1, dt * 12)
      vel.current.z += (wishZ - vel.current.z) * Math.min(1, dt * 12)
      const [nx, nz] = resolve(pos.current.x + vel.current.x * dt, pos.current.z + vel.current.z * dt)
      pos.current.x = nx
      pos.current.z = nz
      const moving = Math.hypot(vel.current.x, vel.current.z)
      bob.current += dt * moving * 2.2
      PLAYER.x = nx
      PLAYER.z = nz
      camera.position.set(nx, EYE + Math.sin(bob.current) * 0.025 * Math.min(1, moving / 3), nz)
      camera.rotation.order = 'YXZ'
      camera.rotation.set(pitch, yaw, 0)

      // auto cercano para subirse
      let near = null
      let best = 1.7
      for (const c of CARS) {
        const gap = carGap(c, nx, nz)
        if (gap < best) {
          best = gap
          near = c
        }
      }
      if (near) {
        prompt = `${pad.connected ? 'A' : 'E'} · conducir el auto ${near.id}`
        if (act.current.use) {
          d.car = near
          near.driven = true
          near.v = 0
          d.steer = 0
          d.cam = 1 // siempre empiezas en primera persona
          d.snap = true
          d.off.yaw = 0
          d.off.pitch = 0
          d.outside = near.x > ROOM_W / 2 + 0.8
          prompt = ''
          say(`Conduciendo el auto ${near.id}`)
        }
      }
    } else {
      /* ---- conduciendo ---- */
      const car = d.car
      // gas y volante analógicos: el stick y los gatillos suman con el teclado
      const gas = clamp(
        Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown')) + pad.throttle,
        -1,
        1,
      )
      const wheel = clamp(
        Number(k.has('KeyA') || k.has('ArrowLeft')) -
          Number(k.has('KeyD') || k.has('ArrowRight')) -
          pad.moveX,
        -1,
        1,
      )
      let v = car.v
      if (gas > 0.02) v += (v < 0 ? 13 : 5.5) * gas * dt
      else if (gas < -0.02) v -= (v > 0.3 ? 13 : 3.8) * -gas * dt
      else v -= Math.sign(v) * Math.min(Math.abs(v), 1.8 * dt)
      if (k.has('Space') || pad.handbrake) v -= Math.sign(v) * Math.min(Math.abs(v), 16 * dt)
      v = clamp(v, -4.5, 15)
      const target = (wheel * 0.62) / (1 + Math.abs(v) * 0.09)
      d.steer += (target - d.steer) * Math.min(1, dt * 7)
      car.steer = d.steer
      car.h += (v / 2.7) * Math.tan(d.steer) * dt
      car.x += Math.sin(car.h) * v * dt
      car.z += Math.cos(car.h) * v * dt

      // colisiones: tres círculos a lo largo del auto
      let hit = false
      for (const off of [1.45, 0, -1.45]) {
        const px = car.x + Math.sin(car.h) * off
        const pz = car.z + Math.cos(car.h) * off
        const [rx, rz] = resolve(px, pz, 1.0, car)
        if (rx !== px || rz !== pz) {
          car.x += rx - px
          car.z += rz - pz
          hit = true
        }
      }
      if (hit) v *= Math.max(0, 1 - 9 * dt)
      car.v = v

      kmh = Math.round(Math.abs(v) * 3.6)
      const inside = car.x < ROOM_W / 2 && Math.abs(car.z) < ROOM_D / 2
      if (inside && kmh > 12) warn = 'Reduce la velocidad · máx. 10 km/h'
      const out = car.x > ROOM_W / 2 + 0.8
      if (out !== d.outside) {
        d.outside = out
        say(out ? 'Saliste del estacionamiento' : 'Entraste al estacionamiento')
      }
      const at = slotAt(car.x, car.z)
      if (at && kmh < 4) prompt = `Espacio ${slotLabel(at[0], at[1])} · S retroceder para salir · ${pad.connected ? 'A' : 'E'} bajar`

      PLAYER.x = car.x
      PLAYER.z = car.z
      pos.current.set(car.x, EYE, car.z)

      // cámara
      if (act.current.cam) d.cam = 1 - d.cam
      d.off.yaw *= 1 - Math.min(1, dt * 1.2)
      d.off.pitch *= 1 - Math.min(1, dt * 1.2)
      camera.rotation.order = 'YXZ'
      if (d.cam === 0) {
        const a = car.h + d.off.yaw
        const ty = clamp(2.15 - d.off.pitch * 2.2, 0.9, inside ? 3.6 : 4.2)
        camGoal.set(car.x - Math.sin(a) * 5.8, ty, car.z - Math.cos(a) * 5.8)
        if (d.snap) camera.position.copy(camGoal)
        else camera.position.lerp(camGoal, Math.min(1, dt * 7))
        camera.lookAt(car.x, 1.0, car.z)
      } else {
        const fx = Math.sin(car.h)
        const fz = Math.cos(car.h)
        camera.position.set(car.x + fz * 0.4 + fx * 0.0, 1.2, car.z - fx * 0.4 + fz * 0.0)
        camera.rotation.set(d.off.pitch, car.h + Math.PI + d.off.yaw, 0)
      }
      d.snap = false

      // bajarse por el lado del conductor
      if (act.current.use) {
        if (Math.abs(v) < 2) {
          const fx = Math.sin(car.h)
          const fz = Math.cos(car.h)
          car.driven = false
          car.v = 0
          const [ex, ez] = resolve(car.x + fz * 1.8, car.z - fx * 1.8)
          pos.current.set(ex, EYE, ez)
          vel.current.set(0, 0, 0)
          look.current.yaw = car.h + Math.PI
          look.current.pitch = 0
          d.car = null
        } else {
          say('Detén el auto para bajar')
        }
      }
    }
    act.current.use = false
    act.current.cam = false

    // ocupación y pantallas LED en vivo
    const occ = updateOccupancy()
    if (occ.changed) d.dirty = true
    if (occ.events.length) say(occ.events[occ.events.length - 1])
    if (d.car && Math.abs(d.car.v) > 0.05) d.dirty = true
    d.mapT -= dt
    if (d.dirty && d.mapT <= 0) {
      refreshTextures()
      d.dirty = false
      d.mapT = 0.12
    }

    d.toastT = Math.max(0, d.toastT - dt)
    const hud = { driving: !!d.car, kmh, prompt, warn, toast: d.toastT > 0 ? d.toast : '', cam: d.cam }
    const key = JSON.stringify(hud)
    if (key !== d.hud) {
      d.hud = key
      onHud(hud)
    }
  })
  return null
}

/* ---------- escena ---------- */

function Scene({ onLockChange, onHud }) {
  const { gl } = useThree()
  // reflejos para la pintura y los vidrios de los autos
  useMemo(() => {
    const pm = new THREE.PMREMGenerator(gl)
    ENV.tex = pm.fromScene(new RoomEnvironment(), 0.04).texture
    pm.dispose()
  }, [gl])
  const floorT = useMemo(() => tiled('floor', ROOM_W / 5, ROOM_D / 5), [])
  return (
    <>
      <color attach="background" args={['#c7dbf0']} />
      <fog attach="fog" args={['#c7dbf0', 70, 330]} />
      <ambientLight intensity={0.35} color="#cfd8ea" />
      <hemisphereLight args={['#aab6c8', '#3a3f4c', 0.45]} />
      <directionalLight position={[-60, 85, -110]} intensity={0.9} color="#fff1d6" />
      {LAMPS.map(([x, z]) => (
        <pointLight key={`${x}-${z}`} position={[x, CEIL_H - 0.7, z]} intensity={40} distance={0} decay={1.6} color="#f4f7ff" />
      ))}
      <pointLight position={[ROOM_W / 2 + 6, 2, 0]} intensity={40} distance={0} decay={1.5} color="#fff3d6" />

      <Player onLockChange={onLockChange} onHud={onHud} />
      <Landscape />
      <Road />
      <BoomGate />
      <BigBoard />
      <WallBoard />
      {WALLS.map((w, i) => (
        <Wall key={i} {...w} />
      ))}

      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[ROOM_W - 0.02, ROOM_D - 0.02]} />
        <meshStandardMaterial color="#fff" map={floorT} bumpMap={floorT} bumpScale={0.5} roughness={0.42} metalness={0.12} polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={2} />
      </mesh>

      <Ceiling />
      <Markings />
      <Signs />
      <Signage />
      <Core />
      {PILLARS.map((p) => (
        <Pillar key={p.name} {...p} />
      ))}
      {CARS.map((car) => (
        <Car key={car.id} car={car} />
      ))}
    </>
  )
}

const HUD_BASE = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  pointerEvents: 'none',
  textAlign: 'center',
  fontFamily: 'system-ui, sans-serif',
  fontWeight: 700,
  borderRadius: 10,
  padding: '10px 20px',
  background: 'rgba(2, 6, 13, 0.85)',
}

export default function App() {
  const handleLockChange = useCallback(() => {}, [])
  const [hud, setHud] = useState({ driving: false, kmh: 0, prompt: '', warn: '', toast: '', cam: 0 })
  const padState = useGamepad()

  useEffect(() => {
    const block = (e) => e.preventDefault()
    window.addEventListener('contextmenu', block)
    return () => window.removeEventListener('contextmenu', block)
  }, [])

  return (
    <div className="app">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ fov: 70, near: 0.1, far: 400 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.shadowMap.enabled = false
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 1.15
        }}
      >
        <Scene onLockChange={handleLockChange} onHud={setHud} />
      </Canvas>
      <div className="hud">
        {padState.connected ? (
          hud.driving ? (
            <>
              <span>Stick izq / D-pad girar</span>
              <span>RT acelerar · LT frenar</span>
              <span>B freno de mano</span>
              <span>Y cámara ({hud.cam ? '1ª persona' : '3ª persona'})</span>
              <span>A bajar</span>
            </>
          ) : (
            <>
              <span>Stick izq mover</span>
              <span>LB correr</span>
              <span>RT / LT adelante / atrás</span>
              <span>Stick der. mirar</span>
              <span>A conducir un auto</span>
            </>
          )
        ) : hud.driving ? (
          <>
            <span>W / S acelerar · frenar</span>
            <span>A / D girar</span>
            <span>Espacio freno de mano</span>
            <span>V cámara ({hud.cam ? '1ª persona' : '3ª persona'})</span>
            <span>E bajar</span>
          </>
        ) : (
          <>
            <span>WASD mover</span>
            <span>Shift correr</span>
            <span>E conducir un auto</span>
            <span>Clic izq: capturar mouse</span>
          </>
        )}
      </div>
      <PadOverlay state={padState} />
      {hud.toast && (
        <div style={{ ...HUD_BASE, top: 28, color: '#e2e8f0', border: '1px solid #38bdf8', fontSize: 20 }}>{hud.toast}</div>
      )}
      {hud.warn && (
        <div style={{ ...HUD_BASE, top: 84, color: '#fff', background: 'rgba(185, 28, 28, 0.9)', fontSize: 18 }}>{hud.warn}</div>
      )}
      {hud.prompt && (
        <div style={{ ...HUD_BASE, bottom: 96, color: '#facc15', fontSize: 20 }}>{hud.prompt}</div>
      )}
      {hud.driving && (
        <div
          style={{
            position: 'absolute',
            left: 24,
            bottom: 24,
            pointerEvents: 'none',
            fontFamily: 'system-ui, sans-serif',
            color: '#e2e8f0',
            background: 'rgba(2, 6, 13, 0.85)',
            borderRadius: 12,
            padding: '8px 18px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 46, fontWeight: 800, lineHeight: 1 }}>{hud.kmh}</div>
          <div style={{ fontSize: 14, color: '#94a3b8' }}>km/h</div>
        </div>
      )}
    </div>
  )
}
