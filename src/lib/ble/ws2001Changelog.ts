/**
 * WS2001 (H2) firmware release notes, newest first. Shown on /ws2001/changelog and, for the version picked under
 * "Other versions", in the firmware panel of /ws2001.
 *
 * Every release in public/firmware/ws2001/manifest.json needs an entry here (a test checks it). Whether a release is
 * the default or opt-in comes from the manifest ("latest", latest_pinned), not from this file.
 */

export interface Ws2001ChangelogEntry {
  version: string; // "5.1", as in the manifest
  date: string; // build date, YYYY-MM-DD
  summary: string; // one sentence: what the release is for
  changes: { title: string; detail: string }[];
  upgradeNote?: string; // what to do before or after installing it
}

export const WS2001_CHANGELOG: Ws2001ChangelogEntry[] = [
  {
    version: '5.1',
    date: '2026-10-22',
    summary: 'Adds how steady the wind direction was to the Open Edition uplink.',
    changes: [
      {
        title: 'Wind direction variability',
        detail:
          'The Open Edition weather frame grows from 16 to 20 bytes. Next to the mean direction it now carries the ' +
          'spread of the direction (σθ, in degrees), the range the wind actually blew from (the narrowest arc ' +
          'holding 90 % of the 12-second readings) and the direction of the strongest gust. A mean alone can hide ' +
          'wind that switches between two directions; these values show it.',
      },
      {
        title: 'Mean direction unchanged',
        detail:
          'The mean wind direction is computed as in V4.10: the vector mean of the 12-second readings at 0.5 m/s ' +
          'or more. The WeatherXM network frame is unchanged.',
      },
      {
        title: 'Not available in calm air',
        detail:
          'The spread and range need at least 5 readings at 0.5 m/s or more in the interval; otherwise they decode ' +
          'as null. The gust direction needs a gust of at least 0.5 m/s.',
      },
      {
        title: 'Airtime',
        detail:
          'A 20-byte uplink takes about 72 ms at SF7, against 67 ms for the 16-byte frame: about 21 s a day at a ' +
          '5-minute interval, within The Things Network\'s 30 s fair-use limit. Both stay within the EU868 1 % duty ' +
          'cycle at a 3-minute interval.',
      },
      {
        title: 'Version number',
        detail: 'V5.0 is skipped: V4.10 already uses update number 50, so the release after it is V5.1 (51).',
      },
    ],
    upgradeNote:
      'On your own network, install the latest payload decoder before updating: it reads both the 16-byte (V4.10) and ' +
      'the 20-byte (V5.1) frame, while decoders from before V5.1 reject the longer frame.',
  },
  {
    version: '4.10',
    date: '2026-10-22',
    summary: 'Fixes pressure readings after a sensor restart and keeps the rain total across restarts.',
    changes: [
      {
        title: 'Pressure',
        detail:
          'For about 30 seconds after the sensor head restarts, its barometer reports 0 hPa. Those readings are now ' +
          'left out of the interval average; before, they pulled the reported pressure down, in the worst case to ' +
          'about half of the real value.',
      },
      {
        title: 'Rain total kept across restarts',
        detail:
          'The rain total is saved before every planned restart (the end of a Bluetooth session, a short button ' +
          'press, a restart command or downlink), not only every 3 minutes, so rain counted just before a restart ' +
          'is no longer lost.',
      },
      {
        title: 'Rain total recovery',
        detail:
          'After a sensor read error the rain total recovers instead of staying invalid, and a factory reset now ' +
          'clears it completely.',
      },
      {
        title: 'Payload',
        detail: 'Same 16-byte Open Edition frame as V4.9 on your own network; the payload decoder reports a pressure of 0 as null.',
      },
    ],
  },
];

export function ws2001ChangelogFor(version: string | null | undefined): Ws2001ChangelogEntry | null {
  return WS2001_CHANGELOG.find((e) => e.version === version) ?? null;
}
