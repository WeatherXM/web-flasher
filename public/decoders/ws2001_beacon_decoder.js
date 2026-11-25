// WeatherXM WS2001 / WS2000 BLE weather beacon decoder (firmware V5.2+)
//
// The station broadcasts bursts of Bluetooth advertising packets that anyone nearby can read without pairing.
// This file decodes them. It is plain JavaScript with no dependencies: use it in Node.js, a browser, Espruino,
// or port it (it is short).
//
// A burst holds up to four packets from the same Bluetooth address:
//   1. frame packet   manufacturer data, company identifier 0xFFFF, packet type 0:
//                     the weather frame of the LoRaWAN uplink (averages over the upload interval)
//   2. info packet    manufacturer data, company identifier 0xFFFF, packet type 1:
//                     which station this is, where in the burst the packet is, rain rate and total
//   3. BTHome v2      service data, UUID 0xFCD2, even packet id: temperature, pressure, humidity, wind
//   4. BTHome v2      service data, UUID 0xFCD2, odd packet id: light, battery, UV, time, rain total
// and, if the long-range mode is on, one extended advertising packet on the LE Coded PHY with all of it
// (manufacturer data packet type 2 plus one BTHome service data).
//
// Give the functions the bytes your Bluetooth stack reports:
//   wxmBeaconDecodeManufacturerData(bytes)  bytes AFTER the 2-byte company identifier
//   wxmBeaconDecodeBthome(bytes)            bytes AFTER the 2-byte service UUID
// Both return null for data that is not a WS2001 beacon.
//
// The weather frame is the one the station sends over LoRaWAN. If ws2001_uplink_decoder.js is loaded as well
// (it defines decodeUplink), the frame packet is returned with its values decoded in "data"; otherwise decode
// "frame" with that decoder and fPort 99.
//
// Sleeping between bursts: bursts are exactly period_s apart on the station's clock, and the info packet says
// how many milliseconds after the start of its burst it was sent. See wxmBeaconMsToNextBurst below.
//
// Source of truth: ws2001-firmware/tools/decoders/ws2001_beacon_decoder.js
// Packet layouts and timing: https://flash.weatherxm.com/ws2001/beacon/reference

var WXM_BEACON_COMPANY_ID = 0xffff;        // manufacturer data
var WXM_BEACON_BTHOME_UUID16 = 0xfcd2;     // service data
var WXM_BEACON_FORMAT_VERSION = 1;         // upper 4 bits of the first manufacturer data byte

