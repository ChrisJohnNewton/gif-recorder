const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release');
const outputPath = path.join(releaseDir, 'gif-recorder.zip');

const extensionFiles = [
  'manifest.json',
  'background.js',
  'gif-encoder.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.css',
  'popup.js'
];

for (const file of extensionFiles) {
  const filePath = path.join(rootDir, file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing extension file: ${file}`);
  }
}

const iconsDir = path.join(rootDir, 'icons');
if (!fs.existsSync(iconsDir)) {
  throw new Error('Missing extension directory: icons');
}

fs.mkdirSync(releaseDir, { recursive: true });

const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', {
  zlib: { level: 9 }
});

output.on('close', () => {
  const relativePath = path.relative(rootDir, outputPath);
  console.log(`Created ${relativePath} (${archive.pointer()} bytes)`);
});

archive.on('warning', (error) => {
  if (error.code === 'ENOENT') {
    console.warn(error.message);
    return;
  }
  throw error;
});

archive.on('error', (error) => {
  throw error;
});

archive.pipe(output);

for (const file of extensionFiles) {
  archive.file(path.join(rootDir, file), { name: file });
}
archive.directory(iconsDir, 'icons');

archive.finalize();
