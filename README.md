# flasher.weatherxm.com — WG1200 Firmware Switcher

Web-based firmware switcher for the **WeatherXM WG1200 / D1 Gateway**, enabling safe switching between:
* **WeatherXM Gateway Firmware**
* **Meshtastic for WG1200**

The entire operation happens in the browser over USB using the **Web Serial API**.

> **Switch your WeatherXM D1 between WeatherXM and Meshtastic over USB. Your WeatherXM device identity and cloud credentials stay intact. You can switch back at any time.**

---

## Safety Guarantees & Invariants

This is **not** a generic ESP32 flasher. It is purpose-built with strict hardware write guards:

1. **Zero Cloud Credential Risk**: The factory partition holding WeatherXM identity (`esp_secure_cert` at `0x00D000`) is never erased or written.
2. **Factory Fallback Preserved**: The `factory` partition (`0x020000`) remains protected as the immutable stock recovery image.
3. **Write Guard**: Every flash operation strictly validates that writes are confined to `ota_0` (`0x420000`) or `ota_1` (`0x820000`).
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
* Permissions policy header in `public/_headers`: `Permissions-Policy: serial=(self)` ensures Web Serial is active.