function wxmBeaconHex(b, start, end) {
  var s = "";
  for (var i = start; i < end && i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}
function wxmBeaconU16(b, i) { return b[i] | (b[i + 1] << 8); }
function wxmBeaconU32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

// Burst period in seconds from the period byte: 1..127 = seconds, bit 7 set = minutes
function wxmBeaconPeriod(code) { return code & 0x80 ? (code & 0x7f) * 60 : code; }

function wxmBeaconDecodeFrameBytes(frame) {
  if (typeof decodeUplink !== "function") return undefined;
  var r = decodeUplink({ bytes: frame, fPort: 99 });
  return r && r.data ? r.data : undefined;
}

// Fields of the info packet (also the first 27 bytes of the long-range packet)
function wxmBeaconDecodeInfoBody(b) {
  var unix = wxmBeaconU32(b, 17);
  var out = {
    utc_aligned: (b[0] & 0x01) !== 0,           // bursts start when unix_time % period_s == 0
    period_s: wxmBeaconPeriod(b[1]),
    dev_eui: wxmBeaconHex(b, 2, 10).toUpperCase(),
    name_suffix: wxmBeaconHex(b, 7, 10).toUpperCase(), // as in the Bluetooth name "WeatherXM WS2001 <suffix>"
    firmware_version: (b[10] >> 4) + "." + (b[10] & 0x0f),
    network_profile: b[11] === 0 ? "weatherxm" : "custom",
    tx_power_dbm: b[12] > 127 ? b[12] - 256 : b[12],
    burst_offset_ms: wxmBeaconU16(b, 13),       // this packet was sent this long after the burst started
    uptime_min: wxmBeaconU16(b, 15),            // minutes since the station booted (stops at 65535)
    unix_time: unix === 0 ? null : unix         // Unix time of the burst, null if the station has no clock
  };
  if (b.length >= 27) {
    var rate = wxmBeaconU16(b, 21);
    var total = wxmBeaconU32(b, 23);
    out.rain_rate = rate === 0xffff ? null : rate / 10;            // mm/h, latest 12-second reading
    out.rain_total = total === 0x7fffffff ? null : total / 1000;   // mm, lifetime counter
  }
  return out;
}

// Manufacturer data: the bytes after the company identifier (0xFFFF). Returns null if it is not a WS2001 beacon.
function wxmBeaconDecodeManufacturerData(bytes) {
  if (!bytes || bytes.length < 1 || (bytes[0] >> 4) !== WXM_BEACON_FORMAT_VERSION) return null;
  var type = (bytes[0] >> 2) & 0x03;
  var out, frame, data;

  if (type === 0) {                              // frame packet: 3-byte header + weather frame
    if (bytes.length < 3 + 16) return null;
    frame = Array.prototype.slice.call(bytes, 3);
    out = {
      packet: "frame",
      utc_aligned: (bytes[0] & 0x01) !== 0,
      stale: (bytes[0] & 0x02) !== 0,            // the frame is older than two upload intervals
      frame_counter: bytes[1],                   // +1 for every new frame (wraps at 255)
      period_s: wxmBeaconPeriod(bytes[2]),
      frame: frame,
      frame_hex: wxmBeaconHex(frame, 0, frame.length)
    };
    data = wxmBeaconDecodeFrameBytes(frame);
    if (data !== undefined) out.data = data;
    return out;
  }

  if (type === 1) {                              // info packet
    if (bytes.length < 21) return null;
    out = wxmBeaconDecodeInfoBody(bytes);
    out.packet = "info";
    return out;
  }

  if (type === 2) {                              // long-range packet: info body, frame counter, length, frame
    if (bytes.length < 29) return null;
    out = wxmBeaconDecodeInfoBody(Array.prototype.slice.call(bytes, 0, 27));
    out.packet = "long_range";
    out.stale = (bytes[0] & 0x02) !== 0;
    out.frame_counter = bytes[27];
    frame = Array.prototype.slice.call(bytes, 29, 29 + bytes[28]);
    if (frame.length !== bytes[28]) return null;
    out.frame = frame;                           // empty until the station has built its first frame
    out.frame_hex = wxmBeaconHex(frame, 0, frame.length);
    if (frame.length > 0) {
      data = wxmBeaconDecodeFrameBytes(frame);
      if (data !== undefined) out.data = data;
    }
    return out;
  }

  return null;
}

// BTHome v2 service data: the bytes after the service UUID (0xFCD2). Returns null unless BTHome v2, not encrypted.
// A measurement the sensor cannot give is left out of the packet, so check that a field is present.
function wxmBeaconDecodeBthome(bytes) {
  if (!bytes || bytes.length < 1 || (bytes[0] >> 5) !== 2 || (bytes[0] & 0x01) !== 0) return null;
  // object id: [byte length, field, factor]
  var objects = {
    0x00: [1, "packet_id", 1],
    0x02: [2, "temperature", 0.01],        // C (signed)
    0x04: [3, "pressure", 0.01],           // hPa
    0x05: [3, "illuminance", 0.01],        // lux
    0x15: [1, "battery_low", 1],           // true = low
    0x2e: [1, "humidity", 1],              // %RH
    0x44: [2, "speed", 0.01],              // m/s: first = wind speed, second = wind gust
    0x46: [1, "uv_index", 0.1],
    0x50: [4, "timestamp", 1],             // Unix time, only when the station has a clock
    0x5e: [2, "wind_direction", 0.01],     // degrees
    0x5f: [2, "rain_accumulated", 0.1],    // mm, rolling counter that wraps at 6553.5
    0xf2: [3, "firmware_version", 1]
  };
  var out = { packet: "bthome" };
  var speeds = [];
  var i = 1;
  while (i < bytes.length) {
    var spec = objects[bytes[i]];
    if (!spec || i + 1 + spec[0] > bytes.length) break;  // BTHome receivers stop at an object they do not know
    var raw = 0;
    for (var k = spec[0] - 1; k >= 0; k--) raw = raw * 256 + bytes[i + 1 + k];
    if (bytes[i] === 0x02 && raw >= 0x8000) raw -= 0x10000;
    var value = spec[2] === 1 ? raw : Math.round(raw * spec[2] * 100) / 100;
    if (bytes[i] === 0x44) speeds.push(value);
    else if (bytes[i] === 0xf2) out[spec[1]] = ((raw >> 16) & 0xff) + "." + ((raw >> 8) & 0xff) + "." + (raw & 0xff);
    else if (bytes[i] === 0x15) out[spec[1]] = raw !== 0;
    else out[spec[1]] = value;
    i += 1 + spec[0];
  }
  if (speeds.length >= 1) out.wind_speed = speeds[0];    // mean of the latest 12 seconds
  if (speeds.length >= 2) out.wind_gust = speeds[1];     // peak of the latest 12 seconds
  return out;
}

// Milliseconds from the moment an info (or long-range) packet was heard until the next burst starts.
// Each packet is repeated with the same content about 110 ms apart, so the repeat that was heard may be up to
// (repeat - 1) * 110 ms later than burst_offset_ms says (220 ms with the default of 3 repeats): wake up that much
// earlier, plus a margin for the clocks (a station measured at about 100 ppm is 6 ms off after 60 s).
function wxmBeaconMsToNextBurst(info, msSinceHeard) {
  var period = info.period_s * 1000;
  if (!(period > 0)) return 0;
  var sinceStart = info.burst_offset_ms + (msSinceHeard || 0);
  return period - (sinceStart % period);
}

// Node.js / bundlers
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    WXM_BEACON_COMPANY_ID: WXM_BEACON_COMPANY_ID,
    WXM_BEACON_BTHOME_UUID16: WXM_BEACON_BTHOME_UUID16,
    wxmBeaconDecodeManufacturerData: wxmBeaconDecodeManufacturerData,
    wxmBeaconDecodeBthome: wxmBeaconDecodeBthome,
    wxmBeaconMsToNextBurst: wxmBeaconMsToNextBurst,
    wxmBeaconPeriod: wxmBeaconPeriod
  };
}
