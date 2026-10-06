import { BTN, LABEL } from './gamepad'

// celdas del rombo de 3×3: arriba=Y, izquierda=X, derecha=B, abajo=A
const FACE = [
  [BTN.Y, '1 / 2'],
  [BTN.X, '2 / 1'],
  [BTN.B, '2 / 3'],
  [BTN.A, '3 / 2'],
]
const DPAD = [
  [BTN.UP, '1 / 2'],
  [BTN.LEFT, '2 / 1'],
  [BTN.RIGHT, '2 / 3'],
  [BTN.DOWN, '3 / 2'],
]

const stick = (x, y, area) => (
  <div className={`pad-stick pad-${area}`} style={{ gridArea: area }}>
    <i style={{ transform: `translate(${x * 18}px, ${y * 18}px)` }} />
  </div>
)

export default function PadOverlay({ state }) {
  const { connected, id, mapping, buttons, axes } = state
  const val = (i) => buttons[i] ?? 0
  const on = (i) => val(i) > 0.5
  const key = (i) => (
    <span key={i} className={on(i) ? 'pad-key on' : 'pad-key'}>
      {LABEL[i][0]}
    </span>
  )
  const face = (i, area) => (
    <span key={i} className={on(i) ? 'pad-round on' : 'pad-round'} style={{ gridArea: area }}>
      {LABEL[i][0]}
    </span>
  )
  const trig = (i, name) => (
    <div key={i} className="pad-trg">
      <b style={{ width: `${Math.round(val(i) * 100)}%` }} />
      <span>{name}</span>
    </div>
  )

  return (
    <div className="pad">
      <div className="pad-top">
        <span className={connected ? 'pad-dot on' : 'pad-dot'} />
        <span className="pad-name">{connected ? id : 'Sin mando'}</span>
      </div>

      {connected ? (
        <>
          <div className="pad-row">
            <span className={on(BTN.LB) ? 'pad-key on' : 'pad-key'}>{LABEL[BTN.LB][0]}</span>
            <span className={on(BTN.HOME) ? 'pad-key on' : 'pad-key'}>{LABEL[BTN.HOME][0]}</span>
            <span className={on(BTN.RB) ? 'pad-key on' : 'pad-key'}>{LABEL[BTN.RB][0]}</span>
          </div>

          <div className="pad-row">
            {trig(BTN.LT, LABEL[BTN.LT][0])}
            {trig(BTN.RT, LABEL[BTN.RT][0])}
          </div>

          <div className="pad-grid">
            <div className="pad-dpad">
              {DPAD.map(([i, area]) => face(i, area))}
            </div>
            <div className="pad-mid">
              <span className={on(BTN.VIEW) ? 'pad-key on' : 'pad-key'}>{LABEL[BTN.VIEW][0]}</span>
              <span className={on(BTN.MENU) ? 'pad-key on' : 'pad-key'}>{LABEL[BTN.MENU][0]}</span>
              <em>{mapping === 'standard' ? 'estándar' : 'no estándar'}</em>
            </div>
            <div className="pad-abxy">{FACE.map(([i, area]) => face(i, area))}</div>
            {stick(axes[0] ?? 0, axes[1] ?? 0, 'ls')}
            <div className="pad-ax">
              {axes.map((a, i) => (
                <span key={i}>{a}</span>
              ))}
            </div>
            {stick(axes[2] ?? 0, axes[3] ?? 0, 'rs')}
          </div>

          <div className="pad-row">
            {key(BTN.L3)}
            {key(BTN.X)}
            {key(BTN.B)}
            {key(BTN.A)}
            {key(BTN.R3)}
            {key(BTN.Y)}
          </div>
        </>
      ) : (
        <p className="pad-hint">
          Conecta un mando (Xbox, PlayStation, Switch…) y <b>pulsa cualquier botón</b>: hasta que no lo
          pulses, el navegador no lo enumera.
        </p>
      )}
    </div>
  )
}