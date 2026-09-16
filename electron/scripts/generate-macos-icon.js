import fs from 'node:fs/promises';
import sharp from 'sharp';

const assetsDir = 'electron/assets';

// Rounded corner radius as a fraction of the icon side length (macOS-style ~22%).
const CORNER_RADIUS = 0.22;

function renderSvg(entrySize) {
  const scale = entrySize / 32;
  const radius = CORNER_RADIUS * entrySize;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${entrySize}" height="${entrySize}" viewBox="0 0 ${entrySize} ${entrySize}">
  <rect width="${entrySize}" height="${entrySize}" rx="${radius}" fill="#2563eb"/>
  <path
    d="M${8 * scale} ${9 * scale}C${8 * scale} ${8.44772 * scale} ${8.44772 * scale} ${8 * scale} ${9 * scale} ${8 * scale}H${23 * scale}C${23.5523 * scale} ${8 * scale} ${24 * scale} ${8.44772 * scale} ${24 * scale} ${9 * scale}V${18 * scale}C${24 * scale} ${18.5523 * scale} ${23.5523 * scale} ${19 * scale} ${23 * scale} ${19 * scale}H${12 * scale}L${8 * scale} ${23 * scale}V${9 * scale}Z"
    stroke="white"
    stroke-width="${2 * scale}"
    stroke-linecap="round"
    stroke-linejoin="round"
    fill="none"
  />
</svg>`;
}

function renderPng(entrySize) {
  return sharp(Buffer.from(renderSvg(entrySize)))
    .png()
    .toBuffer();
}

async function buildIcns() {
  const iconPath = `${assetsDir}/logo-macos.png`;
  const icnsPath = `${assetsDir}/logo-macos.icns`;
  const size = 1024;

  await fs.writeFile(iconPath, await renderPng(size));

  const icnsEntries = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];

  const blocks = await Promise.all(icnsEntries.map(async ([type, entrySize]) => {
    const png = await renderPng(entrySize);
    const block = Buffer.alloc(8 + png.length);
    block.write(type, 0, 4, 'ascii');
    block.writeUInt32BE(block.length, 4);
    png.copy(block, 8);
    return block;
  }));

  const totalLength = 8 + blocks.reduce((sum, block) => sum + block.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(totalLength, 4);

  await fs.writeFile(icnsPath, Buffer.concat([header, ...blocks], totalLength));
}

async function buildLinuxPng() {
  const iconPath = `${assetsDir}/logo-linux.png`;
  const size = 512;
  await fs.writeFile(iconPath, await renderPng(size));
}

async function buildWindowsIco() {
  const iconPath = `${assetsDir}/logo-windows.ico`;
  const sizes = [16, 24, 32, 48, 64, 128, 256];

  const images = await Promise.all(sizes.map((size) => renderPng(size)));

  // ICONDIR (6 bytes): reserved (0), type (1), count
  const count = images.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(count, 4);

  // ICONDIRENTRY is 16 bytes each.
  const entriesSize = count * 16;
  const imageOffset = 6 + entriesSize;

  const entries = Buffer.alloc(entriesSize);
  let offset = imageOffset;
  images.forEach((png, i) => {
    const entry = entries.subarray(i * 16, i * 16 + 16);
    const size = sizes[i];
    // Width/height byte: 0 means 256.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(png.length, 8); // bytes in resource
    entry.writeUInt32LE(offset, 12); // image offset
    offset += png.length;
  });

  await fs.writeFile(iconPath, Buffer.concat([dir, entries, ...images]));
}

await fs.mkdir(assetsDir, { recursive: true });
await buildIcns();
await buildLinuxPng();
await buildWindowsIco();

console.log('Generated rounded icons: logo-macos.png, logo-macos.icns, logo-linux.png, logo-windows.ico');
