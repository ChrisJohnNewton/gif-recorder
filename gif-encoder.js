/*
 * Small dependency-free GIF89a encoder using a fixed 3-3-2 RGB palette.
 * This keeps the extension self-contained and avoids remote code/CSP issues.
 */
class GifEncoder {
  constructor(width, height, fps = 8) {
    this.width = width;
    this.height = height;
    this.delayCs = Math.max(2, Math.round(100 / fps));
    this.parts = [];
    this.frameCount = 0;
    this.finished = false;
    this._writeHeader();
  }

  _bytes(...values) {
    this.parts.push(Uint8Array.from(values));
  }

  _ascii(text) {
    this.parts.push(Uint8Array.from([...text].map((ch) => ch.charCodeAt(0))));
  }

  _u16(value) {
    this._bytes(value & 0xff, (value >> 8) & 0xff);
  }

  _writeHeader() {
    this._ascii('GIF89a');
    this._u16(this.width);
    this._u16(this.height);

    // Global color table present, 8-bit color resolution, 256 table entries.
    this._bytes(0xf7, 0x00, 0x00);

    // 256-color fixed palette: 3 bits red, 3 bits green, 2 bits blue.
    const palette = new Uint8Array(256 * 3);
    let p = 0;
    for (let i = 0; i < 256; i++) {
      const r = (i >> 5) & 0x07;
      const g = (i >> 2) & 0x07;
      const b = i & 0x03;
      palette[p++] = Math.round((r * 255) / 7);
      palette[p++] = Math.round((g * 255) / 7);
      palette[p++] = Math.round((b * 255) / 3);
    }
    this.parts.push(palette);

    // Loop forever (NETSCAPE application extension).
    this._bytes(0x21, 0xff, 0x0b);
    this._ascii('NETSCAPE2.0');
    this._bytes(0x03, 0x01, 0x00, 0x00, 0x00);
  }

  addFrame(rgba) {
    if (this.finished) throw new Error('GIF encoder is already finished.');
    if (rgba.length !== this.width * this.height * 4) {
      throw new Error('Frame size does not match GIF dimensions.');
    }

    const indexed = new Uint8Array(this.width * this.height);
    for (let src = 0, dst = 0; src < rgba.length; src += 4, dst++) {
      indexed[dst] =
        ((rgba[src] >> 5) << 5) |
        ((rgba[src + 1] >> 5) << 2) |
        (rgba[src + 2] >> 6);
    }

    // Graphics Control Extension: keep previous frame, no transparency.
    this._bytes(0x21, 0xf9, 0x04, 0x04);
    this._u16(this.delayCs);
    this._bytes(0x00, 0x00);

    // Image Descriptor: full-frame image, no local color table.
    this._bytes(0x2c);
    this._u16(0);
    this._u16(0);
    this._u16(this.width);
    this._u16(this.height);
    this._bytes(0x00);

    // 8-bit palette => LZW minimum code size is 8.
    this._bytes(0x08);
    this.parts.push(this._lzw(indexed, 8));
    this.frameCount++;
  }

  _lzw(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;

    const outputBytes = [];
    let currentByte = 0;
    let bitsInCurrentByte = 0;

    const writeCode = (code, size) => {
      let remaining = size;
      let value = code;
      while (remaining > 0) {
        const available = 8 - bitsInCurrentByte;
        const take = Math.min(available, remaining);
        currentByte |= (value & ((1 << take) - 1)) << bitsInCurrentByte;
        bitsInCurrentByte += take;
        value >>= take;
        remaining -= take;

        if (bitsInCurrentByte === 8) {
          outputBytes.push(currentByte);
          currentByte = 0;
          bitsInCurrentByte = 0;
        }
      }
    };

    let dictionary;
    let nextCode;
    let codeSize;

    const resetDictionary = () => {
      dictionary = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    };

    resetDictionary();
    writeCode(clearCode, codeSize);

    if (indices.length > 0) {
      let prefix = indices[0];

      for (let i = 1; i < indices.length; i++) {
        const value = indices[i];
        const key = (prefix << 8) | value;
        const known = dictionary.get(key);

        if (known !== undefined) {
          prefix = known;
          continue;
        }

        writeCode(prefix, codeSize);

        if (nextCode < 4096) {
          dictionary.set(key, nextCode++);
          if (nextCode > (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
        } else {
          writeCode(clearCode, codeSize);
          resetDictionary();
        }

        prefix = value;
      }

      writeCode(prefix, codeSize);
    }

    writeCode(endCode, codeSize);

    if (bitsInCurrentByte > 0) {
      outputBytes.push(currentByte);
    }

    // GIF image data is split into sub-blocks of at most 255 bytes.
    const blocks = [];
    for (let offset = 0; offset < outputBytes.length; offset += 255) {
      const size = Math.min(255, outputBytes.length - offset);
      blocks.push(size, ...outputBytes.slice(offset, offset + size));
    }
    blocks.push(0x00);
    return Uint8Array.from(blocks);
  }

  finish() {
    if (!this.finished) {
      this._bytes(0x3b); // GIF trailer
      this.finished = true;
    }
    return new Blob(this.parts, { type: 'image/gif' });
  }
}

self.GifEncoder = GifEncoder;
