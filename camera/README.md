# House Control camera

The camera in the studio, as one live page:

- on this Mac — <http://127.0.0.1:1984>
- on the tailnet — <https://rileys-macbook-air.tail946e94.ts.net:8452>

```
Wyze Cam Pan ──RTSP──▶ go2rtc on the Mac ──WebRTC / MSE──▶ browser
                              └── Tailscale Serve (tailnet devices only)
```

The camera does the encoding; the Mac only repackages the stream, so it costs
almost nothing to leave running. WebRTC gives about half a second of latency;
the player falls back to MSE, then HLS, by itself. `setup.sh` puts go2rtc in
`bin/`, installs it as a login item and adds the Tailscale Serve route — go2rtc
serves the page and the stream on the same port, so there is one origin and no
CORS anywhere.

## Run it

```sh
cd camera
./setup.sh
```

Open <http://127.0.0.1:1984> on the Mac, or the tailnet address from any device
signed in to the tailnet. Both are the same page.

`./setup.sh uninstall` stops it and removes the tailnet route. The log is
`~/Library/Logs/HouseControl/camera.log`; `curl localhost:1984/api/streams`
shows what go2rtc is doing.

| Port | What |
|---|---|
| 1984 | go2rtc's page and API, loopback only |
| 8554 | go2rtc's own RTSP server, loopback only |
| 8555/udp | WebRTC media |
| 8452 | Tailscale Serve → 1984, tailnet only |

## The camera

The one here is a **Wyze Cam Pan** — `WYZECP1`, the 2019 model on Ingenic's T20
chip, running firmware 4.10.9.x. It is supported by
[wz_mini_hacks](https://github.com/gtxaspec/wz_mini_hacks), which runs alongside
the stock firmware and adds a root shell, a local RTSP server and the camera's
own go2rtc. Pull the card and it boots stock again.

### A microSD card is the one thing you need

There is no software-only way in: the T20 boot ROM loads its image from the
card, and the app only installs what Wyze's own servers hand it. **256 MB is
enough** — any old card from a phone, dashcam, Switch or 3D printer will do.
Format it as FAT32 with a **DOS partition map** (Disk Utility → MS-DOS (FAT),
Scheme: Master Boot Record).

### Flash it

1. Clone the project and build the Pan image:

   ```sh
   git clone https://github.com/gtxaspec/wz_mini_hacks
   cd wz_mini_hacks/v2_install
   ./compile_image.sh pan
   ```

   The Pan v1 path is the awkward one: the script needs `wget`, `md5sum`,
   `mkimage` (u-boot-tools) and `unzip`, and it was written for Linux. It also
   only accepts a Wyze image it recognises (up to 4.10.9.1851), so if the newest
   download is rejected, drop that older `demo.zip` into `v2_install/` first.
   On the Mac `brew install u-boot-tools` supplies `mkimage`; the rest is a few
   lines of `dd`.

2. Copy everything from `SD_ROOT/` **and** the generated `demo.bin` to the root
   of the card.

3. In `wz_mini/wz_mini.conf` on the card, set:

   ```sh
   RTSP_AUTH_DISABLE="true"      # LAN-only camera; no password on the stream
   GO2RTC_SERVER_ENABLED="true"
   GO2RTC_HI_RES_ENABLED="true"  # 1080p from /dev/video6 on a T20
   WEB_SERVER_ENABLED="true"     # the camera's own page on :1984
   ```

   `DISABLE_FW_UPGRADE` is already `true`, so the camera will not update itself
   out of the hack.

4. Power the camera off, insert the card, then hold **reset** while powering it
   on. That starts Wyze's restore-from-card path; it flashes, reboots, and comes
   back on the same Wi-Fi.

5. The camera's own go2rtc is now at <http://192.168.0.136:1984>, and its stream
   at `rtsp://192.168.0.136:8554/1080p` — which is exactly what
   `go2rtc.yaml` asks for. Give the camera a DHCP reservation on the router, or
   change that one line if the lease moves.

### Cut it off from the cloud

The hack blocks firmware updates but leaves the Wyze app working. To actually
take it off Wyze's cloud, block the camera's route to the internet at the router
and keep it on the LAN (on a TP-Link that is Parental Controls / HomeShield:
add the camera, block it). Then reboot the camera once and confirm the stream
still comes up. Blocking on the camera itself with `iptables` in
`/opt/wz_mini/etc/rc.local.d/` also works, but the router rule is one switch to
undo.

Once it is blocked the Wyze app can no longer see it. That is the point.

### If you would rather not use a card

[Docker Wyze Bridge](https://github.com/mrlt8/docker-wyze-bridge) signs in to
your Wyze account, pulls the camera's P2P stream and re-serves it as RTSP. Point
`streams.camera` in `go2rtc.yaml` at the bridge's RTSP URL and the page works
the same. It needs Docker, and the camera stays bound to Wyze's cloud — so it
gets you the feed, but not the takeover.

### The fine print

It is your camera, but the mod voids the warranty and goes against Wyze's terms,
and a bad image can brick it. The same SD-card restore is usually what brings it
back. Do the cloud block last, after the stream is working.

## Files

| File | |
|---|---|
| `setup.sh` | Installs go2rtc, the login item and the Tailscale Serve route |
| `go2rtc.yaml` | The camera's RTSP address, ports, and the page |
| `www/index.html` | The page: stream, status, snapshot, full screen |
| `www/video-rtc.js` | go2rtc's player (MIT), vendored so the page is self-contained |
| `bin/` | The downloaded go2rtc binary (not in git) |
