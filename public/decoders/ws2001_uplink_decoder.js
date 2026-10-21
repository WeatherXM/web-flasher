// WeatherXM WS2001 / WS2000 uplink decoder (WeatherXM firmware V3.x - V4.9+)
//
// Paste this whole file as-is into:
//   - The Things Stack v3:  Application > Payload formatters > Uplink > Custom JavaScript
//   - ChirpStack v4:        Device profile > Codec > JavaScript functions
//   - ChirpStack v3:        Device profile > Codec > Custom JavaScript (uses Decode() below)
//
// Frames on FPort 99 (AT+TESTMODE_TYPE=0, the default):
//   16-byte Open Edition weather frame (AT+NETPROFILE=1, V4.9+)
//   0xF0  24-byte WeatherXM weather frame (AT+NETPROFILE=0, 1 Helium data credit)
//   0xF1  same, followed by a 64-byte ECDSA P-256 signature from the station's secure element
//   0xF2  12-byte boot frame (firmware/hardware version, sensor protocol version)
//   0xF3  GNSS scan (raw LR1110 NAV message; resolve with a GNSS solver)
// Frames on FPort 3 (legacy "Open LoRaWAN" TLV, AT+TESTMODE_TYPE=1) are decoded too.
// FPort 199 carries LoRa Basics Modem service messages (time sync for GNSS, device
// management); they hold no weather data and are returned as { frame: "modem_service" }.
//
// Source of truth: ws2001-firmware/tools/decoders/ws2001_uplink_decoder.js
// (byte layout: application/smtc_board/bsp/peripherals/ccl_sensor/sensor_data.c)

function wxmHex(bytes, start, end) {
  var s = "";
  for (var i = start; i < end && i < bytes.length; i++) {
    s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  }
  return s;
}

