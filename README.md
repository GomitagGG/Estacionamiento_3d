# Estacionamiento 3D

Simulador de estacionamiento subterráneo hecho con React y three.js. Recorres el
subsuelo -2 de un garaje, te subes a uno de los autos, manejas y buscas un espacio
libre. Los paneles LED del garaje se actualizan **en vivo** con la ocupación real:
si ocupas un espacio, el plano de la pantalla lo marca al instante.

> **Demo:** https://gomitaggg.github.io/Estacionamiento_3d/

![React](https://img.shields.io/badge/React-19-61dafb) ![three.js](https://img.shields.io/badge/three.js-r186-000000) ![Vite](https://img.shields.io/badge/Vite-8-646cff)

---

## Qué puedes hacer

- **Caminar** por el garaje en primera persona o mirar con el ratón.
- **Subirte a cualquier auto** que tengas al lado y conducirlo.
- **Estacionarte** en un espacio y ver cómo los tableros LED actualizan el plano de
  ocupación al instante.
- **Jugar con teclado o con mando** (Xbox, PlayStation, Switch o cualquier otro que
  use el *standard mapping* de la Gamepad API).

Dentro del garaje hay un tablero LED de doble cara en el acceso, otro panel pegado
al muro y **9 pantallas en los pilares**: cada una muestra los espacios libres, un
plano con un marcador *ESTÁS AQUÍ* y qué filas tienes al lado.

---

## Controles

### Teclado

| Acción | A pie | Conduciendo |
| --- | --- | --- |
| Mover | `W` `A` `S` `D` o flechas | `W` / `S` acelerar y frenar |
| Girar | — | `A` / `D` |
| Correr | `Shift` | — |
| Freno de mano | — | `Espacio` |
| Subir / bajar del auto | `E` | `E` |
| Cambiar cámara (1ª ↔ 3ª persona) | — | `V` |
| Capturar el ratón | Clic izquierdo | Clic izquierdo |

### Mando

El simulador lee la **Gamepad API** usando el *standard mapping*, que numera igual
todos los botones sea cual sea la marca, así que funciona igual con un Xbox, un
DualSense o un Switch.

| Mando | A pie | Conduciendo |
| --- | --- | --- |
| Stick izquierdo / D-pad | Mover | Girar |
| `RT` / `LT` | Adelante / atrás | Acelerar / frenar y retroceder |
| Stick derecho | Mirar | Orbitar la cámara |
| `LB` | Correr | — |
| `B` | — | Freno de mano |
| `A` | Subir / bajar del auto | Bajar |
| `Y` o `R3` | — | Cambiar cámara |

Los gatillos y los sticks son **analógicos**: el auto acelera y gira de forma
proporcional a lo que presses.

Abajo a la derecha hay un visualizador en vivo con el nombre del mando, cada
botón que se enciende, la posición real de los sticks y el nivel de los gatillos.

> **Ojo:** Chrome y Edge no enumeran un mando hasta que recibe una pulsación. Si
> pone *Sin mando*, conecta el control y **pulsa cualquier botón**.

---

## Requisitos

- **Node.js 20.19+ o 22.12+** (lo que exige Vite 8; el despliegue usa la 22).
- Un navegador con WebGL2 (Chrome, Edge, Firefox o Safari actual).

## Instalación

```bash
npm install     # instalar dependencias
npm run dev     # servidor de desarrollo en http://localhost:5173
```

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Levanta el servidor de desarrollo con hot reload. |
| `npm run build` | Compila la app a `dist/` para producción. |
| `npm run preview` | Sirve `dist/` localmente para probar el build. |
| `npm run lint` | Pasa **oxlint** sobre el proyecto. |

---

## Cómo está armado

```
src/
├── main.jsx          punto de entrada
├── App.jsx           toda la escena 3D y la lógica de juego
├── gamepad.js        lectura del mando (Gamepad API) y mapeo de controles
├── PadOverlay.jsx    visualizador del mando en pantalla
├── index.css         estilos del HUD y del visualizador
└── assets/           sobrantes de la plantilla de Vite, no se usan
```

La escena se divide en un `Canvas` de `@react-three/fiber` y varios sistemas:

- **Texturas procedurales.** No hay ni una imagen ni un modelo 3D en el proyecto:
  el hormigón, el asfalto, la hierba, la corteza y las hojas se pintan en un
  `<canvas>` con ruido fractal (fBm) al arrancar. Lo mismo con la señalética y
  los letreros, que se dibujan con Canvas 2D.
- **Ocupación en vivo.** Cada frame se muestrea la huella de cada auto (45 puntos)
  contra la grilla de espacios. Un auto en movimiento no reserva espacios nuevos,
  solo mantiene el que ya tenía, y se avisa por pantalla al estacionarse o al
  liberar un espacio.
- **Tableros LED.** El plano se redibuja en un canvas y se sube como textura de
  three.js, con una rejilla oscura encima para imitar los píxeles del LED. Solo se
  refresca cuando algo cambia de verdad, y como máximo unas 8 veces por segundo,
  para no subir texturas cada frame.
- **Física ligera.** Colisiones por círculos a lo largo del auto y resolución de
  Penetration contra muros y pilares. Sin motor de física externo.

### Despliegue

`main` dispara `.github/workflows/deploy.yml`, que compila con Vite, sube `dist/`
como artefacto de Pages y publica en GitHub Pages. El `base` de Vite está fijado a
`/Estacionamiento_3d/` en `vite.config.js` porque el sitio vive en un subdirectorio.