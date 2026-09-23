import fs from 'fs';
import { execSync } from 'child_process';
import crypto from 'crypto';

const origPath = 'C:/Workspace/WeatherXM-Deep/WG1400/wg1200-firmware/releases/fw_release_0.8.25-g0c2c072-dirty.bin';
const unsignedFixed = 'C:/Workspace/WeatherXM-Deep/WG1400/wg1200-firmware/releases/fw_release_0.8.25_fixed.bin';
const keyPath = 'C:/Workspace/WeatherXM-Deep/WG1400/wg1200-firmware/secrets/wg1200_secure_boot_key.pem';
const targetSigned = 'C:/Workspace/WeatherXM-Deep/web-flasher/public/firmware/weatherxm/wg1200-0.8.25-signed.bin';

const buf = fs.readFileSync(origPath);
const idx = buf.indexOf(Buffer.from([0x32, 0x54, 0xcd, 0xab]));
console.log('Descriptor magic found at:', idx);

// Write '0.8.25' padded with 0s into the 32-byte version slot
const verBuf = Buffer.alloc(32, 0);
verBuf.write('0.8.25', 0, 'utf8');
verBuf.copy(buf, idx + 16);

fs.writeFileSync(unsignedFixed, buf);
console.log('Wrote fixed unsigned binary:', unsignedFixed, 'size:', buf.length);

// Sign with espsecure
const pythonExe = 'C:/Users/MN/.platformio/penv/Scripts/python.exe';
const espsecurePy = 'C:/Users/MN/.platformio/tools/tool-esptoolpy/espsecure.py';
console.log('Signing with Secure Boot V2...');
const signOutput = execSync(`"${pythonExe}" "${espsecurePy}" sign-data --version 2 --keyfile "${keyPath}" --output "${targetSigned}" "${unsignedFixed}"`).toString();
console.log(signOutput);

console.log('Verifying signature...');
const verifyOutput = execSync(`"${pythonExe}" "${espsecurePy}" verify-signature --version 2 --keyfile "${keyPath}" "${targetSigned}"`).toString();
console.log(verifyOutput);

// Clean up temp file
fs.unlinkSync(unsignedFixed);

// Compute new size and sha256
const signedData = fs.readFileSync(targetSigned);
const sha256 = crypto.createHash('sha256').update(signedData).digest('hex');
console.log('New signed size:', signedData.length);
console.log('New SHA-256:', sha256);

// Update manifest.json
const manifestPath = 'C:/Workspace/WeatherXM-Deep/web-flasher/public/firmware/manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.firmwares.weatherxm.size = signedData.length;
manifest.firmwares.weatherxm.sha256 = sha256;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Updated manifest.json with new size and sha256!');
