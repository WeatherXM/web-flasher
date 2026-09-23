export interface BootLogAnalysis {
  lines: string[];
  rawText: string;
  detectedSign: 'weatherxm' | 'meshtastic' | 'booting' | 'none';
}

/**
 * Sanitizes log output so no accidentally logged keys, NVS dumps, or certificates can leak.
 */
export function sanitizeLog(text: string): string {
  return text
    .replace(/(?:[0-9a-fA-F]{64})/g, '[REDACTED_64_HEX]')
    .replace(/(?:-----BEGIN [A-Z0-9\s]+-----[\s\S]+?-----END [A-Z0-9\s]+-----)/g, '[REDACTED_CERTIFICATE]')
    .replace(/(?:wifi_password|pass|secret|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

/**
 * Reopens serial port at 115200 baud to capture post-flash boot messages.
 */
export async function captureBootLogs(
  port: any,
  durationMs = 12000,
  onLine?: (line: string) => void
): Promise<BootLogAnalysis> {
  const lines: string[] = [];
  let detectedSign: 'weatherxm' | 'meshtastic' | 'booting' | 'none' = 'none';

  if (!port || !port.readable) {
    return { lines: ['Serial port unavailable for boot log capture.'], rawText: '', detectedSign: 'none' };
  }

  try {
    if (!port.readable) {
      await port.open({ baudRate: 115200 });
    }

    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();

    let buffer = '';
    const startTime = Date.now();

    while (Date.now() - startTime < durationMs) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ value?: string; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: true }), Math.max(100, durationMs - (Date.now() - startTime)))
      );

      const res = await Promise.race([readPromise, timeoutPromise]);
      if (res.done) break;

      if (res.value) {
        buffer += res.value;
        const splitLines = buffer.split('\n');
        buffer = splitLines.pop() ?? '';

        for (const rawLine of splitLines) {
          const cleanLine = sanitizeLog(rawLine.trim());
          if (cleanLine.length > 0) {
            lines.push(cleanLine);
            if (onLine) onLine(cleanLine);

            const lower = cleanLine.toLowerCase();
            if (lower.includes('weatherxm') || lower.includes('thingsboard') || lower.includes('main: app')) {
              detectedSign = 'weatherxm';
            } else if (lower.includes('meshtastic') || lower.includes('lora') || lower.includes('sx1262')) {
              detectedSign = 'meshtastic';
            } else if (lower.includes('esp-idf') || lower.includes('boot:')) {
              if (detectedSign === 'none') detectedSign = 'booting';
            }
          }
        }
      }
    }

    try {
      await reader.cancel();
      await readableStreamClosed.catch(() => {});
      await port.close();
    } catch (e) {
      // Ignore close errors
    }
  } catch (err: any) {
    lines.push(`[Log capture completed or port closed: ${err.message ?? err}]`);
  }

  const rawText = lines.join('\n');
  return {
    lines,
    rawText,
    detectedSign,
  };
}

/**
 * Triggers a browser download of the technical log as a .txt file.
 */
export function downloadLogFile(lines: string[], filename = 'wg1200_flasher_log.txt'): void {
  const content = sanitizeLog(lines.join('\n'));
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
