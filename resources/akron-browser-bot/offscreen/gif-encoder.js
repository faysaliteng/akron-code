// Minimal, dependency-free GIF89a encoder.
// Fixed palette: 6x6x6 RGB cube (216 colours) + 40-step grey ramp.
// Frames are full-canvas; animation loops forever.
//
// Exposes window.AutobotGif.encode(frames, width, height, delayMs) -> Uint8Array
// where `frames` is an array of ImageData-compatible {data: Uint8ClampedArray}.

(() => {
  const LEVELS = [0, 51, 102, 153, 204, 255];

  function buildPalette() {
    const pal = new Uint8Array(768);
    let i = 0;
    for (let r = 0; r < 6; r++) {
      for (let g = 0; g < 6; g++) {
        for (let b = 0; b < 6; b++) {
          pal[i++] = LEVELS[r];
          pal[i++] = LEVELS[g];
          pal[i++] = LEVELS[b];
        }
      }
    }
    for (let g = 0; g < 40; g++) {
      const v = Math.round((g / 39) * 255);
      pal[i++] = v;
      pal[i++] = v;
      pal[i++] = v;
    }
    return pal;
  }

  const PALETTE = buildPalette();

  function quantize(data) {
    const out = new Uint8Array(data.length / 4);
    for (let p = 0, q = 0; p < data.length; p += 4, q++) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      if (mx - mn < 14) {
        out[q] = 216 + Math.round((((r + g + b) / 3) / 255) * 39);
      } else {
        const r6 = Math.round(r / 51);
        const g6 = Math.round(g / 51);
        const b6 = Math.round(b / 51);
        out[q] = r6 * 36 + g6 * 6 + b6;
      }
    }
    return out;
  }

  // LZW per GIF89a, following the classic omggif ordering.
  function lzwEncode(pixels, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let table = new Map();
    const out = [];
    let bitBuf = 0;
    let bitCnt = 0;

    const emit = (code) => {
      bitBuf |= code << bitCnt;
      bitCnt += codeSize;
      while (bitCnt >= 8) {
        out.push(bitBuf & 0xff);
        bitBuf >>= 8;
        bitCnt -= 8;
      }
    };

    emit(clearCode);
    let ib = pixels[0] & 0xff;

    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i] & 0xff;
      const key = (ib << 8) | k;
      const found = table.get(key);
      if (found !== undefined) {
        ib = found;
        continue;
      }
      emit(ib);
      if (nextCode === 4096) {
        emit(clearCode);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
        table = new Map();
      } else {
        if (nextCode >= 1 << codeSize) codeSize++;
        table.set(key, nextCode++);
      }
      ib = k;
    }

    emit(ib);
    emit(eoiCode);
    if (bitCnt > 0) out.push(bitBuf & 0xff);
    return out;
  }

  function pushSubBlocks(bytes, out) {
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      out.push(chunk.length);
      for (let j = 0; j < chunk.length; j++) out.push(chunk[j]);
    }
    out.push(0);
  }

  function encode(frames, width, height, delayMs = 500) {
    if (!frames.length) throw new Error("No frames to encode.");

    const delay = Math.max(2, Math.round(delayMs / 10)); // 1/100 s units
    const out = [];

    const str = (s) => {
      for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    };
    const u16 = (v) => {
      out.push(v & 0xff, (v >> 8) & 0xff);
    };

    str("GIF89a");
    u16(width);
    u16(height);
    out.push(0xf7); // global colour table, 256 entries
    out.push(0); // background index
    out.push(0); // aspect ratio
    for (let i = 0; i < PALETTE.length; i++) out.push(PALETTE[i]);

    // Netscape loop extension (infinite loop).
    out.push(0x21, 0xff, 0x0b);
    str("NETSCAPE2.0");
    out.push(0x03, 0x01, 0x00, 0x00, 0x00);

    for (const frame of frames) {
      // Graphic control extension.
      out.push(0x21, 0xf9, 0x04, 0x04);
      u16(delay);
      out.push(0x00, 0x00);

      // Image descriptor.
      out.push(0x2c);
      u16(0);
      u16(0);
      u16(width);
      u16(height);
      out.push(0x00);

      const indices = quantize(frame.data);
      const lzw = lzwEncode(indices, 8);
      out.push(8); // LZW minimum code size
      pushSubBlocks(lzw, out);
    }

    out.push(0x3b); // trailer
    return new Uint8Array(out);
  }

  window.AutobotGif = { encode };
})();
