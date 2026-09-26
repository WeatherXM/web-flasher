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

## WS1300 Wireless BLE DFU Flashing

Wireless in-browser Device Firmware Update (DFU) for the **WeatherXM WS1300 outdoor weather station**, powered by **Web Bluetooth** and Zephyr MCUmgr SMP. No cables, no proprietary desktop software, and no mobile app required—you can update the station in the field directly from a laptop or an Android phone standing next to the unit.

### Dual-Core Architecture (Nordic nRF5340)

The WS1300 is built on the dual-core **Nordic nRF5340 SoC**. The web flasher orchestrates updates across both hardware cores sequentially from standard nRF Connect SDK `-dfu.zip` distribution packages:

* **Application Core (Image 0)**: Weather sensor acquisition, power management, local calibration, and telemetry formatting.
* **Network Core (Image 1)**: 2.4 GHz Bluetooth Low Energy controller, radio protocol stack, and Zephyr BLE subsystem.

### Fail-Safe MCUboot Dual-Slot Mechanism

The flashing pipeline guarantees zero risk of bricking:

1. **Integrity Pre-Checks**: The web client verifies the MCUboot header magic (`0x96f3b83d`), image vector table, and cryptographic SHA-256 checksums of the release package before initiating transfer.
2. **Secondary Slot Staging**: New images are uploaded chunk-by-chunk into the station's inactive secondary flash slot via MCUmgr SMP. The running firmware remains completely untouched.
3. **Test-Mode Boot**: Upon transfer completion, the web flasher marks the new slot for `test` execution and requests a controlled reboot.
4. **Self-Confirming Verification**: On boot, the updated firmware runs hardware self-tests and confirms its own image (`imgswap_confirm()` in `app/src/main.cpp`).
5. **Automatic Rollback**: If the new firmware fails to boot, crashes, or hangs, the MCUboot hardware watchdog triggers a reboot and **automatically rolls back** to the previously confirmed image.

### BLE DFU Protocol Implementation (`src/lib/ble/`)

* **`smp.ts` / `cbor.ts`**: Zephyr MCUmgr Simple Management Protocol (SMP) client over Web Bluetooth (SMP Service `8D53DC1D-1DB7-4CD3-868B-8A527460AA84`). Implements CBOR payload encoding, multi-notification reassembly, image state queries (`ImageStatesRead`), chunked image streaming (`ImageUploadWrite`), test marking (`ImageStatesWrite`), and OS reset.
* **ATT MTU Fragmentation**: Data writes are dynamically packetized into 180-byte ATT fragments, preventing packet drops and buffer overflows across macOS, Windows, Linux, and Android Bluetooth stacks.
* **`dfuPackage.ts`**: High-performance in-memory ZIP parser using `fflate` that extracts and validates `manifest.json`, `app_update.bin` (Image 0), and `net_core_app_update.bin` (Image 1).
* **`ws1300Manifest.ts`**: Remote manifest resolver with strict SHA-256 validation against `/firmware/ws1300/manifest.json`.
* **`dfu.ts` / `updateFlow.ts`**: Multi-phase state machine managing connection, pre-flight queries, dual-core uploads, progress metrics (throughput in KB/s, ETA), reboot sequencing, and post-update verification.
* **`nus.ts`**: Nordic UART Service client providing terminal stream access to the embedded Zephyr shell.

### How to Update a WS1300 Station

1. **Open the WS1300 Flasher**: Navigate to [`/ws1300`](https://flasher.weatherxm.com/ws1300) in Chrome or Edge on a laptop or Android phone.
2. **Wake Bluetooth Advertising**: Stand next to the station and **press the physical button once briefly** (do *not* hold for 15+ seconds, as that clears paired network settings). The station will advertise over Bluetooth for 15 minutes.
3. **Connect**: Click **Connect WS1300** and select your station from the browser's Bluetooth chooser.
4. **Start Update**: The flasher compares the installed firmware version against the latest release. Click **Install update**.
5. **Automatic Dual-Core Flashing**: The flasher streams both application and network images with live throughput telemetry, prompts the reboot, and confirms the new version once the station boots.

### Staff & Developer Tools (`/ws1300/dev`)

For engineering diagnostics, testing custom firmware builds, or debugging MCUboot states, the unlisted developer portal provides:

* **Interactive Zephyr Shell**: Real-time console over Nordic UART Service (NUS) to run Zephyr shell commands, inspect logs, and debug sensor hardware.
* **Live MCUboot Slot Inspector**: Queries active vs. secondary slot versions, image hashes, and slot flags (`pending`, `confirmed`, `active`, `permanent`).
* **Custom File / Release Installer**: Flash custom `-dfu.zip` packages or standalone signed `.bin` files directly from disk.
* **Manual Slot Controls**: Force slot test marking, manual image confirmation, or slot erasing.

### Publishing a WS1300 Release

```bash
# Validate package, generate SHA-256 hashes, and update manifest
npm run manifest -- path/to/ws1300_release_v22.6-dfu.zip

# Or inspect/refresh existing packages in public/firmware/ws1300/
npm run manifest:ws1300
```

The manifest generator validates that:
* The package is a valid nRF Connect SDK DFU zip.
* Every contained image targets the WS1300 board and contains a valid MCUboot header (`0x96f3b83d`).
* Hashes are calculated and stored in `public/firmware/ws1300/manifest.json` and mirrored to `dist/firmware/ws1300/manifest.json`.

---

## Browser & Device Compatibility

| Browser | OS | WG1200 (Web Serial) | WS1300 (Web Bluetooth) |
|---|---|:---:|:---:|
| **Google Chrome** | macOS, Windows, Linux, ChromeOS | Full | Full |
| **Microsoft Edge** | macOS, Windows, Linux | Full | Full |
| **Chrome for Android** | Android | Not supported by OS | Full (ideal for outdoor updates!) |
| **Brave / Opera** | Desktop | Full | Full |
| **Safari / WebKit** | macOS, iOS | Unsupported (No Web Serial) | Unsupported by Safari* |

*\*On iOS, Apple restricts the Web Bluetooth API in Safari. iOS users can use specialized Web Bluetooth browsers like [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055).*

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
