import { useEffect, useState } from 'react'

/* ---------- mando (Gamepad API · layout estándar) ---------- */
// Los índices del "standard mapping" no cambian entre marcas: un Xbox, un DualSense
// o un Switch con adaptador reportan la misma numeración. Solo cambia el rótulo.

export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
}

// rótulo de cada botón: [ Xbox · PlayStation · Switch ]
export const LABEL = {
  [BTN.A]: ['A', '✕', 'A'],
  [BTN.B]: ['B', '◯', 'B'],
  [BTN.X]: ['X', '□', 'X'],
  [BTN.Y]: ['Y', '△', 'Y'],
  [BTN.LB]: ['LB', 'L1', 'L'],
  [BTN.RB]: ['RB', 'R1', 'R'],
  [BTN.LT]: ['LT', 'L2', 'ZL'],
  [BTN.RT]: ['RT', 'R2', 'ZR'],
  [BTN.VIEW]: ['View', 'Share', '–'],
  [BTN.MENU]: ['Menu', 'Options', '+'],
  [BTN.L3]: ['L3', 'L3', 'L3'],
  [BTN.R3]: ['R3', 'R3', 'R3'],
  [BTN.UP]: ['↑', '↑', '↑'],
  [BTN.DOWN]: ['↓', '↓', '↓'],
  [BTN.LEFT]: ['←', '←', '←'],
  [BTN.RIGHT]: ['→', '→', '→'],
  [BTN.HOME]: ['Xbox', 'PS', 'Home'],
}

const DEAD = 0.2 // zona muerta de los sticks analógicos

// Estado vivo que lee useFrame cada cuadro. Vive fuera de React a propósito:
// reconciliar 60 veces por segundo solo para leer un joystick sería tirar CPU.
export const pad = {
  connected: false,
  id: '',
  index: -1,
  mapping: '',
  buttons: [],
  axes: [],
  moveX: 0, // stick izquierdo / d-pad, -1..1 (X derecha, Y adelante)
  moveY: 0,
  lookX: 0, // stick derecho, -1..1
  lookY: 0,
  throttle: 0, // RT menos LT, -1..1
  handbrake: false,
  run: false,
  use: false, // flanco de subida, se consume en el frame
  cam: false,
}

const held = (i) => {
  const b = pad.buttons[i]
  if (!b) return false
  return b.pressed ?? b.value > 0.5
}
const value = (i) => pad.buttons[i]?.value ?? (held(i) ? 1 : 0)

let prev = []
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD))

function poll() {
  const list = navigator.getGamepads?.() || []
  let gp = null
  for (const p of list) {
    if (!p) continue
    if (p.mapping === 'standard') {
      gp = p
      break
    }
    gp ??= p // sin layout estándar solo valen los botones 0-3 y el primer stick
  }

  if (gp) {
    pad.connected = true
    pad.id = gp.id
    pad.index = gp.index
    pad.mapping = gp.mapping || 'sin layout'
    pad.buttons = gp.buttons
    pad.axes = gp.axes
  } else if (pad.connected) {
    pad.connected = false
    pad.id = ''
    pad.index = -1
    pad.mapping = ''
    pad.buttons = []
    pad.axes = []
  }

  const ax = (i) => dz(pad.axes[i] ?? 0)
  const stickX = ax(0)
  const stickY = ax(1)
  pad.moveX = stickX
  pad.moveY = -stickY // en el stick, Y positivo es hacia abajo
  pad.lookX = ax(2)
  pad.lookY = ax(3)

  // el d-pad pisa el stick izquierdo
  if (held(BTN.UP)) pad.moveY = 1
  if (held(BTN.DOWN)) pad.moveY = -1
  if (held(BTN.LEFT)) pad.moveX = -1
  if (held(BTN.RIGHT)) pad.moveX = 1

  pad.throttle = Math.min(1, Math.max(-1, value(BTN.RT) - value(BTN.LT)))
  pad.handbrake = held(BTN.B)
  // solo el stick al tope hace correr: el d-pad es digital y siempre va a tope
  pad.run = held(BTN.LB) || Math.hypot(stickX, stickY) > 0.92
  pad.use = held(BTN.A) && !prev[BTN.A]
  pad.cam = (held(BTN.Y) && !prev[BTN.Y]) || (held(BTN.R3) && !prev[BTN.R3])

  prev = pad.buttons.map(held)
}

const snapshot = () => ({
  connected: pad.connected,
  id: pad.id,
  mapping: pad.mapping,
  buttons: pad.buttons.map((b) => b.value ?? (b.pressed ? 1 : 0)),
  axes: pad.axes.map((a) => Math.round(a * 50) / 50),
})

// firma para no re-renderizar si no cambió nada visible
const signature = () => {
  let s = pad.connected ? '1' : '0'
  for (const b of pad.buttons) s += b.pressed ? '1' : '0'
  for (const a of pad.axes) s += Math.round(a * 50)
  return s
}

const subs = new Set()
let raf = 0
let running = false
let lastSig = ''

function loop() {
  poll()
  const sig = signature()
  if (sig !== lastSig) {
    lastSig = sig
    for (const fn of subs) fn()
  }
  raf = requestAnimationFrame(loop)
}

// Arranca el sondeo y devuelve el estado para el visualizador. Debe vivir en un
// componente siempre montado (App): si nadie lo llama, el mando deja de leerse.
export function useGamepad() {
  const [state, setState] = useState(snapshot)
  useEffect(() => {
    const push = () => setState(snapshot())
    subs.add(push)
    if (!running) {
      running = true
      raf = requestAnimationFrame(loop)
    }
    push()
    return () => {
      subs.delete(push)
      if (!subs.size) {
        cancelAnimationFrame(raf)
        running = false
        pad.connected = false
        prev = []
      }
    }
  }, [])
  return state
}