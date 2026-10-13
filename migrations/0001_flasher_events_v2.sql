-- Detailed flasher telemetry table. The worker also creates it on first use (src/worker/index.ts,
-- SCHEMA_STATEMENTS), keep both in sync. The original flasher_events table is kept as a legacy log.
-- Apply manually: npx wrangler d1 execute flasher-telemetry --remote --file migrations/0001_flasher_events_v2.sql
CREATE TABLE IF NOT EXISTS flasher_events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  device_type TEXT NOT NULL,
  serial_number TEXT,        -- WS2001: DevEUI, 16 uppercase hex chars
  action TEXT NOT NULL,      -- connected | flash_* (firmware) | network_switch_* (WS2001 network move)
  target TEXT,               -- firmware version, or network for network_switch_*
  source TEXT,               -- firmware version before the operation
  status TEXT NOT NULL,      -- success | failed | in_progress
  network TEXT,              -- network_switch_*: 'open_lorawan' | 'weatherxm'
  from_network TEXT,         -- network active before the switch
  keys_kept INTEGER,         -- 1: WeatherXM keys still on the station (V4.5+), 0: overwritten
  wxm_join_eui TEXT,         -- WeatherXM JoinEUI, when known
  firmware_version TEXT,
  details TEXT,              -- full JSON payload
  user_agent TEXT,
  country TEXT
);
CREATE INDEX IF NOT EXISTS idx_flasher_events_v2_device ON flasher_events_v2 (device_type, serial_number, id);
CREATE INDEX IF NOT EXISTS idx_flasher_events_v2_action ON flasher_events_v2 (action, status);
