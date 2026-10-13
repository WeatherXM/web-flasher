-- WS2001 (H2) network state per station, from the flasher telemetry in D1 (flasher-telemetry / flasher_events_v2,
-- the older flasher_events table is a legacy log of early test events and is not used here).
-- Used by the WeatherXM backend to unprovision stations from its LNS (Helium ChirpStack / LoneStar) when they move
-- to the customer's own network, and to provision them again when they come back.
--
-- Run (needs Cloudflare access to the account, DevEUIs are not exposed by any public endpoint):
--   npx wrangler d1 execute flasher-telemetry --remote --file scripts/sql/ws2001-network-state.sql
--
-- Events (device_type = 'ws2001', serial_number = DevEUI, 16 uppercase hex chars):
--   network_switch_started / _completed / _failed   network = 'open_lorawan' | 'weatherxm'
--   flash_*                                          firmware updates only (target = 'V4.7', ...): ignore here
--   connected                                        details.netProfile = active profile (0 WeatherXM, 1 own network)
-- Columns of network_switch_*: keys_kept (WeatherXM keys still on the station), wxm_join_eui, from_network,
-- firmware_version. details (JSON) also has band, subBand, intervalMinutes, gnss.

-- 1. Current network of every station that was ever switched with the flasher (last successful switch wins).
SELECT
  e.serial_number                               AS dev_eui,
  e.network,                                    -- 'open_lorawan' -> unprovision, 'weatherxm' -> provision
  e.created_at       AS switched_at,
  e.keys_kept,                                  -- 0: WeatherXM keys were overwritten (pre-V4.5)
  e.wxm_join_eui,
  e.firmware_version
FROM flasher_events_v2 e
WHERE e.device_type = 'ws2001'
  AND e.action = 'network_switch_completed'
  AND e.status = 'success'
  AND e.id = (
    SELECT max(x.id) FROM flasher_events_v2 x
    WHERE x.device_type = 'ws2001' AND x.action = 'network_switch_completed' AND x.status = 'success'
      AND x.serial_number = e.serial_number
  )
ORDER BY e.created_at DESC;

-- 2. Stations whose last switch was to their own network but that later connected to the flasher with the
--    WeatherXM profile active again (factory reset or AT+RESTORE, which log no switch event). Provision these again.
SELECT
  s.serial_number AS dev_eui,
  s.created_at    AS switched_to_open_at,
  c.created_at    AS seen_on_weatherxm_at
FROM flasher_events_v2 s
JOIN flasher_events_v2 c
  ON c.serial_number = s.serial_number
 AND c.device_type = 'ws2001'
 AND c.action = 'connected'
 AND c.id > s.id
 AND json_extract(c.details, '$.netProfile') = 0
WHERE s.device_type = 'ws2001'
  AND s.action = 'network_switch_completed'
  AND s.status = 'success'
  AND s.network = 'open_lorawan'
  AND s.id = (
    SELECT max(x.id) FROM flasher_events_v2 x
    WHERE x.device_type = 'ws2001' AND x.action = 'network_switch_completed' AND x.status = 'success'
      AND x.serial_number = s.serial_number
  )
GROUP BY s.serial_number;
