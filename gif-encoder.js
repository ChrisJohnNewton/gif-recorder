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

    // Reuse the per-frame palette-index buffer instead of allocating one for
    // every frame. addFrame() is synchronous, so it is safe to overwrite once
    // the compressed frame data has been appended to parts.
    this.indexedFrame = new Uint8Array(width * height);

    // LZW dictionary keys are (prefixCode << 8) | paletteIndex, so the key
    // space is only 20 bits. Direct typed-array lookup is much cheaper than a
    // Map in the per-pixel hot loop. Epochs make dictionary clears O(1).
    this.lzwCodes = new Uint16Array(1 << 20);
    this.lzwEpochs = new Uint32Array(1 << 20);
    this.lzwEpoch = 0;

    // Every frame uses the same control extension and full-frame image
    // descriptor, so build those 19 bytes once instead of creating many tiny
    // typed arrays for every frame.
    this.framePrefix = this._buildFramePrefix();

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

  _buildFramePrefix() {
    const prefix = new Uint8Array(19);
    prefix[0] = 0x21;
    prefix[1] = 0xf9;
    prefix[2] = 0x04;
    prefix[3] = 0x04;
    prefix[4] = this.delayCs & 0xff;
    prefix[5] = (this.delayCs >> 8) & 0xff;
    // prefix[6..7]: no transparency + extension terminator.
    prefix[8] = 0x2c;
    // prefix[9..12]: left/top are both zero.
    prefix[13] = this.width & 0xff;
    prefix[14] = (this.width >> 8) & 0xff;
    prefix[15] = this.height & 0xff;
    prefix[16] = (this.height >> 8) & 0xff;
    // prefix[17]: no local color table.
    prefix[18] = 0x08; // LZW minimum code size for the 8-bit palette.
    return prefix;
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

    const indexed = this.indexedFrame;
    for (let src = 0, dst = 0; dst < indexed.length; src += 4, dst++) {
      indexed[dst] =
        (rgba[src] & 0xe0) |
        ((rgba[src + 1] & 0xe0) >> 3) |
        (rgba[src + 2] >> 6);
    }

    this.parts.push(this.framePrefix);
    this.parts.push(this._lzw(indexed, 8));
    this.frameCount++;
  }

  _lzw(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;

    // A code stream cannot contain more than one code per input index, plus
    // dictionary clears and the clear/end codes. Allocate one typed buffer up
    // front, write GIF sub-blocks directly into it, then trim it before storing
    // so highly-compressible frames do not retain the larger scratch buffer.
    const dictionaryCapacity = 4096 - (endCode + 1);
    const maxCodes =
      indices.length + Math.ceil(indices.length / dictionaryCapacity) + 2;
    const maxDataBytes = Math.ceil((maxCodes * 12) / 8) + 1;
    const output = new Uint8Array(
      maxDataBytes + Math.ceil(maxDataBytes / 255) + 2
    );

    let outputPos = 1;
    let blockHeaderPos = 0;
    let blockSize = 0;
    let currentByte = 0;
    let bitsInCurrentByte = 0;

    const writeByte = (value) => {
      if (blockSize === 255) {
        output[blockHeaderPos] = 255;
        blockHeaderPos = outputPos++;
        blockSize = 0;
      }
      output[outputPos++] = value;
      blockSize++;
    };

    const writeCode = (code, size) => {
      let remaining = size;
      let value = code;
      while (remaining > 0) {
        const available = 8 - bitsInCurrentByte;
        const take = available < remaining ? available : remaining;
        currentByte |=
          (value & ((1 << take) - 1)) << bitsInCurrentByte;
        bitsInCurrentByte += take;
        value >>= take;
        remaining -= take;

        if (bitsInCurrentByte === 8) {
          writeByte(currentByte);
          currentByte = 0;
          bitsInCurrentByte = 0;
        }
      }
    };

    const dictionaryCodes = this.lzwCodes;
    const dictionaryEpochs = this.lzwEpochs;
    let epoch = this.lzwEpoch;
    let nextCode;
    let codeSize;

    const resetDictionary = () => {
      epoch = (epoch + 1) >>> 0;
      if (epoch === 0) {
        // Practically unreachable, but keeps epoch 0 reserved for "unused".
        dictionaryEpochs.fill(0);
        epoch = 1;
      }
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

        if (dictionaryEpochs[key] === epoch) {
          prefix = dictionaryCodes[key];
          continue;
        }

        writeCode(prefix, codeSize);

        if (nextCode < 4096) {
          dictionaryEpochs[key] = epoch;
          dictionaryCodes[key] = nextCode++;
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
      writeByte(currentByte);
    }

    output[blockHeaderPos] = blockSize;
    output[outputPos++] = 0x00;
    this.lzwEpoch = epoch;

    return output.slice(0, outputPos);
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
