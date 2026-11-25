#!/usr/bin/env python3
"""Listen to the WS2001 / WS2000 BLE weather beacon (firmware V5.2+) and decode it.

No pairing and no connection: the station broadcasts, this tool only scans.
Packet layouts and timing: https://flash.weatherxm.com/ws2001/beacon/reference

    pip install bleak
    python3 ws2001_beacon.py                      # listen for 60 s, print every new packet
    python3 ws2001_beacon.py --name 500131        # only the station whose name ends with 500131
    python3 ws2001_beacon.py --duration 300 --json

The decoders (decode_frame_packet, decode_info_packet, decode_combined_packet, decode_bthome,
decode_lorawan_frame) have no BLE dependency: copy them into your own project.

Source of truth: ws2001-firmware/tools/ws2001_beacon.py (tests: tools/test_ws2001_tools.py).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import time

COMPANY_ID = 0xFFFF            # BLE_BEACON_COMPANY_ID (WeatherXM has no assigned identifier)
FRAME_VERSION = 1              # upper nibble of the frame packet header
BTHOME_UUID16 = 0xFCD2
BTHOME_UUID = "0000fcd2-0000-1000-8000-00805f9b34fb"

PACKET_FRAME = 0              # bits 3-2 of the first header byte
PACKET_INFO = 1
PACKET_COMBINED = 2           # long-range mode: info + frame in one extended advertising packet

FLAG_UTC = 0x01
FLAG_STALE = 0x02


# --------------------------------------------------------------------------- LoRaWAN weather frame
def _dir2(b):
    return None if b > 179 else b * 2


def decode_lorawan_frame(frame: bytes) -> dict:
    """Decode the weather frame the station also sends over LoRaWAN (FPort 99).

    Mirrors tools/decoders/ws2001_uplink_decoder.js: 0xF0 = 24-byte WeatherXM frame, untagged frame of 16
    bytes or more = Open Edition frame.
    """
    if len(frame) >= 24 and frame[0] in (0xF0, 0xF1):
        d = {"frame": "weather", "format": "weatherxm"}
        d["firmware_version"] = f"{frame[1] >> 4}.{frame[1] & 0x0F}"
        hw = (frame[2] >> 5) & 0x07
        d["hardware_version"] = f"1.{hw - 1}" if hw else "unknown"
        d["tx_power"] = frame[2] & 0x1F
        d["upload_interval_min"] = frame[3] & 0x7F
        d["battery_low"] = bool(frame[3] & 0x80)
        d["samples"] = frame[4]
        t = struct.unpack_from("<h", frame, 5)[0]
        d["temperature"] = None if t == 0x7FFF else t / 10
        hd = (frame[7] << 8) | frame[8]
        d["humidity"] = None if (hd >> 9) == 0x7F else hd >> 9
        d["wind_direction"] = None if (hd & 0x1FF) == 0x1FF else hd & 0x1FF
        uw = (frame[9] << 8) | frame[10]
        d["uv_index"] = None if (uw >> 11) == 0x1F else uw >> 11
        d["wind_speed"] = None if (uw & 0x7FF) == 0x7FF else (uw & 0x7FF) / 10
        g = struct.unpack_from("<H", frame, 11)[0]
        d["wind_gust"] = None if g == 0xFFFF else g / 10
        r = struct.unpack_from("<I", frame, 13)[0]
        d["rain_accumulated"] = None if r == 0x7FFFFFFF else r / 1000
        d["rain_rate"] = struct.unpack_from("<H", frame, 17)[0] / 10
        lx = frame[19] | (frame[20] << 8) | (frame[21] << 16)
        d["lux"] = None if lx == 0x7FFFFF else lx
        p = struct.unpack_from("<H", frame, 22)[0]
        d["pressure"] = None if p in (0xFFFF, 0) else p / 10
        return d

    if len(frame) >= 16 and frame[0] not in (0xF0, 0xF1, 0xF2, 0xF3):
        d = {"frame": "weather", "format": "open"}
        hd = (frame[0] << 8) | frame[1]
        d["humidity"] = None if (hd >> 9) == 0x7F else hd >> 9
        d["wind_direction"] = None if (hd & 0x1FF) == 0x1FF else hd & 0x1FF
        t = struct.unpack_from("<h", frame, 2)[0]
        d["temperature"] = None if t == 0x7FFF else t / 10
        buw = (frame[4] << 8) | frame[5]
        d["battery_low"] = bool(buw & 0x8000)
        uv = (buw >> 11) & 0x0F
        d["uv_index"] = None if uv == 0x0F else uv
        d["wind_speed"] = None if (buw & 0x7FF) == 0x7FF else (buw & 0x7FF) / 10
        g, r, rr, lx, p = struct.unpack_from("<HHHHH", frame, 6)
        d["wind_gust"] = None if g == 0xFFFF else g / 10
        d["rain_accumulated"] = None if r == 0xFFFF else r / 10
        d["rain_rate"] = None if rr == 0xFFFF else rr / 10
        d["lux"] = None if lx == 0xFFFF else lx * 10
        d["pressure"] = None if p in (0xFFFF, 0) else p / 10
        if len(frame) >= 20:
            d["wind_direction_sigma"] = None if frame[16] == 0xFF else frame[16]
            d["wind_direction_range_start"] = _dir2(frame[17])
            d["wind_direction_range_end"] = _dir2(frame[18])
            d["wind_gust_direction"] = _dir2(frame[19])
        return d

    return {"frame": "unknown", "error": f"cannot decode {len(frame)}-byte frame"}


# --------------------------------------------------------------------------- frame packet (manufacturer data)
def decode_period(code: int) -> int:
    """Burst period in seconds from header byte 2."""
    return (code & 0x7F) * 60 if code & 0x80 else code


INFO_LEN = 27  # info packet body; bytes 21-26 (rain) were added before the first release


def _decode_info_rain(payload: bytes) -> dict:
    """Rain fields of the info packet: live rate (0.1 mm/h) and lifetime total (0.001 mm)."""
    if len(payload) < INFO_LEN:
        return {}
    rate, total = struct.unpack_from("<HI", payload, 21)
    return {
        "rain_rate": None if rate == 0xFFFF else rate / 10,
        "rain_total": None if total == 0x7FFFFFFF else total / 1000,
    }


def decode_info_packet(payload: bytes) -> dict | None:
    """Decode the station identity packet (packet type 1). None if it is not one."""
    if len(payload) < 21 or (payload[0] >> 4) != FRAME_VERSION or ((payload[0] >> 2) & 0x03) != PACKET_INFO:
        return None
    dev_eui = bytes(payload[2:10])
    burst_offset_ms, uptime_min, unix_time = struct.unpack_from("<HHI", payload, 13)
    return {
        "packet": "info",
        "utc_aligned": bool(payload[0] & FLAG_UTC),
        "period_s": decode_period(payload[1]),
        "dev_eui": dev_eui.hex().upper(),
        "name_suffix": dev_eui[5:].hex().upper(),   # as in the BLE name "WeatherXM WS2001 <suffix>"
        "firmware_version": f"{payload[10] >> 4}.{payload[10] & 0x0F}",
        "network_profile": "weatherxm" if payload[11] == 0 else "custom",
        "tx_power_dbm": struct.unpack_from("<b", payload, 12)[0],
        "burst_offset_ms": burst_offset_ms,   # this packet was sent this long after the burst started
        "uptime_min": uptime_min,
        "unix_time": unix_time or None,
        **_decode_info_rain(payload),
    }


def decode_combined_packet(payload: bytes) -> dict | None:
    """Decode the long-range packet (packet type 2): the info packet body, then frame counter, length, frame."""
    if len(payload) < INFO_LEN + 2 or (payload[0] >> 4) != FRAME_VERSION or ((payload[0] >> 2) & 0x03) != PACKET_COMBINED:
        return None
    out = decode_info_packet(bytes([(payload[0] & 0xF3) | (PACKET_INFO << 2)]) + bytes(payload[1:INFO_LEN]))
    frame_len = payload[INFO_LEN + 1]
    frame = bytes(payload[INFO_LEN + 2:INFO_LEN + 2 + frame_len])
    out.update({
        "packet": "long_range",
        "stale": bool(payload[0] & FLAG_STALE),
        "frame_counter": payload[INFO_LEN],
        "frame_hex": frame.hex(),
        "data": decode_lorawan_frame(frame) if len(frame) == frame_len and frame_len else None,
    })
    return out


def decode_manufacturer_data(payload: bytes) -> dict | None:
    """Decode any manufacturer data packet of the beacon."""
    if len(payload) < 1:
        return None
    kind = (payload[0] >> 2) & 0x03
    if kind == PACKET_INFO:
        return decode_info_packet(payload)
    if kind == PACKET_COMBINED:
        return decode_combined_packet(payload)
    return decode_frame_packet(payload)


def decode_frame_packet(payload: bytes) -> dict | None:
    """Decode the manufacturer data that follows the company identifier. None if it is not a WS2001 beacon."""
    if len(payload) < 3 + 16 or (payload[0] >> 4) != FRAME_VERSION or ((payload[0] >> 2) & 0x03) != PACKET_FRAME:
        return None
    frame = bytes(payload[3:])
    return {
        "packet": "frame",
        "utc_aligned": bool(payload[0] & FLAG_UTC),
        "stale": bool(payload[0] & FLAG_STALE),
        "frame_counter": payload[1],
        "period_s": decode_period(payload[2]),
        "frame_hex": frame.hex(),
        "data": decode_lorawan_frame(frame),
    }


# --------------------------------------------------------------------------- BTHome v2
# object id -> (name, struct format, factor); only the objects the station sends
_BTHOME = {
    0x00: ("packet_id", "<B", 1),
    0x02: ("temperature", "<h", 0.01),
    0x04: ("pressure", "<I", 0.01),          # uint24
    0x05: ("illuminance", "<I", 0.01),       # uint24
    0x15: ("battery_low", "<B", 1),
    0x2E: ("humidity", "<B", 1),
    0x44: ("speed", "<H", 0.01),
    0x46: ("uv_index", "<B", 0.1),
    0x50: ("timestamp", "<I", 1),
    0x5E: ("wind_direction", "<H", 0.01),
    0x5F: ("rain_accumulated", "<H", 0.1),
    0xF2: ("firmware_version", "<I", 1),     # uint24
}
_BTHOME_U24 = (0x04, 0x05, 0xF2)


def decode_bthome(service_data: bytes) -> dict | None:
    """Decode BTHome v2 service data (the bytes after the 0xFCD2 UUID). None if not BTHome v2 unencrypted."""
    if not service_data or (service_data[0] >> 5) != 2 or (service_data[0] & 0x01):
        return None
    out: dict = {"packet": "bthome"}
    speeds = []
    i = 1
    while i < len(service_data):
        obj = service_data[i]
        if obj not in _BTHOME:
            out["undecoded"] = service_data[i:].hex()
            break
        name, fmt, factor = _BTHOME[obj]
        size = 3 if obj in _BTHOME_U24 else struct.calcsize(fmt)
        raw = bytes(service_data[i + 1:i + 1 + size])
        if len(raw) < size:
            break
        value = int.from_bytes(raw, "little") if obj in _BTHOME_U24 else struct.unpack(fmt, raw)[0]
        i += 1 + size
        if obj == 0x44:
            speeds.append(round(value * factor, 2))
        elif obj == 0xF2:
            out[name] = f"{(value >> 16) & 0xFF}.{(value >> 8) & 0xFF}.{value & 0xFF}"
        elif obj == 0x15:
            out[name] = bool(value)
        elif factor == 1:
            out[name] = value
        else:
            out[name] = round(value * factor, 2)
    # two "speed" objects, in this order: wind speed (12-s mean), wind gust (12-s peak)
    if len(speeds) >= 1:
        out["wind_speed"] = speeds[0]
    if len(speeds) >= 2:
        out["wind_gust"] = speeds[1]
    return out


def seconds_to_next_burst(period_s: int, heard_at: float, burst_offset_ms: int = 0, now: float | None = None) -> float:
    """Seconds until the next burst starts, from an info packet that was heard (the normal way to sleep).

    Bursts are exactly period_s apart on the station's clock, and the info packet says how long after the
    start of its burst it was sent. No absolute time is involved, so clock drift does not add up: at 100 ppm
    a 60 s period is 6 ms off. The heard repeat may be up to (repeat - 1) * 110 ms later than burst_offset_ms:
    wake up that much earlier.
    """
    now = time.time() if now is None else now
    burst_start = heard_at - burst_offset_ms / 1000
    return period_s - ((now - burst_start) % period_s)


def seconds_to_next_utc_burst(period_s: int, now: float | None = None) -> float:
    """Seconds until the next burst of a UTC-aligned station (header bit 0), without having heard it."""
    now = time.time() if now is None else now
    return period_s - (now % period_s)


# --------------------------------------------------------------------------- scanner
async def listen(args) -> int:
    try:
        from bleak import BleakScanner
    except ImportError:
        print("bleak is not installed: pip install bleak", file=sys.stderr)
        return 2

    seen: dict = {}       # (address, kind, key) -> last payload
    names: dict = {}      # address -> name
    events = []
    t0 = time.time()

    def emit(address, rssi, decoded):
        now = time.time()
        decoded.update({"t": round(now - t0, 3), "time": round(now, 3), "address": address,
                        "name": names.get(address), "rssi": rssi})
        if "burst_offset_ms" in decoded and decoded.get("period_s"):
            decoded["next_burst_in_s"] = round(
                seconds_to_next_burst(decoded["period_s"], now, decoded["burst_offset_ms"], now), 2)
        events.append(decoded)
        if not args.json:
            head = f"[{decoded['t']:8.3f}s] {names.get(address) or address} rssi {rssi}"
            body = {k: v for k, v in decoded.items() if k not in ("t", "time", "address", "name", "rssi")}
            print(head, json.dumps(body), flush=True)

    def on_adv(device, adv):
        if adv.local_name:
            names[device.address] = adv.local_name
        name = names.get(device.address) or ""
        if args.name and not name.upper().endswith(args.name.upper()):
            # the name comes with the scan response, which may arrive after the first packet
            if not (args.address and device.address.upper() == args.address.upper()):
                return
        payload = adv.manufacturer_data.get(COMPANY_ID)
        if payload is not None:
            decoded = decode_manufacturer_data(bytes(payload))
            if decoded:
                key = (device.address, decoded["packet"])
                # the info packet changes every burst: compare without the clock fields
                if decoded["packet"] == "info":
                    same = bytes(payload[:13])
                elif decoded["packet"] == "long_range":
                    same = bytes(payload[:13]) + bytes(payload[21:])  # all but burst offset, uptime, Unix time
                else:
                    same = bytes(payload)
                if args.all or seen.get(key) != same:
                    seen[key] = same
                    emit(device.address, adv.rssi, decoded)
        sd = adv.service_data.get(BTHOME_UUID)
        if sd is not None:
            decoded = decode_bthome(bytes(sd))
            if decoded:
                key = (device.address, "bthome", decoded.get("packet_id", 0) & 1)
                if args.all or seen.get(key) != bytes(sd):
                    seen[key] = bytes(sd)
                    emit(device.address, adv.rssi, decoded)

    scanner = BleakScanner(on_adv, scanning_mode="active")
    await scanner.start()
    try:
        await asyncio.sleep(args.duration)
    finally:
        await scanner.stop()

    if args.json:
        print(json.dumps({"duration_s": args.duration, "packets": events}, indent=2))
    elif not events:
        print("No beacon packets heard. Is the beacon enabled (AT+BEACON=3,60) and the firmware V5.2+?")
    return 0 if events else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Listen to the WS2001 BLE weather beacon")
    ap.add_argument("--duration", type=float, default=60.0, help="seconds to listen (default 60)")
    ap.add_argument("--name", help="only stations whose BLE name ends with this (for example 500131)")
    ap.add_argument("--address", help="only this BLE address (differs per machine on macOS)")
    ap.add_argument("--all", action="store_true", help="print repeated packets too, not only changes")
    ap.add_argument("--json", action="store_true", help="print one JSON document at the end")
    return asyncio.run(listen(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
