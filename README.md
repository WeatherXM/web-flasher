# flash.weatherxm.com — WeatherXM Firmware Web Flasher

The site opens on a device picker:

| Route | Device | Transport | What it does |
|---|---|---|---|
| `/` | — | — | Pick WG1200 or WS1300; shows whether this browser supports each |
| `/wg1200` | WG1200 / D1 gateway | USB (Web Serial) | Switch between WeatherXM and Meshtastic firmware (below) |
| `/ws1300` | WS1300 weather station | Bluetooth (Web Bluetooth) | Update to the latest published firmware, or install a `-dfu.zip` / signed `.bin` |
| `/ws1300/dev` | WS1300 | Bluetooth | Staff tools: Zephyr shell console, any published release, file installs, MCUboot slots. Not linked, `noindex` |

## WG1200 Firmware Web Flasher

Web-based firmware switcher for the **WeatherXM WG1200 / D1 Gateway**, with two deliberately different operating modes:

* **WeatherXM Tri-Protocol Gateway** — keeps normal WeatherXM gateway/cloud operation and can republish the paired station's weather observations as **Meshtastic environmental telemetry** and **MeshCore sensor-node telemetry**. This is the mode to use when you want the weather station visible in mesh ecosystems without giving up WeatherXM.
* **Full Meshtastic Node** — replaces the active gateway application with native Meshtastic firmware so the **WG1200 itself** becomes a Meshtastic router/repeater/client using its onboard SX1262 and TFT.

The entire operation happens in the browser over USB using the **Web Serial API**.

> **WeatherXM tri-protocol mode adds mesh-compatible weather telemetry; Full Meshtastic mode turns the gateway itself into a Meshtastic node. Your WeatherXM device identity, credentials and factory recovery image stay intact, so you can switch back at any time.**

---

## Safety Guarantees & Invariants

This is **not** a generic ESP32 flasher. It is purpose-built with strict hardware write guards:

1. **Zero Cloud Credential Risk**: The device credentials partition (`esp_secure_cert` at `0x00D000`) is never erased or written.
2. **Factory Fallback Preserved**: The `factory` partition (`0x020000`) remains protected as the immutable stock recovery image.
3. **Strict Write Guard**: Firmware application payload writes are strictly confined to `ota_0` (`0x420000`) or `ota_1` (`0x820000`). Slot activation uses guarded, CRC-verified atomic updates to `otadata` (`0x013000`). All other partitions are hardware/logic write-protected.
4. **Chip Erase Disabled**: `eraseAll: false` is permanently enforced. Full flash erase APIs are stripped out.
5. **Pre/Post Verification**: Cryptographic SHA-256 snapshots verify that protected partitions remain byte-for-byte identical before and after flashing.
6. **Hardware MD5 Check**: Uses on-chip ESP32-S3 SPI flash MD5 calculation to guarantee image integrity.

---

## WG1200 16 MB Partition Map

| Offset | Size | Name | Purpose |
|---|---|---|---|
| `0x00C000` | 4 KB | `partition_table` | ESP-IDF partition table |
| `0x00D000` | 8 KB | `esp_secure_cert` | Device cloud credentials & certificates (TLV `0xBA5EBA11`) |
| `0x00F000` | 16 KB | `nvs` | Non-volatile storage |
| `0x013000` | 8 KB | `otadata` | Active OTA boot pointer & CRC32 |
| `0x015000` | 4 KB | `phy_init` | RF calibration data |
| `0x020000` | 4 MB | `factory` | Stock WeatherXM factory fallback |
| `0x420000` | 4 MB | `ota_0` | Application Slot 0 |
| `0x820000` | 4 MB | `ota_1` | Application Slot 1 |
| `0xC20000` | 4 KB | `nvs_key` | NVS encryption key |
| `0xC21000` | 3 MB | `spiffs` | File storage |

---

## Adding New Firmware & Updating Manifest

`npm run manifest` refreshes the manifests of **both** devices (WG1200 and WS1300). A file argument is routed by name: `*.bin` to WG1200, `*-dfu.zip` to WS1300. Use `npm run manifest:wg1200` or `npm run manifest:ws1300` to run just one.

To add a new firmware release:

```bash
# Option 1: Provide the new binary file directly
npm run manifest -- path/to/fw_release_0.8.27-gceee14f-signed.bin

# Option 2: Place binary in public/firmware/weatherxm/ or public/firmware/meshtastic/ and run:
npm run manifest
```

The script will automatically:
1. Verify the binary size, ESP-IDF app descriptor, and ESP32-S3 Secure Boot V2 signature (0xE7 magic).
2. Calculate the exact SHA-256 checksum.
3. Sort versions semantically and set the newest as the default `weatherxm` release.
4. Update `public/firmware/manifest.json` and sync with `dist/firmware/manifest.json`.

---

## WS1300 Bluetooth Updates

The WS1300 (nRF5340) is updated over the air with MCUmgr/SMP, ported from `ws1300-firmware-internal/tools/web-flasher-ble` into `src/lib/ble/`:

* `cbor.ts`, `smp.ts`: SMP framing (writes split into 180-byte ATT fragments for macOS), image state, upload, test mark, reset
* `nus.ts`: Nordic UART shell client (needs a paired, encrypted link; SMP does not)
* `dfuPackage.ts`: reads nRF Connect SDK `-dfu.zip` packages (app core image 0, network core image 1) with `fflate`, and checks the MCUboot header of every image
* `ws1300Manifest.ts`: release list, download with size + SHA-256 checks against the manifest
* `dfu.ts`, `updateFlow.ts`: upload all images, mark them for test, reset, then reconnect and compare the running version

The station application confirms its own image at boot (`imgswap_confirm()` in `app/src/main.cpp`), so an image that fails to start is reverted by MCUboot.

### Publishing a WS1300 release

```bash
npm run manifest -- path/to/ws1300_release_v22.4-dfu.zip
```

This copies the package into `public/firmware/ws1300/`, validates every image (board must be WS1300, MCUboot magic `0x96f3b83d`, not truncated), records SHA-256 of the package and each image, and rewrites `public/firmware/ws1300/manifest.json` with the newest version as `latest`. It warns when the package was built from a working tree with uncommitted changes.

The manifest is rebuilt from whatever `*-dfu.zip` files are in `public/firmware/ws1300/` on every run, so you can also drop packages there (or delete them) and run `npm run manifest` with no argument.

## Local Development

```bash
# Install dependencies
npm install

# Run unit & safety tests
npm test

# Run typecheck
npm run typecheck

# Start local development server
npm run dev

# Build production static site
npm run build
```

---

## Deployment to Cloudflare Pages

This site is 100% static and deploys to Cloudflare Pages:
* **Build command**: `npm run build`
* **Build output directory**: `dist`
* **Node version**: `20` or `22`
* **Custom domain**: `flasher.weatherxm.com`
* Permissions policy header in `public/_headers`: `Permissions-Policy: serial=(self), bluetooth=(self)` allows Web Serial and Web Bluetooth.
