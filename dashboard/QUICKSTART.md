# AuraSense Dashboard — Quickstart

Premium Netflix-style NVR UI. Full-screen appliance feel on bootup.

## Prerequisites

- Node.js 20+
- `chromium-browser` or `google-chrome` (for kiosk mode)
- API Gateway on `localhost:8000`
- mediamtx WHEP streams on `localhost:8889`
- Thumbnail server on `localhost:8001` (optional — silently skipped if absent)

## Install

```bash
cd /home/aura/Documents/aurasense/dashboard
npm install
```

## Run — dev server

```bash
npm run dev -- --port 5173 --host
# → http://localhost:5173/
```

Default login: `admin` / `changeme`

## Run — kiosk (full-screen appliance)

```bash
bash /home/aura/Documents/aurasense/dashboard/kiosk-start.sh
```

Starts Vite if needed, then launches Chromium in `--kiosk` mode.

Install Chromium if missing:
```bash
sudo apt install chromium-browser
```

## Boot on startup — systemd

Create `/etc/systemd/system/aurasense-kiosk.service`:

```ini
[Unit]
Description=AuraSense NVR Kiosk
After=network.target graphical-session.target

[Service]
Type=simple
User=aura
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/aura/.Xauthority
ExecStart=/home/aura/Documents/aurasense/dashboard/kiosk-start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
```

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aurasense-kiosk
```

## UI overview

| Element | Behaviour |
|---|---|
| **Nav bar** | Auto-hides 4 s after last mouse move; reappears on activity |
| **Featured camera** | Hero slot — first online camera by default |
| **"Set as Featured"** | Hover any shelf card → click tooltip to promote it to hero |
| **All Cameras shelf** | Horizontal Netflix-style row; scroll or use arrow buttons |
| **Card hover** | Scale pop + play button overlay |
| **Full-screen player** | Entire screen; chrome auto-hides; Esc or click outside to close |
| **Cursor** | Auto-hidden after 3 s of no movement (kiosk behaviour) |

## Proxy map (vite.config.js)

| Path | Target |
|---|---|
| `/api/*` | `http://localhost:8000` |
| `/thumbs/*` | `http://localhost:8001` |

## Component tree

```
src/
├── main.jsx               cursor-hide kiosk init, auth gate
├── LoginPage.jsx          full-screen glass-card login
├── App.jsx                page routing, nav visibility state
├── api/client.js          fetch wrapper, token storage
├── hooks/
│   ├── useCameras.js      polls /cameras every 30 s
│   └── useSnapshots.js    refreshes snapshot per cell every 20-30 s
└── components/
    ├── layout/NavBar.jsx      auto-hiding top nav + clock
    ├── ui/StatusDot.jsx       green / amber / red pulse dot
    ├── grid/
    │   ├── CameraGrid.jsx     featured + shelf orchestrator
    │   ├── FeaturedCamera.jsx hero panel (full-width, 58 vh)
    │   ├── CameraRow.jsx      Netflix horizontal shelf with arrows
    │   └── CameraCell.jsx     16:9 card, hover scale, play overlay
    └── player/
        ├── PlayerModal.jsx    full-screen portal, auto-hide chrome
        ├── LivePlayer.jsx     native WebRTC via WHEP
        └── Timeline.jsx       24 h scrub rail
```
