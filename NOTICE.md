# Sources and attribution

DOCKYARD is an independently implemented live 3D toolchanger cockpit. It integrates with, rather than redistributes, Mainsail, Moonraker and Klipper toolchanger services.

- [Mainsail](https://github.com/mainsail-crew/mainsail) & [Moonraker](https://github.com/Arksine/moonraker) — connected printer web UI, APIs and saved material presets.
- [Klipper Toolchanger Extended](https://github.com/PrintStructor/klipper-toolchanger-extended) — toolchanger status, macros and calibration integration. The optional patch is intended for this extension.
- [VORON Design](https://github.com/VoronDesign) — VORON printer design and branding. The lime/graphite VORON hexagon uses geometry from [Voron-Extras / Hex_Logo.svg](https://github.com/VoronDesign/Voron-Extras/blob/main/Images/Logo/SVG/Hex_Logo.svg).
- CAD exported from the owner's Fusion assembly; the assembly contains upstream printer/toolhead components. Its provenance is recorded in `public/models/provenance.json`. Upstream component licenses and attribution continue to apply; publication here does not relicense those designs.
- [Vue](https://github.com/vuejs/core), [Vite](https://github.com/vitejs/vite), [Three.js](https://github.com/mrdoob/three.js), [CodeMirror 6](https://codemirror.net/) — MIT-licensed software dependencies.
- [Lucide](https://lucide.dev/license) — ISC-licensed icon package, with its included attribution notices.
- [Onest](https://github.com/simpals/onest) — font distributed under the SIL Open Font License.

Dependency packages retain their own licenses. No project-wide license is granted by this notice.
