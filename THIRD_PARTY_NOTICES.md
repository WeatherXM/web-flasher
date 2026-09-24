# Third-Party Notices & Licensing

This project, the **WeatherXM WG1200 Web Flasher**, includes open source components and firmware binaries subject to different license agreements.

## 1. Web Application Code

The Web Flasher application source code, user interface, and flasher controller logic are licensed under the **Apache License, Version 2.0**.
See the [LICENSE](./LICENSE) file for the full text.

---

## 2. Bundled Firmware Binaries

### Meshtastic® Firmware (GPLv3)

The firmware binaries located under `public/firmware/meshtastic/` are derived from the [Meshtastic project](https://meshtastic.org), which is distributed under the **GNU General Public License v3.0 (GPLv3)**.

* **Upstream Project**: [https://github.com/meshtastic/firmware](https://github.com/meshtastic/firmware)
* **WeatherXM Fork & Build Source**: [https://github.com/WeatherXM/Meshtastic-firmware](https://github.com/WeatherXM/Meshtastic-firmware)
* **Corresponding Source Commits**:
  * `firmware-weatherxm-wg1200-tft-2.8.1-signed.bin`: Git commit [`caa2e99`](https://github.com/WeatherXM/Meshtastic-firmware/commit/caa2e99)
  * `firmware-weatherxm-wg1200-2.8.1-signed.bin`: Git commit [`6201f02`](https://github.com/WeatherXM/Meshtastic-firmware/commit/6201f02)
* **License**: GNU General Public License v3.0. A copy of the GPLv3 license is available at [https://www.gnu.org/licenses/gpl-3.0.html](https://www.gnu.org/licenses/gpl-3.0.html).

In accordance with GPLv3 Section 6, the corresponding source code for the Meshtastic firmware builds is made publicly available at the GitHub repositories referenced above.

### WeatherXM Gateway Firmware

The firmware binaries located under `public/firmware/weatherxm/` (e.g. `fw_release_0.8.27-gceee14f-signed.bin`) are official releases provided by WeatherXM Ltd. for the WeatherXM WG1200 / D1 Gateway.
Copyright © WeatherXM Ltd. All rights reserved.
Source and updates: [https://github.com/WeatherXM/wg1200-firmware](https://github.com/WeatherXM/wg1200-firmware)

---

## 3. Third-Party JavaScript Libraries

The web application utilizes third-party npm packages (e.g., `esptool-js`, `spark-md5`, `astro`, `tailwindcss`).
Their respective licenses (MIT, Apache-2.0, BSD) are preserved within the bundled distribution packages as required by their upstream authors.