function wxmU16le(b, i) { return b[i] | (b[i + 1] << 8); }
function wxmU24le(b, i) { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16); }
function wxmU32le(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

function wxmDecodeOpenWeather(bytes) {
  var data = { frame: "weather" };

  var hd = (bytes[0] << 8) | bytes[1];
  data.humidity = (hd >> 9) === 0x7f ? null : hd >> 9;                                     // %RH
  data.wind_direction = (hd & 0x1ff) === 0x1ff ? null : hd & 0x1ff;                        // degrees

  var t = wxmU16le(bytes, 2);
  data.temperature = t === 0x7fff ? null : (t & 0x8000 ? t - 0x10000 : t) / 10;            // °C

  var buw = (bytes[4] << 8) | bytes[5];
  data.battery_low = (buw & 0x8000) !== 0;
  var uv = (buw >> 11) & 0x0f;
  data.uv_index = uv === 0x0f ? null : uv;
  data.wind_speed = (buw & 0x7ff) === 0x7ff ? null : (buw & 0x7ff) / 10;                   // m/s, mean of 12 s averages

  var g = wxmU16le(bytes, 6);
  data.wind_gust = g === 0xffff ? null : g / 10;                                           // m/s, max of 12 s peaks

  var r = wxmU16le(bytes, 8);
  data.rain_accumulated = r === 0xffff ? null : r / 10;                                    // mm, 0.1 mm rolling counter

  var rr = wxmU16le(bytes, 10);
  data.rain_rate = rr === 0xffff ? null : rr / 10;                                         // mm/h, max over the interval

  var lx = wxmU16le(bytes, 12);
  data.lux = lx === 0xffff ? null : lx * 10;                                               // lux (10 lux steps)

  var p = wxmU16le(bytes, 14);
  data.pressure = p === 0xffff ? null : p / 10;                                            // hPa

  return { data: data };
}

function wxmDecodeWeatherXM(bytes) {
  var data = {};
  var tag = bytes[0];
  if (tag !== 0xf0 && tag !== 0xf1 && tag !== 0xf2 && tag !== 0xf3) {
    if (bytes.length === 16) return wxmDecodeOpenWeather(bytes);
    return { errors: ["unknown frame tag 0x" + wxmHex(bytes, 0, 1)] };
  }
  if (bytes.length < 3) return { errors: ["frame too short"] };
  data.firmware_version = (bytes[1] >> 4) + "." + (bytes[1] & 0x0f);
  var hw = (bytes[2] >> 5) & 0x07;
  data.hardware_version = hw > 0 ? "1." + (hw - 1) : "unknown";
  data.tx_power = bytes[2] & 0x1f;

  if (tag === 0xf2) {
    data.frame = "boot";
    if (bytes.length >= 12) {
      data.boot_nonce = wxmHex(bytes, 3, 11);
      data.sensor_protocol_version = bytes[11];
    }
    return { data: data };
  }
  if (tag === 0xf3) {
    return { data: { frame: "gnss_scan", gnss_status: bytes[1], gnss_length: bytes[2], gnss_raw: wxmHex(bytes, 3, bytes.length) } };
  }
  if (bytes.length < 24) return { errors: ["weather frame must be 24 bytes, got " + bytes.length] };

  data.frame = tag === 0xf1 ? "weather_signed" : "weather";
  data.upload_interval_min = bytes[3] & 0x7f;
  data.battery_low = (bytes[3] & 0x80) !== 0;
  data.samples = bytes[4];

  var t = wxmU16le(bytes, 5);
  data.temperature = t === 0x7fff ? null : (t & 0x8000 ? t - 0x10000 : t) / 10;          // °C

  var hd = (bytes[7] << 8) | bytes[8];
  data.humidity = (hd >> 9) === 0x7f ? null : hd >> 9;                                     // %RH
  data.wind_direction = (hd & 0x1ff) === 0x1ff ? null : hd & 0x1ff;                       // degrees

  var uw = (bytes[9] << 8) | bytes[10];
  data.uv_index = (uw >> 11) === 0x1f ? null : uw >> 11;
  data.wind_speed = (uw & 0x7ff) === 0x7ff ? null : (uw & 0x7ff) / 10;                    // m/s, mean of 12 s averages

  var g = wxmU16le(bytes, 11);
  data.wind_gust = g === 0xffff ? null : g / 10;                                           // m/s, max of 12 s peaks

  var r = wxmU32le(bytes, 13);
  data.rain_accumulated = r === 0x7fffffff ? null : r / 1000;                              // mm, lifetime counter
  data.rain_rate = wxmU16le(bytes, 17) / 10;                                               // mm/h, max over the interval

  var lx = wxmU24le(bytes, 19);
  data.lux = lx === 0x7fffff ? null : lx;

  var p = wxmU16le(bytes, 22);
  data.pressure = p === 0xffff ? null : p / 10;                                            // hPa

  if (tag === 0xf1 && bytes.length >= 88) data.signature = wxmHex(bytes, 24, 88);
  return { data: data };
}

function wxmDecodeLegacyTlv(bytes) {
  var data = {};
  var i = 0;
  while (i < bytes.length) {
    var id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      var rawTemp = (bytes[i] << 8) | bytes[i + 1];
      if (rawTemp & 0x8000) rawTemp -= 0x10000;
      data.temperature = rawTemp / 10;
      data.humidity = bytes[i + 2];
      data.lux = ((bytes[i + 3] << 24) >>> 0) + (bytes[i + 4] << 16) + (bytes[i + 5] << 8) + bytes[i + 6];
      data.uv_index = bytes[i + 7] / 10;
      data.wind_speed = ((bytes[i + 8] << 8) | bytes[i + 9]) / 10;
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      data.wind_direction = (bytes[i] << 8) | bytes[i + 1];
      var rawRain = ((bytes[i + 2] << 24) >>> 0) + (bytes[i + 3] << 16) + (bytes[i + 4] << 8) + bytes[i + 5];
      data.rain_rate = rawRain / 1000;
      var rawPress = (bytes[i + 6] << 8) | bytes[i + 7];
      data.pressure = rawPress / 10;
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      data.battery = bytes[i++];
    } else if (id === 0x04 && i + 9 <= bytes.length) {
      data.battery = bytes[i];
      data.hardware_version = bytes[i + 1] + "." + bytes[i + 2];
      data.firmware_version = bytes[i + 3] + "." + bytes[i + 4];
      data.upload_interval_min = (bytes[i + 5] << 8) | bytes[i + 6];
      data.gps_interval_min = (bytes[i + 7] << 8) | bytes[i + 8];
      i += 9;
    } else if (id === 0x05 && i + 4 <= bytes.length) {
      data.upload_interval_min = (bytes[i] << 8) | bytes[i + 1];
      data.gps_interval_min = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 4;
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      data.sensor_error_code = bytes[i++];
    } else {
      break;
    }
  }
  data.frame = "legacy_tlv";
  return { data: data, warnings: ["Legacy Open LoRaWAN format (no wind gust / rain total). Set AT+TESTMODE_TYPE=0 for the WeatherXM frame."] };
}

function wxmDecode(bytes, fPort) {
  if (fPort === 199) {
    return { data: { frame: "modem_service", raw: wxmHex(bytes || [], 0, bytes ? bytes.length : 0) } };
  }
  if (!bytes || bytes.length === 0) return { data: {} };
  if (fPort === 3) return wxmDecodeLegacyTlv(bytes);
  if (fPort === 99 || bytes[0] === 0xf0 || bytes[0] === 0xf1 || bytes[0] === 0xf2 || bytes[0] === 0xf3) {
    return wxmDecodeWeatherXM(bytes);
  }
  return { data: {}, warnings: ["Unexpected FPort " + fPort + ". WS2001 weather data arrives on FPort 99; use FPort 99 when testing or simulating an uplink."] };
}

// The Things Stack v3 and ChirpStack v4
function decodeUplink(input) {
  return wxmDecode(input.bytes, input.fPort);
}

// ChirpStack v3
function Decode(fPort, bytes, variables) {
  var r = wxmDecode(bytes, fPort);
  return r.data || {};
}
