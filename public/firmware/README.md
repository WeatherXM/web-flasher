# WG1200 Firmware Binaries

This directory contains signed application firmware binaries intended for flashing to the WeatherXM WG1200 Gateway (ESP32-S3).

## Binaries Overview

### WeatherXM Gateway Firmware
* **Location**: `weatherxm/`
* **Current Version**: v0.8.27 (Git commit `ceee14f`)
* **Source Repository**: `WeatherXM/wg1200-firmware`
* **Signature**: Secure Boot V2 signed (`0xE7` signature sector)
* **License**: Copyright © WeatherXM Ltd.

### Meshtastic Firmware
* **Location**: `meshtastic/`
* **Versions**:
  * `firmware-weatherxm-wg1200-tft-2.8.1-signed.bin` (TFT Display variant, commit `caa2e99`)
  * `firmware-weatherxm-wg1200-2.8.1-signed.bin` (Standard variant, commit `6201f02`)
* **Source Repository**: `WeatherXM/Meshtastic-firmware` (derived from `meshtastic/firmware`)
* **Signature**: Secure Boot V2 signed (`0xE7` signature sector)
* **License**: GNU General Public License v3.0 (GPLv3). See `THIRD_PARTY_NOTICES.md` at repository root.
