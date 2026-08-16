const WemOgg = (function(){

// ==== wemHeader.js ====
// Part 1/3 — Đọc header RIFF/fmt/vorb của file .wem (port từ wwriff.cpp của ww2ogg)
// Chỉ đọc thông tin, chưa dựng lại Ogg. Test độc lập bằng Node trước khi tích hợp vào web.

function parseWemHeader(buf) {
  const dv = new DataView(buf);
  let littleEndian = true;

  // RIFF hoặc RIFX (big-endian) ở 4 byte đầu
  const riffTag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (riffTag === 'RIFF') littleEndian = true;
  else if (riffTag === 'RIFX') littleEndian = false;
  else throw new Error('Không phải file RIFF/RIFX hợp lệ');

  const read16 = (off) => dv.getUint16(off, littleEndian);
  const read32 = (off) => dv.getUint32(off, littleEndian);

  const riffSize = read32(4) + 8;
  const waveTag = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (waveTag !== 'WAVE') throw new Error('Thiếu tag WAVE');

  let fmtOffset = -1, fmtSize = -1;
  let cueOffset = -1, cueSize = -1;
  let listOffset = -1, listSize = -1;
  let smplOffset = -1, smplSize = -1;
  let vorbOffset = -1, vorbSize = -1;
  let dataOffset = -1, dataSize = -1;

  let chunkOffset = 12;
  while (chunkOffset < riffSize) {
    if (chunkOffset + 8 > riffSize) throw new Error('Chunk header bị cắt cụt');
    const tag = String.fromCharCode(
      dv.getUint8(chunkOffset), dv.getUint8(chunkOffset+1),
      dv.getUint8(chunkOffset+2), dv.getUint8(chunkOffset+3)
    );
    const size = read32(chunkOffset + 4);

    if (tag === 'fmt ') { fmtOffset = chunkOffset + 8; fmtSize = size; }
    else if (tag === 'cue ') { cueOffset = chunkOffset + 8; cueSize = size; }
    else if (tag === 'LIST') { listOffset = chunkOffset + 8; listSize = size; }
    else if (tag === 'smpl') { smplOffset = chunkOffset + 8; smplSize = size; }
    else if (tag === 'vorb') { vorbOffset = chunkOffset + 8; vorbSize = size; }
    else if (tag === 'data') { dataOffset = chunkOffset + 8; dataSize = size; }

    chunkOffset = chunkOffset + 8 + size;
  }

  if (fmtOffset === -1 && dataOffset === -1) throw new Error('Thiếu chunk fmt/data');
  if (vorbOffset === -1 && fmtSize !== 0x42) throw new Error('Thiếu vorb nhưng fmt không phải 0x42 (định dạng không được hỗ trợ)');
  if (vorbOffset !== -1 && fmtSize !== 0x28 && fmtSize !== 0x18 && fmtSize !== 0x12) throw new Error('fmt size không hợp lệ: ' + fmtSize.toString(16));

  if (vorbOffset === -1 && fmtSize === 0x42) {
    vorbOffset = fmtOffset + 0x18;
    vorbSize = -1;
  }

  // --- đọc fmt ---
  let p = fmtOffset;
  const codecId = read16(p); p += 2;
  if (codecId !== 0xFFFF) throw new Error('codec id sai, không phải Vorbis (0x' + codecId.toString(16) + ')');
  const channels = read16(p); p += 2;
  const sampleRate = read32(p); p += 4;
  const avgBytesPerSec = read32(p); p += 4;
  const blockAlign = read16(p); p += 2;
  if (blockAlign !== 0) throw new Error('block align phải bằng 0');
  const bps = read16(p); p += 2;
  if (bps !== 0) throw new Error('bps phải bằng 0');
  const extraFmtLen = read16(p); p += 2;
  if (fmtSize - 0x12 !== extraFmtLen) throw new Error('extra fmt length sai');

  let extUnk = 0, subtype = 0;
  if (fmtSize - 0x12 >= 2) {
    extUnk = read16(p); p += 2;
    if (fmtSize - 0x12 >= 6) { subtype = read32(p); p += 4; }
  }

  // --- đọc vorb ---
  let vp;
  const validVorbSizes = [-1, 0x28, 0x2A, 0x2C, 0x32, 0x34];
  if (!validVorbSizes.includes(vorbSize)) throw new Error('vorb size không hợp lệ: 0x' + vorbSize.toString(16));
  vp = vorbOffset;

  const sampleCount = read32(vp);

  let noGranule = false, modPackets = false;
  if (vorbSize === -1 || vorbSize === 0x2A) {
    noGranule = true;
    const modSignal = read32(vorbOffset + 0x4);
    if (![0x4A, 0x4B, 0x69, 0x70].includes(modSignal)) modPackets = true;
    vp = vorbOffset + 0x10;
  } else {
    vp = vorbOffset + 0x18;
  }

  const setupPacketOffset = read32(vp); vp += 4;
  const firstAudioPacketOffset = read32(vp); vp += 4;

  if (vorbSize === -1 || vorbSize === 0x2A) vp = vorbOffset + 0x24;
  else if (vorbSize === 0x32 || vorbSize === 0x34) vp = vorbOffset + 0x2C;

  let headerTriadPresent = false, oldPacketHeaders = false;
  let uid = 0, blocksize0Pow = 0, blocksize1Pow = 0;

  if (vorbSize === 0x28 || vorbSize === 0x2C) {
    headerTriadPresent = true;
    oldPacketHeaders = true;
  } else if ([-1, 0x2A, 0x32, 0x34].includes(vorbSize)) {
    uid = read32(vp); vp += 4;
    blocksize0Pow = dv.getUint8(vp); vp += 1;
    blocksize1Pow = dv.getUint8(vp); vp += 1;
  }

  return {
    littleEndian,
    channels, sampleRate, avgBytesPerSec,
    extUnk, subtype,
    fmtOffset, fmtSize,
    vorbOffset, vorbSize,
    dataOffset, dataSize,
    sampleCount,
    noGranule, modPackets,
    setupPacketOffset, firstAudioPacketOffset,
    headerTriadPresent, oldPacketHeaders,
    uid, blocksize0Pow, blocksize1Pow
  };
}


// ==== bitstream.js ====
// Part 2/3 — Bit-level reader/writer + Ogg page packetizer (port từ Bit_stream.h / crc.c)

// ---- CRC32 kiểu Ogg (không reflect, polynomial 0x04c11db7, giống libogg/Tremor) ----
const CRC_LOOKUP = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggChecksum(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (((crc << 8) >>> 0) ^ CRC_LOOKUP[((crc >>> 24) ^ bytes[i]) & 0xFF]) >>> 0;
  }
  return crc >>> 0;
}

// ---- Bit reader (đọc bit LSB-first từ 1 vùng byte, giống Bit_stream) ----
class BitReader {
  constructor(bytes, startByte = 0) {
    this.bytes = bytes; // Uint8Array
    this.bytePos = startByte;
    this.bitBuffer = 0;
    this.bitsLeft = 0;
    this.totalBitsRead = 0;
  }
  getBit() {
    if (this.bitsLeft === 0) {
      if (this.bytePos >= this.bytes.length) throw new Error('Hết dữ liệu khi đọc bit (Out_of_bits)');
      this.bitBuffer = this.bytes[this.bytePos++];
      this.bitsLeft = 8;
    }
    this.totalBitsRead++;
    this.bitsLeft--;
    return (this.bitBuffer & (0x80 >> this.bitsLeft)) !== 0;
  }
  readUint(bits) {
    let total = 0;
    for (let i = 0; i < bits; i++) {
      if (this.getBit()) total |= (1 << i);
    }
    return total >>> 0;
  }
  get totalBits() { return this.totalBitsRead; }
}

// ---- Bit/Ogg page writer (giống Bit_oggstream) ----
class BitOggStream {
  constructor() {
    this.pages = []; // mảng Uint8Array, mỗi phần tử là 1 page hoàn chỉnh
    this.bitBuffer = 0;
    this.bitsStored = 0;
    this.payload = []; // mảng số nguyên byte (0-255) của packet hiện tại chưa đóng page
    this.first = true;
    this.continued = false;
    this.granule = 0;
    this.seqno = 0;
    this.serial = 1;
  }

  putBit(bit) {
    if (bit) this.bitBuffer |= (1 << this.bitsStored);
    this.bitsStored++;
    if (this.bitsStored === 8) this.flushBits();
  }

  writeUint(value, bits) {
    for (let i = 0; i < bits; i++) {
      this.putBit((value & (1 << i)) !== 0);
    }
  }

  setGranule(g) { this.granule = g >>> 0; }

  flushBits() {
    if (this.bitsStored !== 0) {
      this.payload.push(this.bitBuffer & 0xFF);
      this.bitsStored = 0;
      this.bitBuffer = 0;
    }
  }

  // Đánh dấu kết thúc 1 packet logic (không nhất thiết flush page ngay,
  // ww2ogg gốc gộp nhiều packet nhỏ vào cùng 1 page qua lacing values;
  // ở đây để đơn giản và đúng chuẩn, ta flush page sau mỗi packet quan trọng khi cần).
  flushPage(nextContinued = false, last = false) {
    this.flushBits();
    const payloadBytes = this.payload.length;
    if (payloadBytes === 0 && !last) return; // không có gì để ghi, trừ khi là page cuối rỗng

    let segments = Math.ceil(payloadBytes / 255) || 1;
    if (payloadBytes === 0) segments = 0;
    if (segments === 256) segments = 255; // giới hạn tối đa như bản gốc

    const headerBytes = 27;
    const header = new Uint8Array(headerBytes + segments);
    header[0] = 0x4F; header[1] = 0x67; header[2] = 0x67; header[3] = 0x53; // "OggS"
    header[4] = 0; // version
    header[5] = (this.continued ? 1 : 0) | (this.first ? 2 : 0) | (last ? 4 : 0);

    // granule position (64-bit, ta chỉ set 32 bit thấp)
    writeUint32LE(header, 6, this.granule);
    if (this.granule === 0xFFFFFFFF) {
      writeUint32LE(header, 10, 0xFFFFFFFF);
    } else {
      writeUint32LE(header, 10, 0);
    }

    writeUint32LE(header, 14, this.serial);
    writeUint32LE(header, 18, this.seqno);
    writeUint32LE(header, 22, 0); // checksum tạm để 0
    header[26] = segments;

    // lacing values
    let bytesLeft = payloadBytes;
    for (let i = 0; i < segments; i++) {
      if (bytesLeft >= 255) { header[27 + i] = 255; bytesLeft -= 255; }
      else { header[27 + i] = bytesLeft; bytesLeft = 0; }
    }

    const page = new Uint8Array(headerBytes + segments + payloadBytes);
    page.set(header, 0);
    for (let i = 0; i < payloadBytes; i++) page[headerBytes + segments + i] = this.payload[i];

    const crc = oggChecksum(page);
    writeUint32LE(page, 22, crc);

    this.pages.push(page);

    this.seqno++;
    this.first = false;
    this.continued = nextContinued;
    this.payload = [];
  }

  toBlob() {
    return new Blob(this.pages, { type: 'audio/ogg' });
  }
  toBytes() {
    let total = 0;
    for (const p of this.pages) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.pages) { out.set(p, off); off += p.length; }
    return out;
  }
}

function writeUint32LE(arr, offset, value) {
  arr[offset] = value & 0xFF;
  arr[offset+1] = (value >>> 8) & 0xFF;
  arr[offset+2] = (value >>> 16) & 0xFF;
  arr[offset+3] = (value >>> 24) & 0xFF;
}

function ilog(v) {
  let ret = 0;
  v = v >>> 0;
  while (v) { ret++; v >>>= 1; }
  return ret;
}


// ==== codebook.js ====
// Part 2/3 — codebook_library: đọc packed_codebooks.bin và dựng lại từng codebook
// theo đúng chuẩn Vorbis (port từ codebook.cpp của ww2ogg)


function bookMaptype1Quantvals(entries, dimensions) {
  let bits = ilog(entries);
  let vals = entries >>> Math.floor(((bits - 1) * (dimensions - 1)) / dimensions);
  while (true) {
    let acc = 1, acc1 = 1;
    for (let i = 0; i < dimensions; i++) { acc *= vals; acc1 *= (vals + 1); }
    if (acc <= entries && acc1 > entries) return vals;
    else if (acc > entries) vals--;
    else vals++;
  }
}

class CodebookLibrary {
  constructor(bytes) {
    // bytes: Uint8Array của toàn bộ file packed_codebooks*.bin
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fileSize = bytes.length;
    const offsetOffset = dv.getUint32(fileSize - 4, true);
    this.codebookCount = (fileSize - offsetOffset) / 4;
    this.data = bytes.slice(0, offsetOffset);
    this.offsets = new Uint32Array(this.codebookCount);
    for (let i = 0; i < this.codebookCount; i++) {
      this.offsets[i] = dv.getUint32(offsetOffset + i * 4, true);
    }
  }

  getCodebookSize(i) {
    if (i >= this.codebookCount - 1 || i < 0) return -1;
    return this.offsets[i + 1] - this.offsets[i];
  }

  getCodebookBytes(i) {
    const size = this.getCodebookSize(i);
    if (size === -1) return null;
    return this.data.slice(this.offsets[i], this.offsets[i] + size);
  }

  // Đọc 1 codebook (dạng "rút gọn" của Wwise, thiếu 24-bit id) từ BitReader nguồn (bis)
  // và ghi lại đầy đủ chuẩn Vorbis vào bos (BitOggStream). cbSize=0 nghĩa là không kiểm tra kích thước.
  static rebuildFromBitstream(bis, cbSize, bos) {
    const dimensions = bis.readUint(4);
    const entries = bis.readUint(14);

    // OUT: 24 bit id ('CBV' = 0x564342), 16 bit dimensions, 24 bit entries
    bos.writeUint(0x564342, 24);
    bos.writeUint(dimensions, 16);
    bos.writeUint(entries, 24);

    const ordered = bis.readUint(1);
    bos.writeUint(ordered, 1);

    if (ordered) {
      const initialLength = bis.readUint(5);
      bos.writeUint(initialLength, 5);
      let currentEntry = 0;
      while (currentEntry < entries) {
        const bits = ilog(entries - currentEntry);
        const number = bis.readUint(bits);
        bos.writeUint(number, bits);
        currentEntry += number;
      }
      if (currentEntry > entries) throw new Error('current_entry vượt quá entries khi rebuild codebook');
    } else {
      const codewordLengthLength = bis.readUint(3);
      const sparse = bis.readUint(1);
      if (codewordLengthLength === 0 || codewordLengthLength > 5) {
        throw new Error('codeword length length vô lý: ' + codewordLengthLength);
      }
      bos.writeUint(sparse, 1);
      for (let i = 0; i < entries; i++) {
        let present = 1;
        if (sparse) {
          present = bis.readUint(1);
          bos.writeUint(present, 1);
        }
        if (present) {
          const codewordLength = bis.readUint(codewordLengthLength);
          bos.writeUint(codewordLength, 5);
        }
      }
    }

    // lookup table
    const lookupType = bis.readUint(1);
    bos.writeUint(lookupType, 4);

    if (lookupType === 0) {
      // không có lookup table
    } else if (lookupType === 1) {
      const min = bis.readUint(32);
      const max = bis.readUint(32);
      const valueLength = bis.readUint(4);
      const sequenceFlag = bis.readUint(1);
      bos.writeUint(min, 32);
      bos.writeUint(max, 32);
      bos.writeUint(valueLength, 4);
      bos.writeUint(sequenceFlag, 1);

      const quantvals = bookMaptype1Quantvals(entries, dimensions);
      for (let i = 0; i < quantvals; i++) {
        const val = bis.readUint(valueLength + 1);
        bos.writeUint(val, valueLength + 1);
      }
    } else {
      throw new Error('lookup type không hỗ trợ: ' + lookupType);
    }

    if (cbSize !== 0) {
      const expectedBytes = Math.floor(bis.totalBits / 8) + 1;
      if (expectedBytes !== cbSize) {
        throw new Error(`Size mismatch khi rebuild codebook: kỳ vọng ${cbSize} byte, đọc hết ${expectedBytes} byte`);
      }
    }
  }

  // Dựng lại codebook số i từ thư viện vào bos
  rebuild(i, bos) {
    const cbBytes = this.getCodebookBytes(i);
    const cbSize = this.getCodebookSize(i);
    if (!cbBytes || cbSize === -1) throw new Error('Codebook id không hợp lệ: ' + i);
    const bis = new BitReader(cbBytes);
    CodebookLibrary.rebuildFromBitstream(bis, cbSize, bos);
  }

  // "copy": đọc 1 codebook ĐÃ ở dạng chuẩn Vorbis đầy đủ (có 24-bit id) từ bis và copy nguyên sang bos
  // Dùng cho trường hợp inline codebook (setup packet tự chứa codebook, không tham chiếu thư viện ngoài)
  static copyFull(bis, bos) {
    const id = bis.readUint(24);
    const dimensions = bis.readUint(16);
    const entries = bis.readUint(24);
    if (id !== 0x564342) throw new Error('Codebook identifier sai (không phải 0x564342)');

    bos.writeUint(id, 24);
    bos.writeUint(dimensions, 16);
    bos.writeUint(entries, 24);

    const ordered = bis.readUint(1);
    bos.writeUint(ordered, 1);
    if (ordered) {
      const initialLength = bis.readUint(5);
      bos.writeUint(initialLength, 5);
      let currentEntry = 0;
      while (currentEntry < entries) {
        const bits = ilog(entries - currentEntry);
        const number = bis.readUint(bits);
        bos.writeUint(number, bits);
        currentEntry += number;
      }
    } else {
      const sparse = bis.readUint(1);
      bos.writeUint(sparse, 1);
      for (let i = 0; i < entries; i++) {
        let present = 1;
        if (sparse) {
          present = bis.readUint(1);
          bos.writeUint(present, 1);
        }
        if (present) {
          const codewordLength = bis.readUint(5);
          bos.writeUint(codewordLength, 5);
        }
      }
    }

    const lookupType = bis.readUint(4);
    bos.writeUint(lookupType, 4);
    if (lookupType === 1) {
      const min = bis.readUint(32);
      const max = bis.readUint(32);
      const valueLength = bis.readUint(4);
      const sequenceFlag = bis.readUint(1);
      bos.writeUint(min, 32);
      bos.writeUint(max, 32);
      bos.writeUint(valueLength, 4);
      bos.writeUint(sequenceFlag, 1);
      const quantvals = bookMaptype1Quantvals(entries, dimensions);
      for (let i = 0; i < quantvals; i++) {
        const val = bis.readUint(valueLength + 1);
        bos.writeUint(val, valueLength + 1);
      }
    } else if (lookupType !== 0) {
      throw new Error('lookup type không hỗ trợ trong copyFull: ' + lookupType);
    }
  }
}


// ==== wem2ogg.js ====
// wem2ogg.js — Chuyển .wem (Wwise Vorbis) sang .ogg chuẩn, chạy được cả Node lẫn trình duyệt.
// Port đầy đủ từ wwriff.cpp (ww2ogg by hcs64, BSD-3-Clause).


// Đọc "Packet" kiểu Wwise (2 hoặc 6 byte header: size [+ granule])
function readPacketInfo(bytes, offset, littleEndian, noGranule) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = dv.getUint16(offset, littleEndian);
  let granule = 0;
  const headerSize = noGranule ? 2 : 6;
  if (!noGranule) granule = dv.getUint32(offset + 2, littleEndian);
  return {
    headerSize,
    size,
    payloadOffset: offset + headerSize,
    granule,
    nextOffset: offset + headerSize + size
  };
}

function writeVorbisPacketHeader(os, type) {
  os.writeUint(type, 8);
  const vorbisStr = [0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "vorbis"
  for (const c of vorbisStr) os.writeUint(c, 8);
}

function generateIdentificationPacket(os, info) {
  writeVorbisPacketHeader(os, 1);
  os.writeUint(0, 32); // version
  os.writeUint(info.channels, 8);
  os.writeUint(info.sampleRate, 32);
  os.writeUint(0, 32); // bitrate max
  os.writeUint(info.avgBytesPerSec * 8, 32); // bitrate nominal
  os.writeUint(0, 32); // bitrate min
  os.writeUint(info.blocksize0Pow, 4);
  os.writeUint(info.blocksize1Pow, 4);
  os.writeUint(1, 1); // framing
  os.flushPage();
}

function generateCommentPacket(os, info) {
  writeVorbisPacketHeader(os, 3);
  const vendor = 'converted from Audiokinetic Wwise by wem2ogg.js (JS port of ww2ogg)';
  os.writeUint(vendor.length, 32);
  for (let i = 0; i < vendor.length; i++) os.writeUint(vendor.charCodeAt(i), 8);

  if (!info.loopCount) {
    os.writeUint(0, 32);
  } else {
    os.writeUint(2, 32);
    const s1 = `LoopStart=${info.loopStart}`;
    const s2 = `LoopEnd=${info.loopEnd}`;
    os.writeUint(s1.length, 32);
    for (let i = 0; i < s1.length; i++) os.writeUint(s1.charCodeAt(i), 8);
    os.writeUint(s2.length, 32);
    for (let i = 0; i < s2.length; i++) os.writeUint(s2.charCodeAt(i), 8);
  }
  os.writeUint(1, 1); // framing
  os.flushPage();
}

// Dựng setup packet (phần khó nhất) — trả về { modeBlockflag, modeBits }
function generateSetupPacket(os, wemBytes, info, codebookLib, opts) {
  const { littleEndian, noGranule, dataOffset, setupPacketOffset, firstAudioPacketOffset, channels } = info;
  const { inlineCodebooks = false, fullSetup = false } = opts;

  writeVorbisPacketHeader(os, 5);

  const pkt = readPacketInfo(wemBytes, dataOffset + setupPacketOffset, littleEndian, noGranule);
  if (pkt.granule !== 0) throw new Error('setup packet granule khác 0');

  const ss = new BitReader(wemBytes, pkt.payloadOffset);

  const codebookCountLess1 = ss.readUint(8);
  const codebookCount = codebookCountLess1 + 1;
  os.writeUint(codebookCountLess1, 8);

  if (inlineCodebooks) {
    for (let i = 0; i < codebookCount; i++) {
      if (fullSetup) CodebookLibrary.copyFull(ss, os);
      else CodebookLibrary.rebuildFromBitstream(ss, 0, os);
    }
  } else {
    if (!codebookLib) throw new Error('Cần thư viện codebook (packed_codebooks) khi không dùng inline codebooks');
    for (let i = 0; i < codebookCount; i++) {
      const codebookId = ss.readUint(10);
      codebookLib.rebuild(codebookId, os);
    }
  }

  // Time domain transform placeholder
  os.writeUint(0, 6);
  os.writeUint(0, 16);

  let modeBlockflag = null;
  let modeBits = 0;

  if (fullSetup) {
    while (ss.totalBits < pkt.size * 8) {
      const b = ss.readUint(1);
      os.writeUint(b, 1);
    }
  } else {
    // floor count
    const floorCountLess1 = ss.readUint(6);
    const floorCount = floorCountLess1 + 1;
    os.writeUint(floorCountLess1, 6);

    for (let i = 0; i < floorCount; i++) {
      os.writeUint(1, 16); // floor type luôn = 1

      const floor1Partitions = ss.readUint(5);
      os.writeUint(floor1Partitions, 5);

      const partitionClassList = new Array(floor1Partitions);
      let maximumClass = 0;
      for (let j = 0; j < floor1Partitions; j++) {
        const cls = ss.readUint(4);
        os.writeUint(cls, 4);
        partitionClassList[j] = cls;
        if (cls > maximumClass) maximumClass = cls;
      }

      const classDimensionsList = new Array(maximumClass + 1);
      for (let j = 0; j <= maximumClass; j++) {
        const classDimensionsLess1 = ss.readUint(3);
        os.writeUint(classDimensionsLess1, 3);
        classDimensionsList[j] = classDimensionsLess1 + 1;

        const classSubclasses = ss.readUint(2);
        os.writeUint(classSubclasses, 2);

        if (classSubclasses !== 0) {
          const masterbook = ss.readUint(8);
          os.writeUint(masterbook, 8);
          if (masterbook >= codebookCount) throw new Error('floor1 masterbook không hợp lệ');
        }

        for (let k = 0; k < (1 << classSubclasses); k++) {
          const subclassBookPlus1 = ss.readUint(8);
          os.writeUint(subclassBookPlus1, 8);
          const subclassBook = subclassBookPlus1 - 1;
          if (subclassBook >= 0 && subclassBook >= codebookCount) throw new Error('floor1 subclass book không hợp lệ');
        }
      }

      const floor1MultiplierLess1 = ss.readUint(2);
      os.writeUint(floor1MultiplierLess1, 2);
      const rangebits = ss.readUint(4);
      os.writeUint(rangebits, 4);

      for (let j = 0; j < floor1Partitions; j++) {
        const currentClass = partitionClassList[j];
        for (let k = 0; k < classDimensionsList[currentClass]; k++) {
          const x = ss.readUint(rangebits);
          os.writeUint(x, rangebits);
        }
      }
    }

    // residue count
    const residueCountLess1 = ss.readUint(6);
    const residueCount = residueCountLess1 + 1;
    os.writeUint(residueCountLess1, 6);

    for (let i = 0; i < residueCount; i++) {
      const residueType = ss.readUint(2);
      os.writeUint(residueType, 16);
      if (residueType > 2) throw new Error('residue type không hợp lệ');

      const residueBegin = ss.readUint(24);
      const residueEnd = ss.readUint(24);
      const residuePartitionSizeLess1 = ss.readUint(24);
      const residueClassificationsLess1 = ss.readUint(6);
      const residueClassbook = ss.readUint(8);
      const residueClassifications = residueClassificationsLess1 + 1;

      os.writeUint(residueBegin, 24);
      os.writeUint(residueEnd, 24);
      os.writeUint(residuePartitionSizeLess1, 24);
      os.writeUint(residueClassificationsLess1, 6);
      os.writeUint(residueClassbook, 8);

      if (residueClassbook >= codebookCount) throw new Error('residue classbook không hợp lệ');

      const residueCascade = new Array(residueClassifications);
      for (let j = 0; j < residueClassifications; j++) {
        const lowBits = ss.readUint(3);
        os.writeUint(lowBits, 3);
        const bitflag = ss.readUint(1);
        os.writeUint(bitflag, 1);
        let highBits = 0;
        if (bitflag) {
          highBits = ss.readUint(5);
          os.writeUint(highBits, 5);
        }
        residueCascade[j] = highBits * 8 + lowBits;
      }

      for (let j = 0; j < residueClassifications; j++) {
        for (let k = 0; k < 8; k++) {
          if (residueCascade[j] & (1 << k)) {
            const residueBook = ss.readUint(8);
            os.writeUint(residueBook, 8);
            if (residueBook >= codebookCount) throw new Error('residue book không hợp lệ');
          }
        }
      }
    }

    // mapping count
    const mappingCountLess1 = ss.readUint(6);
    const mappingCount = mappingCountLess1 + 1;
    os.writeUint(mappingCountLess1, 6);

    for (let i = 0; i < mappingCount; i++) {
      os.writeUint(0, 16); // mapping type luôn = 0

      const submapsFlag = ss.readUint(1);
      os.writeUint(submapsFlag, 1);

      let submaps = 1;
      if (submapsFlag) {
        const submapsLess1 = ss.readUint(4);
        submaps = submapsLess1 + 1;
        os.writeUint(submapsLess1, 4);
      }

      const squarePolarFlag = ss.readUint(1);
      os.writeUint(squarePolarFlag, 1);

      if (squarePolarFlag) {
        const couplingStepsLess1 = ss.readUint(8);
        const couplingSteps = couplingStepsLess1 + 1;
        os.writeUint(couplingStepsLess1, 8);

        const bits = ilog(channels - 1);
        for (let j = 0; j < couplingSteps; j++) {
          const magnitude = ss.readUint(bits);
          const angle = ss.readUint(bits);
          os.writeUint(magnitude, bits);
          os.writeUint(angle, bits);
          if (angle === magnitude || magnitude >= channels || angle >= channels) throw new Error('coupling không hợp lệ');
        }
      }

      const mappingReserved = ss.readUint(2);
      os.writeUint(mappingReserved, 2);
      if (mappingReserved !== 0) throw new Error('mapping reserved field khác 0');

      if (submaps > 1) {
        for (let j = 0; j < channels; j++) {
          const mux = ss.readUint(4);
          os.writeUint(mux, 4);
          if (mux >= submaps) throw new Error('mapping_mux >= submaps');
        }
      }

      for (let j = 0; j < submaps; j++) {
        const timeConfig = ss.readUint(8);
        os.writeUint(timeConfig, 8);
        const floorNumber = ss.readUint(8);
        os.writeUint(floorNumber, 8);
        if (floorNumber >= floorCount) throw new Error('floor mapping không hợp lệ');
        const residueNumber = ss.readUint(8);
        os.writeUint(residueNumber, 8);
        if (residueNumber >= residueCount) throw new Error('residue mapping không hợp lệ');
      }
    }

    // mode count
    const modeCountLess1 = ss.readUint(6);
    const modeCount = modeCountLess1 + 1;
    os.writeUint(modeCountLess1, 6);

    modeBlockflag = new Array(modeCount);
    modeBits = ilog(modeCount - 1);

    for (let i = 0; i < modeCount; i++) {
      const blockFlag = ss.readUint(1);
      os.writeUint(blockFlag, 1);
      modeBlockflag[i] = blockFlag !== 0;

      os.writeUint(0, 16); // windowtype
      os.writeUint(0, 16); // transformtype

      const mapping = ss.readUint(8);
      os.writeUint(mapping, 8);
      if (mapping >= mappingCount) throw new Error('mode mapping không hợp lệ');
    }

    os.writeUint(1, 1); // framing
  }

  os.flushPage();

  if (Math.floor((ss.totalBits + 7) / 8) !== pkt.size) {
    throw new Error(`Không đọc đúng hết setup packet: đọc ${Math.floor((ss.totalBits+7)/8)} byte, kỳ vọng ${pkt.size} byte`);
  }
  if (pkt.nextOffset !== dataOffset + firstAudioPacketOffset) {
    throw new Error('Audio packet đầu tiên không nối tiếp ngay sau setup packet — có thể sai định dạng');
  }

  return { modeBlockflag, modeBits };
}

function generateAudioPackets(os, wemBytes, info, modeBlockflag, modeBits) {
  const { littleEndian, noGranule, dataOffset, dataSize, firstAudioPacketOffset, modPackets, oldPacketHeaders, blocksize0Pow, blocksize1Pow } = info;
  let offset = dataOffset + firstAudioPacketOffset;
  let prevBlockflag = false;

  // Tính granule chính xác kiểu revorb: tích lũy số sample thật dựa theo block size,
  // thay vì copy trực tiếp granule (thường sai) từ header gốc của Wwise.
  const blocksize0 = 1 << blocksize0Pow;
  const blocksize1 = 1 << blocksize1Pow;
  let prevBlocksize = null;
  let totalSamples = 0;

  while (offset < dataOffset + dataSize) {
    const pkt = readPacketInfo(wemBytes, offset, littleEndian, noGranule);
    if (offset + pkt.headerSize > dataOffset + dataSize) throw new Error('page header bị cắt cụt');

    let curModeNumber = null;

    if (modPackets) {
      if (!modeBlockflag) throw new Error('Thiếu mode_blockflag để đóng gói audio packet kiểu mod_packets');

      os.writeUint(0, 1); // packet type = audio

      const bitReader = new BitReader(wemBytes, pkt.payloadOffset);
      const modeNumber = bitReader.readUint(modeBits);
      curModeNumber = modeNumber;
      os.writeUint(modeNumber, modeBits);
      const remainderBits = 8 - modeBits;
      const remainder = bitReader.readUint(remainderBits);

      if (modeBlockflag[modeNumber]) {
        let nextBlockflag = false;
        if (pkt.nextOffset + pkt.headerSize <= dataOffset + dataSize) {
          const nextPkt = readPacketInfo(wemBytes, pkt.nextOffset, littleEndian, noGranule);
          if (nextPkt.size > 0) {
            const nextReader = new BitReader(wemBytes, nextPkt.payloadOffset);
            const nextModeNumber = nextReader.readUint(modeBits);
            nextBlockflag = modeBlockflag[nextModeNumber];
          }
        }
        os.writeUint(prevBlockflag ? 1 : 0, 1);
        os.writeUint(nextBlockflag ? 1 : 0, 1);
      }

      prevBlockflag = modeBlockflag[modeNumber];
      os.writeUint(remainder, remainderBits);
    } else {
      // byte đầu tiên ghi thẳng, không cần tách bit
      os.writeUint(wemBytes[pkt.payloadOffset], 8);
    }

    // Ghi các byte còn lại của packet (từ byte thứ 2 trở đi)
    for (let i = 1; i < pkt.size; i++) {
      os.writeUint(wemBytes[pkt.payloadOffset + i], 8);
    }

    // Tích lũy granule đúng chuẩn: mỗi packet (trừ packet đầu) đóng góp
    // (blocksize_trước + blocksize_hiện_tại) / 4 sample vào tổng số sample đã giải mã.
    if (modPackets && modeBlockflag) {
      const curBlocksize = modeBlockflag[curModeNumber] ? blocksize1 : blocksize0;
      if (prevBlocksize !== null) {
        totalSamples += Math.floor((prevBlocksize + curBlocksize) / 4);
      }
      prevBlocksize = curBlocksize;
      os.setGranule(totalSamples);
    } else {
      // Không có thông tin mode per-packet (hiếm) — đành dùng granule gốc từ Wwise
      os.setGranule(pkt.granule === 0xFFFFFFFF ? 1 : pkt.granule);
    }

    offset = pkt.nextOffset;
    os.flushPage(false, offset === dataOffset + dataSize);
  }

  if (offset > dataOffset + dataSize) throw new Error('page bị cắt cụt (vượt quá data)');
}

// API chính: convert 1 file wem (Uint8Array) sang ogg (Uint8Array)
function wemToOgg(wemBytes, codebookLibBytes, opts = {}) {
  const buf = wemBytes.buffer.slice(wemBytes.byteOffset, wemBytes.byteOffset + wemBytes.byteLength);
  const info = parseWemHeader(buf);

  if (info.headerTriadPresent) {
    throw new Error('File này có header triad nhúng sẵn (chưa hỗ trợ ở bản này) — cần logic copy riêng.');
  }

  const codebookLib = (opts.inlineCodebooks || !codebookLibBytes) ? null : new CodebookLibrary(codebookLibBytes);

  const os = new BitOggStream();
  generateIdentificationPacket(os, info);
  generateCommentPacket(os, { loopCount: 0 });
  const { modeBlockflag, modeBits } = generateSetupPacket(os, wemBytes, info, codebookLib, opts);
  generateAudioPackets(os, wemBytes, info, modeBlockflag, modeBits);

  return os.toBytes();
}


return { parseWemHeader, BitReader, BitOggStream, ilog, oggChecksum, CodebookLibrary, bookMaptype1Quantvals, wemToOgg };
})();


// Dữ liệu thư viện codebook Vorbis chuẩn aoTuV 6.03 (nhúng sẵn, ~74KB), dùng để dựng lại setup packet khi chuyển wem -> ogg
const CODEBOOK_B64 = "kQBYU1V1dQCRAVgAdXWVtbW319kAAQRgAAAAJY1UUlllnbbaa/HFGGesueY5c84553vvBZEAWFVVc3UAkQFgAKOUU85JZ6XV1nsAAQRgAAAAZZyySisvvfXee++9995777333nvvvfdeAwEEICNCrMI9Oz30EjEbKSyqq/MjwqOpNCI983Zm5lNPK8V0AAEQIKrzwvTUdXf3KfOyczx0d/c6dLPzxHR3d2d3T3Vndnf3KfM69Mx1d/egcirzK3N3d6pzKnMsc3f3XvZNdXd3d3c7dMx073Z3dypzO/TFdHd3M3Sz8z10d3fm9tV1d3d3d3d3d3d3d3d3ZnZ3d3d3d3dfdl92b3d3d3d3d3Z3d3d3AAEIqEEIIYQQQgghhBBSSCmlkFJMMcUUU4455phjjkEGGWTQQSeddJJJJZ10lElGHaXWUmoppphiyy3GWmutOedeg1LGGGOMMcYYY4wxxhhjjDFGAAECoBgaGhoiIqKioiorq7OzszMAAQhoAAAAgKNIiuRIjuRIkiRZkiVpkmd5lmd5lqeJmqipoqq6qu3avu3Lvu27uuzbvmy7uqzLsqy7tq3Luqvruq7ruq7ruq7ruq7ruq7rOgAhAViXd5d3l5eXlQUhA2AAAE455Zx00llnpZVaauutt157Lbb4AAEIYAAAAAAAAEop5ZRzUlqrtfZefTHGWWuNc9Za65xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc04AIQFYd3d3dXd3eZkJIQNgAABGKaeks85KbbX11mvxzXdjnn32ugEBCGAAAAAAAADOO++889JLb73zzksvtdZaa6211lprrbXWWmuttdZaa6211lprrbXWWmuttdZaa601AIEAGETlbAABBCghRCNjqFNKgkvBQogjYqhDyHkotXQQPKWwZEx6ijUIIYTvvefee+89AAEEqDAKHMTAYxKEEEIxihOiOFMQhBDCchIs5Tx0EoTuQQghXM695dx77z0AARAoY4wqxShTSlopMWOOMsYoU0xSKbGU0EIIqXOOYio155pzjTW3FoQQQmMKKqUgU8pRKi1jDDKlIFMKYimphE5C56RzDGIrKdgac20xyJaDsEFTiimFmFJKUQghY4oxpZhSSknooITOQcecY8pRCSUIl3NutdbScmwxlU5S6ZyEjEkIKaVQUumgdMpJCKnG0loqpWNOSkotCB2EEELIFoSwQQBBAAwEoQBQ6LoWkQFYAKquru7y8jYXAQRoAAAAw1EkRVIkx5IsSbMsTRNFVfVV21RV2dd1Xdd1XdcBARCgMtsqW6tKX2WzY7NbM9Nd5URURMy8295t1W1ddV92d/cqy6pSq8JeZTPLKkOzSt5cRFTEQ7xL3txd5V1d53X37qq6KiqzIk08q7IqKrMqTby7wzu7uzJNxNbs1nRWVN9VxbvEQ0281VXOQ83DxMO8XddM1sw720RdX3VW9W1ld2YAQQAMBKEAUNjaFpEBWACurq6y8vL2FgEEYAAAAOOUVFJZp52W2mqrvZlzzjnnnHPOOd977wUBBKhkDkPFqHTOghBCQwgqY5xDyHmNPUOIKUKQQ4Zpa7lkDjKEFFQIcQslAAEQqMMgPApCxSCEEMKSHizJwZMehBBCxBw8CsK0IIQQQgghhBBCCCGEEMKiHDTJwZMghA7CcRgchsFyHHwOwqIcLIjBkyB0EMIHIVzNQdYchBBCkhokqEGDHHQOQmEWFEVBYhhcC0KCGhRGQXIYZOrBBSFEzcGkGnwNwrMgPAvCtCCEEEKSICTIQYMgZAxCoyAsyUGDHFwKwuUgVA1ClRyED0IAkQBQbdu2AJEBWABVdXeXl5e3twABBGAAAAAllVTSSSellFZaaaWVVmov1pxzzjnnnHMGkQBYVVN1dQCRAWAA5ZRVVlmllXfiiQABBGAAAAChjVbeiSm+Wevde++9995777333nvvnHMGgQAYVM5oAAEEKFDWG8s95N57771A1COKPcTee++9cdYjaD3E3HvvPffeU4295d577zkAAQQoUxA05cCF1HvvPTLMI6I0VI577z0yChNhKDMKeyq1tdZDJrmF1HvOPQABCChCCCGkkEIKKaSQQgoppJBCSinFFFNMMcUUU0455ZhjjjkGGXTQQSedhBJKSCGFUlJJJaWUUmqx1ppz7z3onnsPwgchhBBCCCGEEEIIIYQQQgABAqAgIiIaIiIioqKiIisrq6srAAEIYAAAAIBUUllnnXbaaeedd2KKKaa45pqrttnmq7HGOmu9td7e76777rrzvrvuuu+uu+6c995777333nvvvffee28AIQFYl5eXlZWVd5cJIQNgAABKKeeck046K7XU1ltvxRbbbPHVVwEBCGAAAAAAAADOK++889ZL77zz1muvtdZaa6211lprrbXWWmuttdZaa6211lprrbXWWmuttdZaa601ACEBWHd3d3d3d5eXByEDYAAAUklnnXXaaeedd+KJZ56ZZqrprrsAAQhgAAAAAAAAWlillXdeeu/F9l5r7cUZ45xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555wzRgCBABhoDmsAAQQoMJIUh0mzpJRSylCUPExKpKSUUspimERMysRijDHGGGOMMcYYY4wxRgABBChREhxHzZPUnHPOME4c5UBz0pxwTkEOFKPAcxKE603G3ExpTdfcnFNKAAEIKEIKKaSQQgoppBBDDDHEEEMMOeSQQw455ZRTUEEFFVSQQQYZZJJJJ5100klHHXXUUUehhRZaaKGVVmKKqbYac+016OKbc84555xzzjnnnHNOAAECoCAaGhoiIqKioiIrK6srNDQAAQhoAAAAgKNIiqRYiuVYjuZokid5lqiJmuiZoimqpqqqqqq6riu7smu7umu7vizMwi3cvizcwi3swq77wjAMwzAMwzAMwzD8vu/7vu/7PgAhAWAnnXVeiSWOWN6JByEDYAAAUkgllXRamm22O/fccde9d84555wBAQhYAAAAAAAAuru7u7u7u7u7u7u7u7t3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3ASEBWHd3d5eVlbe3ByEDYAAAUlllnXbaaeedd955J56YZpptvvkAAQhgAAAAAAAAyjjlnJNOSy/VNddtt91335333ntrrbXWWmuttdZaa6211lprrbXWWmuttdZaa621VgABAaDIa1ttILFBYwCBABgslWkAARAoQAwlB9GE1pxvznHQLAdNpdicDk6k2jzJTcXcnHPOOedkc84Y55xzTlHOLAbNhNacc05i0CwFzYTWnHPOk9g8aE2V1pxzzjjndDDOCOOcc06T1jxIzcbanHPOgtY0R82l2JxzTqTcPKnNpdqcc84555xzzjnnnHNO9eJ0Ds4J55xzTtTeXMtN6OKcc84n43RvTgjnnHPOOeecc84555xzTgABBKggDBvDuFMQpM/RQIwixDRk0oPu0WESNAY5hdSj0dFIKXUQSirjpJROAAEIKEIIKaSQQgoppJBCCimkEEMMMcSQU045BRVUUklFFWWUWWaZZZZZZpll1mFnnXXYYYghhhhaaSWWmmqrscZac8851xyktdJaa62VUkoppZRSAAECoCAaGhqaoqKiIiOrq6srLCwAAQhoAAAAgCd5juiIjuiIjuiIjuiIjuh4jueIkiiJkiiJlmmZmumpoqq6smvLuqzbvi3swq77vu77vm78ujAsy7Isy7Isy7Isy7Isy7IsSwABAiAgIiKioqKioiozs7M7vMREAAEIaAAAAICjOIrjSI7kSJIlWZImaZZmeZqneZroiaIomqapiq7oirppi7Ipm67pmrLpqrJqu7Js27Kt274s277v+77v+77v+77v+77v6zoAIQFYl5eVlZV3d5kJIQNgAABKOeWcc1JKKa3U0ltvxTbbfPPVWAEBCGAAAAAAAABKK6/M8kos78QTU1xzxVbbjXnme++9995777333nvvvffee++9995777333nvvvfdeACEBWJeXl5eVlZWXByEDYAAAzjgjlXTWWq299tpr8cUX33w13ngBAQhgAAAAAAAARhqrrNNOSzHVVVdtddVVY3211lprrbXWWmuttdZaa6211lprrbXWWmuttdZa55xzTgABAaCoQ1NmEKKqTQCBABhEnWkAARAoIcojxDx01HvvPULOI8S8Y9B77z2E1itHPZTUe++9995j7z333nvvPTLMK+Q8dNJ77z1CjCOjOFPOe+89hJQzBr1z0Hvvvffec84959p7771z1DsoPZXae++9ctIrJr1z1GvvvaTaQ0i9lNR777333nvvvffee++9995z77333nvvvfXcW+29995777333nvvvffee++9995777333nvvPQABBKgwDBvEuGPSe+29MMwTw7Rz0nvPvXLUMwY9hdh7z7333mvvvffee+89AAEIKEIIIaSQQgoppJBCDDHEkEMOOQQRVFJJRRVVVFFFFVVUWUYZZZRRJhlllFlGHXXUUYedhRRSSKWVFlppqbbeWqo9CCGEEEIIIYQQQgghfO89AAECmG3bNpIkSbJtW9d1XQABCGAAAACAlVpqp5133nnnlXfiiSeeeGKKKa7Y4osxzljjjn322Wefvfa5764779x7v7333HPPvffee++99957771vAAECoBgaGhoiIqKioqoqMzOzuzsAAQhgAAAAgHLKKeekk1Jaa7X11luxzTbbbLfdduOtd95567133nnnjbfee++tt95777333jnvvffOe++999577733XgAhAVh3d3d3d3d3lwkhA2AAAEop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Qcg5pRiESikIoYSUQigpVYxJyJiDkjEnpZRSWggltYoxCJljUjLHpIQSWioltBJKaamU0loopbWWWowptRZDKamFUlorpbSWWqoxtVZjxJiUzDkpmWNSSimtlVJaqxyTkjEoqYOQSikpxVJSi5VzUjLoqHQQSiqpxFRSaa2k0lIppcWSUmwpxVRbi7WGUlosqcRWUmoxtVRbizHXiDEpGXNSMueklFJSK6W0ljknpYOOSuagpJJSa6WkFDPmpHQOSsogo1JSii2lElMopbWSUmylpNZajLWm1FotJbVWUmqxlBJbizHXFktNnZTWSioxhlJaazHmmlqLMZQSWykpxpJKbK3FmltsOYZSWiypxFZKarHVlmNrsebUUo0ptZpbbLnGlFOPtfacWqs1tVRja7HmWFtvtdacOymthVJaKyXFmFqLscVYcygltpJSbKWkGFtsubYWYw+htFhKarGkEmNrMeYYW46ptVpbbLmm1GKttfYcW249pRZri7Hm0lKNNdfeY005FQAABhwAAAJMKAMBEgUgmDEzQ5yqu7vMobq7y7Q7RERVu0NEVLW7RNVVu0NU3cVM1V1ezFTdXQ4AAAUOAAABNmhKLA4QEgUgmakyQ5yZqjvEmakyQ6wqs7vEqjK7w7SzO8RMu7tDzETEzExVRMzMVA0AAAUOAAABNmhKLA4QFAUoMMY4Z5xDFDpLnaVIUketo9ZQSjWWGDuNrfbWc6c19tpybyiVGlOtHdeWc6u905p6bjkWAMAOHADADiyEAJIHoJipMru7myKzu7u7oTK7u7srs7s7RMQyu7tDRLS7O0RMTLu7Q0RMvDvEzMzMu0NEzMy8O0TMzMy7Q8zMzAwAQAUOAAABNopsTjASFJIHKDAGIeektNYw5hyElmpsGGMOSkqxRc5BSKnFXCPmIKQUY9AdlJRaDDb4TkJKrcWcg0mpxZpz70Gk1FrNQeeeaqu55957TjHWmnPvuRcAcBccAMAObBTZnGAkKJIHoCCqMru7myqzs7u7qTIzu7srM7O7u8MyM7u7QzSzuztERDO7u0NEvLs7RETEu7tDRES8OzxERMS7Q0RERAwAQAUOAAABNopsTjASFBIOIEBERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERLy7u7u7u7u7u7u7u7u7u7sLQL4VDgD+DzbOsJJ0VjgaHBIOIChCzCxDzMykvLzMu8TMTDrMzLzMzMzEzMxMxMzMTMTDzMTMzMzMzMzMzMzMzLzMzMzMzMysu8y8zMzMTLrLTMTMzMxMzMzMzMzMzMzMzMzMzMzMTEREREREREREREREREREREREREREREREREREREQMANwNDgAQCTbOsJJ0VjgaHBISIKiyO01ExURVLCs9xUxFzUxFMrtLvVPEVEw9rDvETFVFTdS7w8NURNVE1Dw9PMXEVM3EzDvMTFRMVdVERVTNU1XM1FRFTdTMTNTUREzFS9VMRU3VVMTLQ8XLRE1NRb1UVc1UVU3VxMtETVVFRFXNRExUVb3UVE1VRExUVFXVVE1NVdTUxMRMVVVMTNVUVVVN1QwAAAcOAAABRtBJRpVF2GjChQcgQgYoYhJSySn2yijFmITWS4WUYpJ6DxVTjEmnPVXIIOUg91AppBR02lumFFKKYe8UUwgZQz10EDKmEPZae+65994DQgYoclJKSq0WDSHloLQaRGSQcpJiEpExSEFpwVPIGMQk5Y4xhZCCVDvomEKKUQ0phUwpBTXVHEPHGNSYk3CphFIDFAUgICIzMiMzQzREMjPEQySzQzREQ8RUzDRETMRUOjPEQzRE1ERMQ8RM1AwAAAEOAAABFkIUJyhByDnEGISIMQihhJRCCClFjEHInJOSOSellNJaKCW1iDEImXNSMuekhFJaKqW0FkpprZTSWiiltdZaram1WEMprYVSWiultJZaq7G1VmPEGITMOSmZc1JKKa2VUlrLnKPSQUipg5BSSanFklKLmXNSOuiodBBSKqnEVlKKsaQSW0kpxpJSjK3FWFuMtYZSWiupxFZSirHFVmOLseaIMSiZc1Iy56SUUlorJbWWOSelg5BS56CkklKMpaQWM+ekdBBS6iCkVFKKraQUWyiltZJSjKWkFluMubYWWw0ltVhSirGkFGOLsdYWW42dlNZCKrGFUlpsMdbaWqs1lBJjSSnGklKMMcaaW4w1h1JaLKnEWFJqscWWa4ux5tRarq3FmluMucaYa6+19pxaqzW1VmuLseZYY4611tw7KK2FUmILJbXYWqu1xVhrKCW2klKMpaQYW4y5thZrDqXEWFKKsaQU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2rLpqrpsuqptu7Lr267t+rqnqrJtqq6sm6or66or27rr2rYveZ6qiqrqup6puq7qurqtuq5ta6opu6bqyrbpurbsyrKtu7Ks65qpurLpqrZsurKsu7Jr26os677ourqtyrLuq7Ls+7Kt67pr68Ivuq6tq7Ks+6os+8Zs28Iv67pwTJ6oqp6quq5nqq6ruq5tq65r65pqurLpurZsqq5sq7Ks264s27pmqrJsuq5sm64ry6os+74ry7otuq6vm7Ks66osC7ur68Yw27bui66r66os674qy7ru6rrvy7ot7Jqq6ropy75uyrLu27ouLLNu68bour6vyrbwq7Is/LruC8us+4zRdX1dtWVhWGXb93XfV45Z14VltW3ld22d8fq6Mey68Su3LizLatvGMuu2sry+bgy7sPNt4VdqqmrbpuvquinLvi7rutDWdV8ZXdf3Vdv2fVWWfd8WfqVtDMMyuq7uq7KsC68tK7+s68KyC7+wrLat/K6uK8Ns68Jy+8Ky/LovLKtu+76r60rX1pXl9n3GrtzGLwAADDgAAASYUAYCFCcoQcg5pBiEiikIIYSSQgipVIxJyZiTkjknpZRSUigltYoxKZlzUjLHpIRSWiqlpBJKaamUElMopbWUWosppRZDKa2VklorJbWWUooxtRZjxJiUzDkpmXNSSkqtlVRay5yjlDkoqYOQUiqptJJSi5lzkjrorHQQUiupxFRSii2kElspqbWSUoytxFRTazmGlGIsKcVWUmq1xVRba63WiDEpmXNSMueolJRaK6m0ljknqYPQUuegpJJSi6mkFCvnJHUQUsogo1JSaq2kEktIJbbSUoylpBZTi7mmFFsMJbVYUmqxpBJbizHW1lJNnZQWS0oxllRibLHm2lqrMZQSWyktxpJSbq3FXFuMOYaSWiytxFZSarHVlmNrLdfUUo0ptVpbjDXGlFOutfacWos1xVRra7HmVltuMdeeOymtlVJaLCnF2FqLNcaYcyiltZJSbKWkGFtrtbYWcw2lxFZKa7GkEmOLsdYWW42ptRpbbLWW1mqttfYaW225tFZzi7H21FKusdaaY021FQAABhwAAAJMKAMBEgUgmDEzQ5yqs7vMqbq7y6w7RERVu0NEVLU7xMxVu0PMVMVMVd1dzFTd3Q0AAAUOAAABNmhKLA4Qkgro4DiaJoqq6rq+r1iWKKqq68q2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mX1deXbj6Ax9BACAAQcAgAATykAUJ6hByDnEFIRIMQghhJRCCClFjEHInJOSMScllJJaKCW1iDEImWNSMuekhBJaCqW0FEpoLZQSWyilxdZaram1WEMorYVSWgultJhaqrG1VmPEGITMOSmZc1JKKa2FUlrLnKPSOUipg5BSSqnFklKMlXNSMuiodBBSKqnEVFKKMaQSW0kpxpJSjK3FlluMOYdSWiypxFZSirXFlGOLMeeIMQiZc1Iy56SEUlorJbVWOSelg5BS5qCkklKMpaQUM+ekdBBS6iCkVFKKMaUUWygltpJSjaWkFluMObcUYw0ltVhSirGkFGOLMecWW24dhNZCKjGGUmJsMebaWqsxlBJbSSnGklJtMdbaW4w5h1JiLKnUWFKKtdWYa4wx5xRbrqnFmluMvdaWW685B51aqzXFlGuLMeeYW5A15947CK2FUloMpcTYWqu1xZhzKCW2klKNpaRYW4w5txZrD6XEWFKKtaRUY4ux5lhjr6m1WluMuaYWa6459x5jjj21VnOLseYUW641595rbj0WAAAGHAAAAkwoAwESBaAQqTJDHCKzu8whMrvLLLM7RM0yu0PMtDvETFW7Q8xUxUxN1V3MzFTdDQAABQ4AAAE2aEosDhCSCujgOJbleaJoqrLtWJLniaJpqqptO5bleaJomqpq25bniaJpqqrr6rrleaJoqqrqurruiaJqqqrryrLue6JoqqrqurLs+6apqqrryrJsC79oqq7qurIsy76xuqrryrJs67YwrKrrurIs27ZuDLeu67rvC8NydG7d1nXf94Xjd44BADzBAQCowIbVEU6KxgIDkgGYbOTIciTLsiXbBgCAAQcAgAATykASBSAQyczMnMzMzMzJzMzMzEREREREREREREREREREREREREREREREREREDAD+Ew4A/g82aEosDhASDigwRimmHINOQkoNY45BKCWllFprGGMMQikptdZS5RyEUlJqLbYYK+cglJRSa7HG2EFIqbUWa6y15g5CSqnFGmsONodSWosx1pxz7z2k1FqMtdbce++ltRhrzTn3IIQwLcWYa649+N57iq3WWnMPPgghVGy11hx8EEII4WLMPfcgfA9CCBdjzrkHIXzwQRgAuBscACASbJxhJemscDQ4EhKgILIyu7tDRESkKrO7O0RExEyqMru7w0NETDSzuztE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TNVMVVVVO8xUzVRV1b1M1V3V3V3ey1RdVdXdXT5ETdXdXV7eQ1RV3d1dZsZM3d1dZmZmzFTd3WVmbs7M1V1mZmbmTFXdZWZmZk7VXd5lZmbuVN3lZeZmbg4A3A0OABAJNs6wknRWOBocEhIgITK7u7vDO0SkKrO7uztERESqMru7u0NERDSzuztERERERDO7u0NEREREvLs7RERERETEu7tDRERERES8O0RERERERMS7Q0RERERERDxERERERETExENERERERERERERERERERMxERERERERERMRERERERMRExERERERETERMxERERETEzMTETERERETMxEzEDAAABw4AAAFG0ElGlUXYaMKFByBCBqihHoMMPgiHQYiltx40hZiD1nqwIINScg7CYoghxqQHDTroJKUcNMYccg5y8BiEzDHBuMaYI2mIAqFj0ChT0ANCBiiBGnPtMdYIMeYglZZLhZSCUmIvlVLKQWi5ZkohpZzl0jGmGGMUawkdUgZBKyF0SiGiqKXWSugQcpJyjLF1igEUBSCYGTMyo7vLtEy6s8zLpLvTvMzLzOVktszkTWa6O81LtcxkzuVTTebkDQAAAQ4AAAEWQhQFIJmhKqqiqrorO6qqs7qjqjqru7o7xEOsM8M7RKqqs7qru0O0w7o7xEMMAAABDgAAARZCFCfoITmeJ2mWKEqWJoqeKMquJ5quLGmaKWqiqKqWJ6qqqaq2LZqqbEuaJoqa6KmqJoqqKqqmLZuqatueadqyqbq6Laqqbsu27fuubAu/Z5qyLKqqrZuqa+uuLfu+bOu6MGmaaWqiqKqaKKqq6aq6baqubWui6LqiqsqyqKqyrMqyLayyrPuWKKqqp5qyK6qqLKuy69uqLPu+6bq6rsqy76uy7Ou2LwzL7ftGUVVt3ZRdX1dl2fdt3ebbvm+UNM00NVF0VU0UVddUVd02Vde2LVFUVVFVZdkzVVdWZVnYVVe2dU0UVVdUVVkWVVWWVdn1fVWWdVtUVVtXZdnXTVf2fd33sWXdN05V1XVVtn1jlWVf131faeu673umKcumq/q6qaq+Luu+UbZ1YRhVVddVWfaNVZZ9Yfd9dOMnjKqq66rsCrsq276wGzth931jmXWbcfu+cty+riy/seQLcW1bGGbfZty+bvSNXxmOZcgzTdsWXVXXTdXVhVnXjd/2dWMYVdXXVVnm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RLy7O0RERERExEzMu7tDREREREzMxDw8RERExMTMzMzMw0NERERExMxMzERERERExMTMzMxMRERERERMzMzMzERERMTEzMzMzMxMRERERMTMzMzMzERERMzMzMzMzMxMREREzMzMzMzMzERERMTMzMzMzMxMRETMzMzMzMzMzETExMzMzMzMzMxMRERMzMzMzMzMzERERMzMzMzMzMxMRExMzMzMzMzMzAwAQAcOAAABRlRaiJ1mXHkEjihkmIACEgUgEEFERBxEREREQkRERERERERERERERERERERERERERERERERERES8uwuA0RcOgNETNmhKLA4QkhYoMIYxx5yCTDoqKaXUMAWhhBBKSSWVlGJqGIMQQgilpJJSaqll0FFKqZSUWmuttRozByWlVEpKKbVWW6wdhJRSSqm12nKtNdcOQkoptdRajDHGWGsHIZWWWosxxlxr7b2DUFJqrcUYa6255xxKSa3FGGvttfbeew6lpNRirLn2mnvvPZeUWow155xzzz33nEtKMdYYc82555x77qW1Wmutveece++999RarbXm3HPPPffee2ux1tx7773n3nvvvcVYa625595777333mKtteeee++99957bzXWnHPPvefee++9FwByIxwAEBeMJKTOMqw04sYTMEQgAREDDEEQFIsPAIAJDgAAAVawK7O0aqO4qZO86IPAJ3TEZmTIpVTM5ETQIzXUYiXYoRXc4AVgQgYogRhrrjXnCEFpLdaeS6WUoxZ7ThkiyEnLuZTMEOSktdZChoxyEmNLIUNIQautlU4pxSi2GkvHGJOUWmypdA4CQgYo9GKEEEIIyVFLLQjfK+UclJp7rxgzCmLvvVLMIEc5+EwxpRyU2lPnmFLESK6tlUgR4jAHnSqnFNSgc+skhJYDFAUgICIzMiMzQzREMjNEQyQzQzTEQ8RUVDVE1ERVMjPEwzREVMVUw0RV1AwAAAEOAAABFkIUJyAhuiMzxDJDPETNQ1QtM0S7y7Q7TMxURUzVMkO0u0S7y8REVcxUPURVzFzFTF1VZVbV5UNUxUxVzFzVVV7VZS4zRLvLtLtMzFzFTF27yzxE1UPMTNXdTN21u8zDyzzEzNRczdRdzNRN1d3U3N1dZt1lxkxVzNxN1WVd5d1d7jJDtLtMu8vETFXM1LW7zEPUvMPM1NzNVF27yzzEzEPMTM3d1NzFzNVU3cXM3d1lVt1tzNRN1d1U3dXd7t1lPkRVzFzFzF1dZVZdZszcTdXdVN3d3e7dZcbM1dTcTdVd3W3eXW5dZdZd5t3tZmZ25nZXVWZdZdZd5uV1Zu72Q1TFTF3M1NVVZt1lxkzd1NzN1OXdbdZdbszcTdXdVN3d3ebdbVZVZt1tVl1mZvbeZXbdZd5dbt1lZu52Zu4OAAADDgAAASaUgQASBSCZITK7G6IqM8QZqjJDpCqzO0SqMrtDNLM7xEwzu0PMPMTETNVDxMxUDQAABQ4AAAE2aEosDhASEqAhqjK7u0PMVCWiKrO7O8RMVSKqMru7Q8xUrSorszvETNXVqiozu0PMVNU1M7M7RMRM1V0zM7tDRMxU3b27O7zETM1V3ru7Q8TMTNXdvTtExEzN1V3eu0NEzExV3V1GxMxMTdVVXmbEzMxMVdVdZk5NVdXVXV7m5sxUVdXdXWbmVtXV3V1m5uZuVdXd3V1m5u4OAAAHDgAAAUbQSUaVRdhowoUHIBQFIJghMzKju0M0RLozxEOku8u8TMvEXFS1TNREXbq7zMu0TFzFVMtE1dwMAGAHDgBgBxZCkgcgIqoyMzOjqiozszOqqjIzM6sqMzOzu6oyMzO7MzOzs7s7MzOzu7szs7O7uzszs7u7u7Ozu7u7O7u7u7u7CwBABQ4AAAE2imxOMBIUkgqgmKkyu0PMnCKzuzvEzKEyu7tDzCyzuzvEzMwyu7tDzMy0uztExExVu7tDRMxUvTtERMxM1btDREzMVEXEzMxUVV1EzMzM1FzNzExVVd3dzMxUVV3dDQDgCQ4AQAU2rI5wUjQWGJIBmG3kOHIjSZIkSQYAgAEHAIAAE8pAkgogGKoyO8xUpSqzO8RMVaoyu0PMVC2zO8RM1d0yu0PMVN29O8RM1V3mu0PMVN1lRsRM1V1mZkTMVN1l7s5M1V3mZu/MVN1l7u5W3V3m7m531d1l7m53DwAIDQ4AYAc2rI5wUjQWGJIHIKoyMzMzqyozMzOzqjIzMzMzMzMzM7MyMzMzMzMzMzMzMzMzMzMzMzMzszMzMzMzM7szMzOzszszMzO7uwsAQAUOAAABNopsTjASFBIOKDCGMeecg1BCKo1SzkEIoZRUWmmUcg5KCKWk1FrmnJSUSkmptdgy56SkVEpKrbXYSUiptZRai7HGDkJKraXWWow1dhBKaSm2GGvMtYNQSmqtxRhrraGUlmKLscZaaw6lpNZajLXWnHNJqbUYa601155LSq3FGGutteaeWouxxlpzzb331FqMNdaac+45FwBMHhwAoBJsnGEl6axwNDiSG6CpMru7Q0RERERErCqzuztERERERMSqMru7Q0RERERENLO7OzxEREREREQzu7tDREREREREvLs7RERERERMzMy7uztERERERETMvDtERERExMTEzMy7Q0RERETMxMzMRERERETExMzMzMxDRERERMzMzMzMRERERETEzMzMzExERERERMzMzMzMRERExMTMzMzMzExERETEzMzMzMzMRETEzMzMzMzMzExExETMzMzMzMzMRMTExMzMzMzMzExETMzMzMzMzMzMRETEzMzMzMzMzExEzMzMzMzMzMzMDABABw4AAAFGVFqInWZceQSOKGSYgAISDiAQUVVVVVVVnVRVVVVVVdXJVFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVdXMzMzMzMzMzMzMzMzMzMzMDFCXGQ6A0RM2zrCSdFY4GhySFigwhjHHHINOQikptdYwBaGE0ElJpZXYYmuUghBCCKWklFprrWXQUSkllZRaiy3GGDMHpaRUSkqpxRhjrR2ElFpqLbYWY8211g5CSSm1FluMtdZcewchldZayzHGYHPOtYNQUmqxxRhrrrX2HFJpLcYYa+251ppzEKWkFGOsNeaaa+65l5RaizXXXGsOPucgTEux1Rprzjn3IHTwqbUac8096KCDzj3olFqttdacew5C+OBza7HWmmvOvQcfdBC+1VZrzrnW3nvuPQfdYqy55qCDD0L44INwMdaec+45CB108D0YAHIjHAAQF4wkpM4yrDTixhMwRCABEQOYbBxJtm3btq5r27Zt27Zt27ZtBwDABAcAgAAr2JVZWrVR3NRJXvRB4BM6YjMy5FIqZnIi6JEaarES7NAKbvACMAIEKFIWagjJAgg5Bsk1hjFIRURKOebAdsw5aUVUTjnlRHTUUYa4F2OETkUAFAUgmKEzsqO7S71UujvN0xzEUz3VW81tZTbVZFXuOTzV0zVVbU7l01Xm7A0AAAEOAAABFkIUBaCYoSqqIjO7K0MyqzPDGzPDszvDu0vMrDvLw0wyszs7rDvMtMs6xMzLCwAAAQ4AAAEWQhQn6CBJnid5mihKmieKoim6riiaqmt5nml6pqmqnmiqqqmqsmyqqitbnmeanimqqmeaqmqqquyaqiq7oqrqsumqumyqqm67tuzrriwLv6iqsm6qrq2bqmvrrizrvivLvi95nqp6pum6nmm6ruq6tq26rm17qim7puq6sum6suy6sqyrrqzbmmm6ruiqsmu6rmy7sqvLquzauum6vq26rq+rsiv8sqzrwqzrznC6ru2rrqvrqizrxmzLui7rtu9Lnqeqnmm6rmearqu6rm2rrmvrmmnKrum6tiyariursqzrqivLumearmy6riybrirLquzquiu7umy6rm+rruvrpuv6tq3bxi/Ltu6brmv7qiz7viq7ti/runHMuuzbnqr6vinLwm+6rq/bvu4Ms20Lw+i6vq/Kti+ssuz7uq4cbV03jtF1hV+VXeFXXVkXdl+n3LqtHK9t82XbVo5Z94Vf14Wj7ftK17Z9Y9Zl4Zh1Wzh24zaOX/gJn6rquum6vm/Ksu/Lui0Mty4Mx+i6vq7Ksu+rriwMt60Lw637jNF1fWGVZV9YbdkYbt8Whl0YjuO1bb6s60pX1rGFX+nrxtG1baFs20JZtxm77zN2YycMAAADDgAAASaUgQAUJ+giSaIoWZYpSpYlmqZpuqpomq4raZppappnqprmmappqqpsmqoqW5pmmpqnqabmaaZpqqKsmqopq6Zp2rKpqrZsmqpsu66s664ry7Zpmq5sqqYsm6oqy67s2rIry7YsaZppap6nmprnmaaqqrJsqqrrap6nqponmq4niqqqmq5qq6ory5bnmaomaq7piabqmq5pq6qryrKpqrZtmqpsq66ry65qu74r27pvmqpsm6ppu6rryrYrq7pr27auS5pmmprnmabmeaZqqqbrmqrqypbnqaoniq6qaaLpqqrqyqrpqrrmearqiaKqaqLnmqqryq7qmrpqqqbtqq5qy6apyrYsy8Luqrarm6Yq26rr2rapmrYs27IvvLbqu6Jp2rKpmrZtqqosy7bt664s27aomrZsmq5sq65qy7Jt27ps27oumqpsm6qpy6rqurpsu7oty7atu7Lr26rq6rasy74tu7or7L7u+64ry7oqq7oty7YuzLZLtnVbJ5qmLJuqKsumqsqyK7u2Ldu2LoymKcuqq+quaaqyL9uybsuyrfumqcq2qrqybbqqbcuybOuyLvu6K7u67OqyrquqbOu6ruvC7Nqy8Lq2rcuybfuqrPq67ftCW1Z9VwAAGHAAAAgwoQwEEgUgmDG7Q5yis7vEqbq7y7QzRERNu0NETL07xEzVu0PMVMVMTdVdzExV3Q0AAAUOAAABNmhKLA4Qkgro4DiW5Xmmqaq67kiS54miqrqu7zuS5XmiqKqua9ua54miaaquLPvC5nmiaJqu68q6Lpqmaaqq68qy7ouiaJqqKruyLAynqqqu68qyrTNOVXVdV7Zl2xZ+1XVl2bZtW/eFX3VdWbZt29Z1Ybh13fd9YfgJjVvXfZ9uHH0EAPAEBwCgAhtWRzgpGgsMkgGYbORIcmTJsmXbBgCAAQcAgAATykAUJyAgUVVV1VNVVVVVVVVNVVVVVVVVVVVVVVXVVFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVT1VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVNVVVVVVVVVVVVVVU1VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVdXMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMwMAFIRDgBSDyaUgQCSCiCYqarCw7sjM7O7y8tDMjuzy9RctTtETFVVVbs7RMxM1bU7xFRdXVW7Q8xU1V29zEzV1t1lzMxcbW1dTlVV1m5mblVd3V3u5l7d3WXm5m7d7WVe5u4OADgNDgCgBzasjnBSNBYYkgogmakyu0PEG6KqOzxExCGyurvDwyszuztERMQyM7tDRES0uzs8xERMu7tDRETMPERERMRMzENEREREzETEREzEzExERERMzMxExETMxMxMRExEzMzMDACABQ4AAAE2rI5wUjQWGAIEoN3e7u6tOkTtnagybS6yQ20+urrtNbu77C2ZGWu1qaprABia4XAOkFoDUmsAAAAAAAAAkN4DXpxAixMAAAAAAAAA0ntAixFoMQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkN4D3pzAmxMAAAAAAAAA2pxAjBeYtwIAAAAAAABAmxOIdwKzXgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0nvAmxN4cwIAAAAAAABAmxOYtwJxXgAAAAAAAABocwKzXiDeCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAhwAAAIshAAUJ+BwzloAAHDWagsAAM5aawEAwForRgAAWGvFCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAGHAAAAkwoAwESBeBQRnuAtQBrAVoDtAZ4D/AeIEYAEAAAChwAAAJs0JRYHCASBeBQylprvYfWWnsPrbX2Hlp7L0a09l6MePG9OfHee3NizhjnBDHOGQAAChwAAAJs0JRYHCASEuBQzlqtvfdejHPWitbeizHGOWetFWu9F2OMc9ZaK1p7L8YY56z1XrT2XowxzlnrvXgvxjnnrPXee/FejHPOWeu9NyPGGOecs9Z7cwZzzjlnrffmDGKcs9Z7c84ZxDhnrffmnDeYc9Za7805b8Cctd6b896AWu/NOee9AbXee3PefQPuvTfnvHcHcG/OO+8dAAAOHAAAAoygk4wqi7DRhAsPQBQFIJipKqsaM81UzTHLTM2sTFVVzULUXUUsTN1VTFNV1eUtTM1c5krUTF0OAGAHDgBgBxZCkgcgkKkyu7vLTLO7Q8TMLLu7w8tMsztExMw0u0M8zMw7REREVb1DRMRMVURERExVTUVETFTV1EzETFVVRUTMDABABQ4AAAE2imxOMBIUkgrgcE5rrbX13pwrrffee+/FOdta77333ntzeu+9+GKMc07xvRfjezHO6db3Yoxxzjrd/F6cMdZaL957b8ab78Z7L855b97IOcZa2bD3nLfevTeoNeed9wY355v33gEAPMEBAKjAhtURTorGAgOSARhMpO3WNmm7td0GAIABBwCAABPKQBQFILi7u7u7u7u7u7u7u7u7u7szMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMLADsRDgA7ERZCEg4gICJC1czMzLSqqszMzMxMq6pKzMzMzEyzw8zMzMzMPMtMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzAwAJg8OAFAJNs6wknRWOBockhsgILI7Q8Rd3c3U3dXdwzPMVE3d3NxdXcU7TDzMXdXV1NXdQ8TU1VVV3VXdVUU8REVMVFVd1dxdXE1V1d1V1c3dzcTETETM3FRF1VTVzETMREzV1NRUTVVNzMREVETNVM3U1EPVxFRN1czUxEzFTNTMTE1V1NRM1czETFXFzMzUzMRMzcxMTM3MVNXMzNTU1MxE1cxUzczMzFTFzNTUzFRMTc3EzNTUzMxUTdVM1UTMzExUzEzVzExVTcRMzcxMVc1MVcXMTExMTc1UTVVVTc1MVE1VVVVVTc3M1EzFzAwAQAcOAAABRlRaiJ1mXHkEjihkmIACQgYoMaRB5ii0BpDFmJMUizHGGGOM8ZR4EFKrRVQiMgepFU2JxxiDFDwnIlPKUTCluNAxaEXmomMqKRdbjDHG92IEQgaoQKZJ5iSlRpjkFINSmnNOKaWU0hBZkkGKQXVkMuYk5QyRxpCC1DNFHlOKQQwhqdAp5rDV5GMJHcQalDHCpRQDGJrhkBKQWgNSawAAAAAAAACQXgNajEB7EQAAAAAAAABSe0CLD2gxAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQXgNejECLEQAAAAAAAABajECMFYh1AgAAAAAAAECLEXg1AnFWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSe0CLEXgxAgAAAAAAAECLEYh1Ai9WAAAAAAAAAGgxAnFWINYIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACHAAAAiyEABQn4HDOWgAAcFJqDQAATkqtAQBAay1GAABYrcUIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAYcAAACTCgDARIF4DBKa4C1AGsBWgO0BngP8CJgTgAQAAAKHAAAAmzQlFgcIBIF4FBKSmu9h9ZaixGttRYj3nsvRrz33pyI8b05EeN7c2LOGOcEMc4ZAAAKHAAAAmzQlFgcIBIS4FDKWu/FGOOctd6L1t6LMcY5a70Xrb0XY4xz1nov3ntxxjnnrPVevBfjnHPWWu+9eC/GOees9d578V6Mc85Z6705I8YY55yz1ntzBjHOOWet9+YMYpyz1nvvzRnEOGet996bM5izzlrvzTlnwJy13ptzzoBa7703570Btd57b857A+69N+ec9wZwb8457x0AAA4cAAACjKCTjCqLsNGECw9AFAUgmKkqqxqzxMzEMctMzaxMVdXMSlRVzaxMVdVMU1XVXa1MzVTVykxNVQ0AYAcOAGAHFkKSB6AQoTIzu8vMKrO7u8ysMru7y0wzs7u7zDQzu7vLTLO7u7vMNLu7u8vMu7s7xMzMvLtDzMxMxDvEzMy8u0MMAEAFDgAAATaKbE4wEhSSCuBwzlqttfZejCul9l58L8ZZV0rvxfhenLN678UYY5yzVjHGF2OMc9Yq5xjnnLPWe+0c45xz1nov5oyx1nvzxZwxznlvzsi7zlrvzRt7z1nrvTmDe+/NeXdw77057x4AwBMcAIAKbFgd4aRoLDCSAZhIZFuyLdmWbEsGAIABBwCAABPKQJIKIEBERERERERERERERERERERERERERERERERERERERERERERERERERES8u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7uwuA2BUOADsRNqyOcFI0FhgSDiCYmblb7u7urqqqxO7u7m4rqkpcZmZmZjNE1WVmZmY2u9NlZmZm5t1MXmZmZmbezWRmZmZmZmZeXmZmZmZm5mVmZmZmZmZmZmZmZmZmZuZlZmZmZmZmZmZmZmZmZmZmZmZmZmZmXmZmZmZmZmZmZmZmDgAmDw4AUAk2zrCSdFY4GhySGyCYqTI7u0NEzEzM1N27O0TEzMxUzVVlNbu7Q8TMTMxUXdW7O8TMTFVVVV3dvUNExMzMTFVV1VVExMxMTVVV1d1dRUTMzFRVVVXV3WXMRM3MVFXV1NVdXU3M1FRVVVXVXd3dzNRUVVVVVdXlXcVM1VTVVVXVXeblzE1VVVVV3VXe3eVVVVVdXVXVXV7dVVXVVVVd1dVl3t1VVdVVXV1VVd7dZVXdVdXV3dXlVd3VVdVdXVXd3eXl3V3VVVVV3V1eZd7VTVXV1V3d5V3e3V3dXV1VXV5mZl7mXVZV1VVdDQBABw4AAAFGVFqInWZceQSOKGSYgAJCBihS4FkopcVIgAMRcxR777333nuvjEcSMak9hp465iD2zHjEjHIUO+WZQ4hBDJ2HTikGMaVeSsYYxBh7jCGEEgNCBqhhEEIHJfbIIMWYg9YrhBBjUFrOFDJIOSixYwwhxKC0jDGFkGLSOucYQ0hB6iB0TinkqKTWUggdtFhzrq2lFAMUBdioAi4TuEwAAAAAAAAACAAAAQ4AAAEWQhQn4HFOa3gP7+E9vHfOeQ3v4T3EiBjPOe3hPbyHGBFje29G3Ip6sTP2bu/FiXpRK/bG3gAAAAAAAAAAAHjv1YpbcS/yRc7vvVpRK+5FzsgZAAAAAAAAAAAAL75bcS9uRc7I+b1XL+pFvcgbOQMAAAAAAAAAAODFuDdyRs7IFzm/GPdGzsgZNyNnAAAAAAAAAAAAvBj3Rs7IGTkj3xfj3sgZOSNn3BsAAAYcAAACTCgDARIF4FBKSq29h7XeixFrvRcjWntxTrQW45x4L8Za0VqMtQIAEAAAChwAAAJs0JRYHCASEuBRSkprrdXae+/FiLVae++9GOesE2u19t57Mc45J9Z6L8YY56y1VrT1XowxzllrrWjtvRjnrLXWe9HaezHOWWut96K992Kcs9Z7cwbvxThnrffmDAAAAAAAAAAAAAAAAAAAAAAQAAAOHAAAAoygk4wqi7DRhAsPQBQFIJghszKbqtTM1KnK1NSkTFzNXcvc3WU2Td1d5tLMXd01zWXeXUtd5t0NAGAHDgBgBxZCkgegEKmqMjPTzCqzu7vMrDK7u1NVs7s7RFUtu7tDVFWzu7s7VTW7u0NU1bu7uztVVb27u1tV1bu7u1VVNbu7CwBABQ4AAAE2imxOMBIUkgrgcM5ar70X45wppdZijLHWe1dKrcU4Y633aq21GOes9V6ttRbjnLXeq9b35qz13pzdG+Octd6bMwAAAAAAAAAAABAAwBMcAIAKbFgd4aRoLDCSAZhIZFuyLdmWbEsGAIABBwCAABPKQJIKKDCGMeeck1BKhBBjEEpJpaUKIcYglJJSa01jjEEoJaXWmsYYg5BKS601lTonJaXWYmyudQ5CSq3F2Jw0pZSUWosxSmlKKSm1FmOU0taUWosx1iilzym1FGOtUUopZWwtxlqjlFLK2FqMtRYAEBocAMAObFgd4aRoLDCSB6CYqTIzM0PEMjOzO0SsMjO7Q0Qzs7s7RDQzu7tDRDOzuztENDMzu0NEszuzO0REvDO7Q0TEO7M7REQ0M7sLAEAFDgAAATaKbE4wEhQSDigwRinGGHMOQimVUs5B6ByEUlKqEHIMQucglJJS85xzEEIoJZWWmuecgxBCKSm11lwLoZRSUmottiZjCKWUklJrMTbnRAihlJRai605J0LopLTUWozNORlLSam1GGNszslYSiotxVhrc845lVJqLcZam3POqZJSTDHW2pyU0tbUYoyx1iillDq3FFuNuRYATB4cAKASbJxhJemscDQ4khugmKkyu7u7u7u7u1NVs7s7RERERETE1DS7u0NERERERFTVuztEREREREREVb27Q0REREzMzFTVO0RERMTMzMxMVb1DRETEzMzMzFRVRERExMzMzMxMVVVFRETMzMzMzFRVVUTEzMzMzMxMVVVFRMzMzMzMzFRV1cTMzMzMzMxMVVVVzczMzMzMzFRVVdXMzMzMzMxMVVVVzczMzMzMzFRVVdXMzMzMzMxMVVVVVc3MzMzMzFRVVVXVzMzMzMxMVVVVVc3MzMzMzFRVVVXVzMzMzMxMVVVVVVXNzMzMzAwAQAcOAAABRlRaiJ1mXHkEjihkmIACEhIgGMnLzMzMzMyszMzMzMzMzMxKzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMDIDRGQ6A0RNG0ElGlUXYaMKFByCSFigwhjHGGHNOQiox1Vgp5ZxzjkFHIabaaoyUcs455yCkFFONOQfPOQchdBRaiam2GoPnnIMQQikpxRhrz8G1zkEoJaWWYoutxt5a5yCUklJrMdaacxBChBBSaq3FGHutNQghOuiotBZjrTn3HoRwrZTUWow15lx7DkK4VjoLsdWaa+69ByGEUKm1WmvPPfcchBBCqNBKTLn2HnzPQQghdG6t1tx77j0IIYQQtrZSU27B5x58EEIIIWSstfYgfBBCCCGEEDLElmPvQQghhBBCCB1szb0HH3wQQgghhBA25t6DD0IYAHIjHAAQF4wkpM4yrDTixhMwRCABEQMMAUAQCBgAABMcAAACrGBXZmnVRnFTJ3nRB4FP6IjNyJBLqZjJiaBHaqjFSrBDK7jBC8AAQgYok5ZazL3o0jkHpcUaTMYYc9JyMRlDSDmJuWQKGaOg5ZQxZIhhFFvoGDIGSUwphQwhBC222ErnGMRaa40plRIDGJrhkA6QWgNSawAAAAAAAACQ3gPai0B7EQAAAAAAAADSe0CLEWjxAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQ3gPenMCLEQAAAAAAAADajMCLFYi1AgAAAAAAAECLE4h1ArFWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADSe8CLEXhxAgAAAAAAAECLEYi1AnFWAAAAAAAAAGhxArFW4NUIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACHAAAAiyEABQn4HDOWgAAcNJqDQAATkqtAQDAau09AABYrb0HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAYcAAACTCgDARIF4DBKa4C1AGsBWgO0BngPEB9gTgAQAAAKHAAAAmzQlFgcIBIF4FBKSm29h9Zaew+ttfYi3nsvRrz3XoyI8b05EeN7c2LOGOcEMc4ZAAAKHAAAAmzQlFgcIBIS4FDKWu/F+N6Mc9aK1t6LMcY5a60Xrb0XY4xz1nor3otxzhjnrPVevBfjnDHWWeu9iDHGOeestd57EWOMc85Z6705Y845a52z1ntzBjPOOmet9+YMYpxx1ntz3hnEGOecteabM5hzzlrvzXlvwJy13ptz3oBaa703770BtdZ6b847A2q9N+e99wZw77057x0AAA4cAAACjKCTjCqLsNGECw9AFAUgmLEqqxozxVzMMctMRSxN1VXVylRdzSxMVdVMS13V1S3ERNTMQsxMzQwAYAcOAGAHFkKSByAQqbpDRMxMsztExEw0u0NEzMw7RETEzLxDRDzMzDtEzMzMREREzNRURMTMTFXNRMxM1MzMTMRM1cxExMwMAEAFDgAAATaKbE4wEhSSCuBwTluttfZejG2t1t5r7cU521qtvdZajPN6770X34txTu+99+KLMdZJji/GGOesVRZjjDHWWStenHHOXO/FizHOme/NuOa8ddZ7kfOcs14ZyNW9N18g55pzvQEAPMEBAKjAhtURTorGAgOSARhopNvSdmu7td0GAIABBwCAABPKQBQFILi7u7u7u7u7u7u7u7u7u7szMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMLADsRDgA7ERZCEg4gmCHKU1VVVa0qK01VVVVVo6o6U1VVVVW7O0RVVVVVxbNDVVVVVVVNVVVVVVVVVU1VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ0AJg8OAFAJNs6wknRWOBockhsgIDI7u8tEzEzVXN1dvLs7zMxU1VTd1b0zO8xMzMRMVVVVRMTDTM1U3cxd1UTMw8zETNXUzNxdTEzETFXVzNTV1U1NxcTETMzUVFVdxcxMVVVNVdXc3NXN1ERNxdTMVFXdTURNXM1dVdVUXc1FTc3UVMxMXdXVTFXM3NTMxMxMzFRVXc3MVE1V1NxcTc1MzVRNzcxU3czU1NXUTNXcxExVzc1U1UzNTE3NVc3MzVRMVc3UTFTd1VVVVcXU3MxMzdTMzcxM3MzMRc3U3M3dzczE1MzNXE3NXM3NVNTExAwAQAcOAAABRlRaiJ1mXHkEjihkmIACQgaoQaJJxRyUSIjEkGKOghBCCCGE0AxYUDlpOWUgKsUg5cqApQxy1CsFnkIKYu8gqNA5ikG0oGtssQaXgxBC+CAEGJrhkBKQWgNSawAAAAAAAACQXgPai0B7EQAAAAAAAABSe0CLD2jxAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQ3gNejMCLEQAAAAAAAABajMB7E4hzAgAAAAAAAECLEXgzAnFOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADSe8CLEXgxAgAAAAAAAECLEYhzAi9OAAAAAAAAAGgxAnFO4M0HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACHAAAAiyEABQn2LnLBACAu9sFAIC72wUAgN3tBgCA3e0GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAMOAAABJpSBABIF4DBKa4C1AGsBWgO0BngPEB9gTgAQAAAKHAAAAmzQlFgcIBIF4FDKSWu9h/daixHvtRYj4nwvRsz5Xoyo8705Uet7c+LeGOcEMc4ZAAAKHAAAAmzQlFgcIBIS4FBKSu+9F+OctdaK996LMcY5a70X770XY4xz1novYnxvzjlrvfdexPjenHPWeu+9mDPGOees9d6cMWeMc85Z6705o9YY55yz1ntzBjHOOWet9+YMYpyz1nvvzRnEOGett96bM5iz1lrvzTdnQJ213ptzzoBa770357wBtd57b847A+69N+ec9wZwb8457x0AAA4cAAACjKCTjCqLsNGECw9AFAUgmKkqqxqzRExEMkvERKzMzNTMQkxMzSzERFRMy1RVzSzEzFTEQszMRAwAYAcOAGAHFkKSB6AQITIzM8tEM7O7O0Q0M7u7y0wzs7u7zDQzu7vLzLu7u7vMvLu7u8vMu7u7u8zMvLu7y8zMu7u7zMy8u7sLAEAFDgAAATaKbE4wEhSSCuBwzlrvvRfjnC2l1t57L85aW0qtvRfjnLV6770YY4yzVu+9F2OMc9bq3hhjnHHWWuUbX4xz1norYoxxzlrvxZwxzlnrvch5zlpvzRd7z1lnrfeCe2u9N2dwb5235hsAwBMcAIAKbFgd4aRoLDCSAZhIZFuyLdmWbEsGAIABBwCAABPKQJIKIBDJzMzMzKSqzMzMzMyyy8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMxERAyA2BUOADsRNqyOcFI0FhgSDigwBiHGIKTUWowVQkpBKKW1FnOtEGIMQimttVhj0JhzUlJqMcYYg8ack5JSjDHWGlQKIaXWWow1x+BaCCm1FmOMtQchVGstxlhzzTkI4VpKMdaaa85BCJ1jrDXXnHsOQugcY6w155x7EEL4mmvNteacgxBC2NprzjnnHIQQQvieg8416OCDEMLnmnPOORcATB4cAKASbJxhJemscDQ4khugmKkyu7vDQ0RERFRdM7M7RMTMzMxMVTUzu8NDRETMzFTdu7s7RMTMzMxMVTW7u0NEzMzMzFTVuztERMTMzMxMVb27Q0REzMzMzNRVxENExMzMzMxMVVW9Q0TMzMzMzNTVVUREzMzMzMxMVVVFRMzMzMzMzFxdVUTMzMzMzMzMVVVVzczMzMzMTFVd1dXMzMzMzExNVVVVzczMzMzMzFRdXdXMzMzMzMxM1dVVVc3MzMzMzFRd1VXdTM3MzMxMVVVVVc3MzMzMzNzVVd1d1czMzMzUXd3VVVXNzMzMzAwAQAcOAAABRlRaiJ1mXHkEjihkmIACQgaoUeJR5yCUxogEkWJOijFGCCGE0BBYVDEHrYXgOgelxAyB5QxSTioElkMGMcgYeFAhpJxzIFKnlGJQgmslZMwBQgagqs1MzN2CpCpD7cVTO1T2pLUz3PYsOyrDbayzKsNdNESrsszE1LOqy1VmzbtLZffmvEMAGJrhcQ6Q1gLSagAAAAAAAACQWgPae8B6DwAAAAAAAABSa8B6DWjvAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQWgPae0B7DwAAAAAAAADae8CLEXgxAgAAAAAAAMB6D3jxAS9GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABOa0B7D2jvAQAAAAAAAMB6D3gxAu9FAAAAAAAAAGjvAS9G4MUIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACHAAAAiyEABQn4HAOWkNreA9w1sJ7eA8xAs5aeA/vIUYAAAAAAAAAAAAA2nuoFbXiVkB7D7OiVtQLAAAAAAAAAAAAwHoPtaJW3AtY72FWzIpaAQAAAAAAAAAAAHgxol7Ui1sBb0bciltRLwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAGHAAAAkwoAwEUJ+BxyloAAHDOWQsAAM45awEAwForRgAAWKvFCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAGHAAAAkwoAwESBeBQylpgrbXAWmuB1tYCrAZoD/AeIEYAEAAAChwAAAJs0JRYHCASBeBQylqtxai11lqLUWuttRaj91p7b0609t6ciPG9ORHje3NizhhrBTHWGgAAChwAAAJs0JRYHCASEuBwylrvxRhjjHPWqrXW3osxxjlrvVVrrb0XY4xz1lqv91qLcc4Y56z1XrQW45wzzlnrvXgvxjnnrLXWe/FejHPOWeu99yLGGOecs9Z77wUxzjlnrffmDGKcs9Za780ZxDhnrbXemzOYc85a7803Z8Cctd6bc86AWu+9N+e8AbXee2/OeQPuvTfnnPcGcG/OOe8dAAAOHAAAAoygk4wqi7DRhAsPQBQFIJixKqsas0RUxDFLxES0TE3V1ELUTM0sRE3VTNNU1VUtRM1UzULUzE0NAGAHDgBgBxZCkgegkKkyMzNDsyqzuzusqjK7u0szM7O7u8w0M7u7y0yzu7u7zLS7u7vLzLu7u7vMzLy7u8vMTMS7u8zMvLu7CwBABQ4AAAE2imxOMBIUkgrgcM5arbX2Xowrpdbeey/GOdtKrb33Xoxzeu+9GGOcs1bvvRdjjHPW6t4Y55yz1lrlHOOcc9Z6L+acs9Z7b8acc9Z6773Ye9Za780Ze9dZa745g3vrzXdvcO+9+e4dAMATHACACmxYHeGkaCwwkgGYbFxJsiRZkmxLBgCAAQcAgAATykCSCiCg2d3d3d0dPFVVVVXVOFNVVVVVVVVVVVVVVdVUVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUNgEsVDgC6DzasjnBSNBYYkgooMEYpppyTUEqFEGOOSUipxQohxpyTklKMxXPOQSiltRaL55yDUEprMRaVOiclpZZiKyqFTEpKqbUYhDAlpdZaaS0IoUoqsaXWWhBC15RaiiW2IIStraQUY4xB+OBjbCWWGoMPPsjWSky1FgAwGxwAIBJsWB3hpGgsMBISoJipMjMzu7u7SzMzs7s7RETENDO7u7tDRETMu7u7O0RERMTMPLu7Q0REREzVuztERMRExNS8u0NERMTMTM07RETERExMTVW9Q0RERMxUVVVERMRExExVVUVERETExFRVVUTETETMTFVVVUXERMzMVE1V1cRMRMRMTVVVRURMzMzUVFXVTMTEzMzMVFVVRUxMzAwAAAcOAAABRtBJRpVF2GjChQcgQgYohdhaai3mTlDjEJOWYyahcxKDUI1FEDmqvVWOKeUo9tRApIyS2FNFGVNMYo6hhU45abWW0imkIMWcUqiQctACQgYgKlXVzFUKpSpDZU7TssNcJa0z1HatuiG75CQzorrUNLsiMkS907Mqw9VkRDND5fVVvDsAGJrhcQ6Q1gLSWgAAAAAAAACQWgPae8BqDwAAAAAAAABSa8B6DWjvAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQWgPae0B7DwAAAAAAAADae8B7EXgxAgAAAAAAAMB6D2jxAS9GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSa0B7D2jvAQAAAAAAAMB6D3gxAu1FAAAAAAAAAFjvAS9G4MUHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACHAAAAiyEABQn4JESUkJKaA+Q1kJraA1zAtJaaA2tYU4AAAAAAAAAAAAAUmtoDa0hRkBqDa2hNcQIAAAAAAAAAAAAQGoNraE1xAhIraE1tIYYAQAAAAAAAAAAAHhzIkbEiDkBb07EiBgxJwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAGHAAAAkwoAwEUJ+BxyloAAHDOWQsAAM45awEAwForRgAAWKvFCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAGHAAAAkwoAwESBeBRylrgnLXAOWuBlNYCrAVoD9AaIEYAEAAAChwAAAJs0JRYHCASBeBQzlqtxSil1tqLUUqtvRej1t57b068996ciDHGORFjjHNizjlrBXPWGgAAChwAAAJs0JRYHCASEuBRylqtvfdejHPWKaXW3osxxjnnrFVKrb0XY4xzzlmrtVp7L8YY56y1VrT2XowxzllrvXjvvRhjnLPWe/HeezHGOGet9yLGGOecs85a7wUxzjlnrbXeC+KLcc5a770XvBfjnLXeei+Ic85aa703Z8Ccc9Z6b86AWmu9996cAbXWeu+9OQNqvffenHMGcO+9OeccAAAOHAAAAoygk4wqi7DRhAsPQBQFIJixKqsas0RUxDFLREW0TNVc1ULUTM0sRM3UTFNV1VUtRM3UzELUTM0MAGAHDgBgBxZCkgegmKkyM7tLoiqzu7skqjK7u8sqs7u7u8w0O7u7y8y7u7u7zLS7u7vLzLu7u7vMzLy7u8vMTMQ7vMzMvLu7CwBABQ4AAAE2imxOMBIUkgrgcM5arb0X45wrpdbeey/GOVtKrb33Xox1eu+9GGOcs1bvvRdjjHPW6t4Y55yz1nrlHOOcc9Z6L+acs9Z778Wcc9Z6773Yu9Za780Ze9da6705g3vvzXlnkPO9+e4cAMATHACACmxYHeGkaCwwkgGYbGRJsiNZkmxLBgCAAQcAgAATykCSCiCY2d3d3d0dvN3d3d3dQNvd3d3d3d3d3d3d3V3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3V1VVVVVVVVVVVVVVVVVVVUNgH4VDgD+DzasjnBSNBYYEg4oMEYpxhyDUEopFUKMOScdldZirBBizDkJKbUWW/GccxBKSKW1GIvnnINQSkqx1VhUCqGUlFKLLdaiUuiopJRSazUWY0wqqbXWYquxGGNSCi211mKMxQhbU2otttpqLMbYmkoLLcYYYzHCFxlbi6m2WoMxwsgWS0u11hqMMUb31mKpreZijA++thRLjDUXALgbHAAgEmycYSXprHA0OBISoCCqMjMzu7u7yyqzs7u7Q0TErDIzu7tDRERMM7O7O0RERMTMNLs7RERERFTVuztERERExMy8u0NEREREzMxDRERERMTEzFRFRERERETUVFVERMRMxERNVUVERETMTFRVVUTETETERFVVVUVERMzMVFVV1cRMTMREzVRVxUREzMxUVVXNTMTExMxMVVVVRUTEzAwAAAcOAAABRtBJRpVF2GjChQcgQgaohJhqaTHWTFgkEZNWWwUdY5BiL41FUjmrvVWOKcSo9dI4pIyC2EslGVMMYm4hhU4xabWmEiqkIMUcU6mQcpACQgagMVXV1FUKpSpDXcXKssNUJbU7VG4tuiG71CwzojrUtMOqskNFVLMqw91kPDM7ZW1NPDMAGJrhcQ6Q1gLSagAAAAAAAACQWgPae8B6DwAAAAAAAABSa8B6DWjvAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQWgPae0B7DwAAAAAAAADae8CLEXgxAgAAAAAAAMB6D3jxAS9GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABOa0B7D2jvAQAAAAAAAMB6D3gxAu9FAAAAAAAAAGjvAS9G4MUIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACHAAAAiyEABQn4JESUkJKaA2Q1kJraA1zAtJaaA2tYU4AAAAAAAAAAAAA0mtoDa0hRkBqD62hNcQIAAAAAAAAAAAAQGoNraE1xAhIraE1tIYYAQAAAAAAAAAAAGhzIkbEiDkBb07EiBgxJwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAGHAAAAkwoAwEUJ+BRyloAAHDSWQsAAM5JawEAwForRgAAWKvFCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAGHAAAAkwoAwESBeBRylrgnLXAOWuBlNYCrAVoD9AaIEYAEAAAChwAAAJs0JRYHCASBeBRylqtxeictVqL0UlrtRajtVp7b0609t6MiO+9OfHee3NizhhrBTHOGQAAChwAAAJs0JRYHCASEuBxzlrvxfhejHPW6py13osxxjlrrdU5bb0XY4xz1lqrtVp7L8YY56y1XrT2XowxzlnrvXjvvRhjnLPWe/HeezHGOGet9yLGGOecs9Za7wUxzjlnrbXeC2KMc85aa70XxBjjnLXWey+Yc85aa703X8CctdZ6772AWmu9996cAbXWeu+9OQPuvffenHMGcO+9N+ccAAAOHAAAAoygk4wqi7DRhAsPQBQFIJixKqsas0RUxDFLREW0TNVU1ULUTM0sRM3UTFNd1VUtRM3UzELUTM0MAGAHDgBgBxZCkgegmKkyM7tLoiqzu7skqjK7u8sqs7u7u8w0u7u7y8yzu7u7zDS7u7vLzLu7u7vMzLy7u8vMTMQ7vMzMvLtDDABABQ4AAAE2imxOMBIUkgrgcM5arb0X45wrpdbeey/OWltKrb0X45y1eu+9GGOcs1bvvRdjjHPW6t4YY5xzzlrlHOOMc9ZaL+acc85a78Wcc85Z673Yu9Za770Xe9da6703g3vvvTdnkO+99+YcAMATHACACmxYHeGkaCwwkgGYbGRJshxZkmxLBgCAAQcAgAATykCSCiAQ2d3d3d0ds93d3d1dudvd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d0NgNgVDgA7ETasjnBSNBYYEg4oMAYhxqCTUEopFUKMQSchldZirBBiDEIpKbXWYvKccxBKaam1GJPnnIOQUmsxxphcCyGllFqKLcbiWgippNRai7EmY1RKqbXYYqy1F6NSKi3FGGOswRibU2sxxlhrLcbo3EosMcYYaxFGGBdbjLHWXoswRsgWS2u11hqMMcbm1mKrNedijDC6ttRarTUXAEweHACgEmycYSXprHA0OJIboCCqMjO7u7u7Q0TUKrO7O0RERMTMTK0yu7tDRERMzMxUM7M7REREzMzMzFU1u0NERMzMzMxc3bs7RETMzMzMTFW9u0NEzMzMzMxUXURExMTMzMzMTFVVRUTMzMzMzMzUVVVEzMzMzMzMTFVVRUTMzMzMzMxU1d3MzMzMzMzMTF1dVcXMzMzMzMzUVVXVzMzMzMzMTFVdVc3MzMzMzMxc1VXVzMzMzMzMTFVVVVXNzMzMzMxUVd1VVVXVzMzMzN1V1VXVzMzMzMxc3d1dXdXMzMzMzN1dVVVVzczMzMwMAEAHDgAAAUZUWoidZlx5BI4oZJiAAkIGqGFacmm550ZQJJWjWmvJqHKSYg4NRVBBq7mGChrEpMUQMYUQkxhLBx1TTmqNqZSMOao5thAqxKQGHVOpFIMWBEIGIDnk3N3dmrq6TN2jybHDVL48RF3urEGhulS9QqIy1EXTqrLLVVyzKkPeZDwzO3V1TTwzABia4XEOcFoDzmoAAAAAAAAAkFoDWoxAexEAAAAAAAAATmtAiw9oMQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcFoDWoxAixEAAAAAAAAAWoxAnBWIcwIAAAAAAABAixF4MwJxVgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATmtAixFoMQIAAAAAAABAixGIdQIvTgAAAAAAAABoMQJxTiDWCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAhwAAAIshAAUJ+BxDlJCSngNcNbCe3gNcwLOWngP7WFOAAAAAAAAAAAAANJreA/vYU5Aag/v4T3MCQAAAAAAAAAAAEB6D+/hPcwJSO/hPbyHOQEAAAAAAAAAAAB4c2JOxIk6AW9OzIk5MSsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAABhwAAAJMKAMBFCfgcUpKAABwUloLAABKSmsBAMBa6z0AAEhrvQcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAABhwAAAJMKAMBEgXgUcpa4Jy1wDlrgZTWAqwFaA3wGiBGABAAAAocAAACbNCUWBwgEgXgccparcXonLVai9E5a7UWo7Vaay1GtNVajHjvvTnx3ntzIsYY5wQxzhkAAAocAAACbNCUWBwgEhLgcc5a78UY45xz1uqctd6LMcY5a73XOWu9F2OMc9Z6r7Vaey/GGOes9V609l6MMc5Z671oLcY556y11nvR2otzzllrrffivRjnnLPWe+8FMc45Z6333gtinHPOWu+9F8QY55y13nsvmHPOWuu9N2fAnLXWem/OgFprvffmnAG11nrvvTkD7r0335xzBnDvvTnnHAAADhwAAAKMoJOMKouw0YQLD0AUBSCYsSqrGrNEVMQxS0RFtEzVVNVC1EzNLETN1ExTXdVVLUTN1MxC1EzNDABgBw4AYAcWQpIHoJipMru7S6Iqs7u7JKoyu7vLKrO7u7vMNLu7u8tMs7u7u8w0u7u7y8y7u7vDzMy8u7vLzEzEu7vMzLy7uwsAQAUOAAABNopsTjASFJIK4HDOWq29F+OcK6XW3ntxzjlbSq29F+Occ3rvvRhjnLNW770XY4xz1ureGOOcc85a5RxjjHPWWivmnHPOWmvFnHPOWeu92LvWWu+9F3vXWuu994J77703Z3DvvffmHADAExwAgApsWB3hpGgsMJIBmGxkSbIjWZJsSwYAgAEHAIAAE8pAEg4gEGFmZmZmZh4zZmZmZmZmuWJmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm3t3d3Q1gOBcOAGURNs6wknRWOBocEhIoMAYhxqCTUEoqKVUIMeaglFRaaim2CiHGIJSSUmuxxVg85xyEklJqKabYiueck5JSazHGGGtxLYSUUmottthibLKFkFJKrcUYa43NKNVSai3GGGOssSjlUkqtxRZjrDUWoWxurcUYa6211qSUzy3FVmuNsdaajDJKxhhrrbHWWotQSskYU0yx1lprEsIY32OMscaca01KCON7TLXEVmutSSmljJA1phprzTkpJZQxNrZUU845FwCgHhwAoBKMoJOMKouw0YQLD0CSGyAhqjIzu7u7u7s7VCqzs7s7REREREQlMjO7u0NEREREVDOzuztERERETExVNbu7Q0REzMzMVNW7O0RERMzMzExVvbtDRETMzMzMVFVERERExMzMzExVVUVEREzMzMzMVFVVRETEzMzMzExVVUVERMzMzMzMVFVVxMTMzMzMzExVVVVFzMzMzMzMVFVV1czMzMzMzExVVVXNzMzMzMzMVFVV1czMzMzMzExVVVVVzczMzMzMVFVVVdXMzMzMzExVVVVVzczMzMzMVFVVVdXMzMzMzExVVVVVVc3MzMzMDABABw4AAAFGVFqInWZceQSOKGSYgAJCBihyUlNqPQcJMcicxCA0hCRijmIunXTOUS7GQ8gRo6T2kClmCIJaTOikQgpqcS21jjmqxcZWMqSgFltjqZBy1ANCBihxFGuNsdeKGAahpBpLQxBjUGJumTFKOYm5dUop5STWFDKlFHOWYgkdU4pRiqmEkDElKcYYYwqdtJZzzy2V0gIUBeCQkpSklF4To/hSe2L0IoAUn/e8l170nvcApBi9570Uo/e8FwAAAhwAAAIshAAUJ+CS0ntSek9K72ktRsSYWovRe3N6bUZz1opaU2sxem9O7cVpzlpR64uxVrXeq8575b03dn4x1qrWe816r533Rt4AAADSa3VqbU6tzSnGOlFram9Wrc2ptTnFOCtqfTPea857zXmve3NGzi/Oe81ZrznvdW/OyBkAAEB6r1atzam1OcU4K+pM79WqtTm1NqcYa8Wsb857zXmvOe91c87Y+c15rznvNee98s0ZOQMAAGhz7izGfMV4rznvxb1tzrzFeLMY7zXnvbg31rqzOndWa87uzRk5x1rzNmveas3ZvTkjZwAAAAAAAAAAAMRa91ZrzurM2b05I+dY695qzdmsObt3Z+QcAAAGHAAAAkwoAwESBeBRzlqtxeictVqL0zlrtTajlFp7b0609d6caC3GWtFajLUCABAAAAocAAACbNCUWBwgEhLgcc5arb33Xoxxzumctd6LMcY556zVOWu9F2OMc85Zq7Vaey/GGOestVa09l6MMc5Za61oLcY556y11nvRWoxzzllrrfeitfdinLPWe+8F78U4Z6333gsAAAAAAAAAAAAAAAAAAAAAEAAADhwAAAKMoJOMKouw0YQLD0AUBSCYIbMymyrEzMSpwsTELMRcTVVL1N3dtUzd3d3KzF3dNUzd3V1L3N3dDQBgBw4AYAcWQpIHIKGpMru705kqs7s7nakyu7vTqqq7O0RVrbK7O1RVs7u7O1U1u7u7U9W7u7s7Vc28u7tT1cy7uztVzTS7uwsAQAUOAAABNopsTjASFJIK4HDOWu+9N+OcK6XWYoxxzlpXSq3FOGOdtVqrtRjnrPVerbUW45y13qvW9+as9d571RvfnLXemzMAAAAAAAAAAAAQAMATHACACmxYHeGkaCwwkgEYbSQ3khtZkmxLBgCAAQcAgAATykCSCigwRinnnJOSSoUQY85BKKWlCiHGnINQSktRY4xBKCWl1qLGGINQSkqtRddCKCWllFqLroVQSkqttRalVKmU1FqLMUqpUimttRZjlFLnlFqL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MzOzu7szMzO7uzszM7O7uzMzMwsAQAUOAAABNopsTjASFBIOKDCGKeccg05KKhVCjEHonJSUWqoQYgxCCKWk1FrznHMQQiglpdaa55yTEEIpKbXWXAuhlFJKaq215loIpZSSUmsxNudECCGVlFprsSklQggppdZajEkpGUtJqbUYY0xK2ZhKSq21GGNSSinXWosxxhqTUkq51lJrsdaalFLK59hijLXWpJRSQsgWU405FwBMHhwAoBJsnGEl6axwNDiSG6AhMjO7u7u7u7u7yyqzuztERERERMSsMru7u0NERERETLO7O0RERERERMTMvLtDREREREREzMy7Q0RERERERMTMvLtDREREREREzExERERERERERMTMzEREREREREREzMxMRERExERERMTMzEREREREREREzMxMRERExMxERMTMzMxERMTMREREzMzMTMzEzExMzMTMzMzEzMxMxEzMzMzMzMzMTERMRMTMzMzMzMxMxMTEzMzMzMzMzEzERMTMzMzMzEREREzEzMzMzMzMzMRETMTMzMzMzMxEzMREDABABw4AAAFGVFqInWZceQSOKGSYgAISEiAYUVVVVVVVVR0zVVVVVVVV1TlVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV1czMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMwMgNEZDoDRE0bQSUaVRdhowoUHIJIWKDCGKcYYcw5CKaWkVCnlHHSOSUelpdZijJByDkLnJKTUWowxBs9BCCGEElppLbYYg+gghBBCKa21FmOMQcYQSiklpZZii7HmIGPoJJSSUms15lhzEEKUUFJqrbUYa805CCE66Ci11lqNtdYchHA1lJRaqzHWHHMOQshUOgqxxRhjrLUGIYRQLaUYa8w15p6DEEKo1DpsNQaba65BCCF0bq21WGvNNdgghBA+uBZbjLXWWmsQQgghbI0txpxrzEEIIYQQssYYY8051xyEEEIIn2ONsdZcaw9CCCGE77HGWGuuuRYAciMcABAXjCSkzjKsNOLGEzBEIAERAwwBMBCPDgCACQ4AAAFWsCuztGqjuKmTvOiDwCd0xGZkyKVUzORE0CM11GIl2KEV3OAFYEIGqKFYcy5CCUk5KKXlpCyllHNUi/IUMopJ7EFkCikGLSfTMaUUg5hbCR1TBkmOMXVKGcEs6F46xxS0ZIRMpYRUA0IGILltd2f3ostd3uYsqkNVZj4aqkvlTqMhQ13WKxoy1NU8oyFMZs0rGkNv3sSzw93m1cRDABQF4JCSlKS03hOf+NZ7XvQigPSe1ryX3tOe9wCk+LyntfSi97QWAAACHAAAAiyEABQn4JLSe1J6T0rvaS1GxLhai897MXotRnHOiTpXay96L0btxWjGOjHni29Oc95qzlrdnDPyfS/Oac56zVmrfHNGzgAAANZrc2ptRq3NKcY5Medqb06txam1OcU4J+Z8MdZqzlrNWat778W9L85axVmrOWt17724FwAAQHptTq3NqbUZxTgn5lztzam1ObUWpxjnxJxvxlvNeasZa1Xvvbj3xVmvOWsVZ61uvRf3AgAAaDPeK8ZbxVirOW9FvS3Oe8VYrxhrNWe9qDXWma857zXnvWq9F/nGWW82573mvFe99+JmAAAAAAAAAAAAxDpzNue95rxXvffi3jhrzua815z3ujVf3BsAAAYcAAACTCgDARIF4HJOSmu955yUVnvPOSm19p6U1motRqzVWoxo7b0Y0dp7MQIAEAAAChwAAAJs0JRYHCASEuByTkprtfZejHPOKZ2UWnvvvRjnrFVKa7X23nsxzlmrldZq7b0Y56y1XqzV2nsxzlnrvWittRhjnLPWe9FaezHGOGet96K192Kcs9Z7cwbvxThnrffeCwAAAAAAAAAAAAAAAAAAAAAQAAAOHAAAAoygk4wqi7DRhAsPQBQFIJghszIbK8zMxCnDzMQkRFRNVUvU1d01TNXd3crM3Vy1TN3VXcvU3d0NAGAHDgBgBxZCkgegIaoyMzNToiozszslqjIzu1OiKrO7O1WtMrO7U9UqM7s7Va0yM7tTVTMzsztVzTQzu1NVVTMzM1VVNTMzCwBABQ4AAAE2imxOMBIUkgrgcc5arbX2XozpnLXeizHGOdc5a70XY4xzWqu192Kcs1ZrtfZejHPWas73Ypyz1nvV+l6Mc9Z6LwAAAAAAAAAAABAAwBMcAIAKbFgd4aRoLDCSAZhtJDeSG0mSJEkGAIABBwCAABPKQJIKqDBGKcack5JSZYxSzkEopbXKIKWcg1BKa81SSjkHJaXWmqWUck5KSq01UzIGoZSUWmsqZQxCKSm11pwTIYSUWouxOSdCCCm1FmNzTsZSUmoxxuacjKWk1GKMzTmnXGstxpqTUkq51lqMtRYAEBocAMAObFgd4aRoLDCSByCqqjIzM7OqKjMzM6uqMjMzu6oqMzOzu6syMzO7OzMzM7O7MzMzM7s7MzMzs7u7MzMzu7s7MzOzu7szMzMLAEAFDgAAATaKbE4wEhQSDigwhinnnINQSioVQoxB6KCUlFqrEGIMQgilpNRa1JxzEEIoJaXWouecgxBCKSm1FlULoZRSSkqtteha6KSUklJrMUYpRQghpZRaazE6J0IIJaXUWozNORlLSam1GGNszslYSkqtxRhjc84511prLcZam3POudZSbDHW2pxzTvfYYqyx1uaccz63FluNtRYATB4cAKASbJxhJemscDQ4khugqTIzu7u7u7u7u8sqs7s7RERERETErDK7u0NEREREREyzu7tDRERERETEzLy7Q0RERERERMzMuztERERERETEzLy7Q0RERERERMxMRERERERERETEzMxERERERERERMzMTERERERERETEzMxERERERERERMzMTERERERExETEzMzMRERETERERMzMzExEzMxMRETEzMzMRExMRERExMzMzMxMxExERETEzMzMzMzMRERERMzMzMzMzEzERETEzMzMzMxEzERMRMzMzMzMTMRERETEzMzMzMxERExERAwAQAcOAAABRlRaiJ1mXHkEjihkmIACkhYgGNnd3d3d3d3dHard3d3d3d3d3ana3d3d3d3d3d3V3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3dXVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVDdgFGw6A0RNGElJnGVYaceMJGCKQAJIWKDCGMcYcgw5CKSmlVCHkHITQSUiltdhijBByDkIIpaTUWmwxBs9BCCGEUlqKLcYYi+cghBBCSq3FGGOMQbYQSiklpdZajLHWIlsIpZSSUmsxxlprMMaUUlJKrbUaa4y1GGNCCSm11lqMudZajI+1pJRajDHWGGst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EgXgcMparcUopdZei1FKrb0Xo9bee29OvPfenIgxxjkRY4xzYs45awVz1hoAAAocAAACbNCUWBwgEhLgcM5a78X4Xoxz1mqt1t6LMcY5a73XSq29F2OMc9Z6r9Zaey/GGOes9V609l6Mc9Za6714L8Y556z13nvxXoxzzlnrvfcixhjnnLPWe3MGMc45Z6335gxinLPWe3POGcQ4Z6333pwzmLPWWu/NeW9ArbXem/PegFrvzTnnvQG13ptzznsD7r055733BnBvznvvHQAADhwAAAKMoJOMKouw0YQLD0AUBSCYsSqrGqtEVMQpS0RFtMxUVc1C1EzNLERN1UxTVdVVNUTN3ExD1EzNDABgBw4AYAcWQpIHoJghMjO7S6Iqs7u7JKoyu7tLM7O7u7vMNDO7u8vMu7u7u8y8u7u7y8y7uzvEzMy8u0PMzExExMPMzDy8wwsAQAUOAAABNopsTjASFJIK4HDOWq21FuOcLaXW3ntvxjpbSq29916ctXrvvRhjnLNW770XY4xz1ureGOOcs9Z75RxjjHPWei/mnLPWe2/GnHPWeu+92LvWWm/OGXvXWeu9OYN77805b5DvvTnnHQDAExwAgApsWB3hpGgsMJIBmGxjSbIkWZJsSwYAgAEHAIAAE8pAEgUgmFll7h4z5e5uOenu7u7c7u7uburr7u5t7u7ubu7s7u7u7u7u7u7u7g4AuhMOALoPNmhKLA4QkgooMEYp5yCUlFKFEGPOSSkppQohxpyTklprNWPMQUgptdSCxhyDkFJrrdWUOicltRZTqyl1TkpqLcZWcy2llNRaa6nGXkoJLbUWa821xlJSaimm2nKsqbTSWowx1pxbS6ml2GqtNbiWSkwxFgAwGxwAIBJsWB3hpGgsMBISIJmpMru7Q0REzKoqs7tDRETErKoyu7tDRERMM7O7O0RERMTMNLO7Q0RERMzMu7s7RERExMy8u7tDRERE1NS7uztERETEzFS9u0NERETUVFVERERERMTUVEVERERExFRNVURERERERE1VVUVERERETFVVVcxMRERETVVVRURERERUVVXVTERERMRUVVVVRURERAwAAAcOAAABRtBJRpVF2GjChQcgEgUoUlZb7cE4AlEmrebQIMok5qIrhpSj2FOkEFIQc4uYQgpabRVzikGLtXMMISeth9ApxSAEAAAAAAgAAAAVAAAANAAAADwAAABLAAAAagAAAI4AAAASAQAAZgEAAHoBAADKAQAA1gEAAPABAAArAgAANwIAAFECAACMAgAAkwIAAL8CAADrAgAAjwMAAJMDAACZAwAApQMAAMkDAABNBAAAUQQAAFcEAABjBAAAggQAAK4EAABSBQAAWQUAAGYFAACFBQAAjQUAAJwFAAC7BQAAwgUAAO4FAAAaBgAAbgYAAIIGAADGBgAA0gYAAOwGAAAnBwAAMwcAAE0HAACIBwAAjwcAALsHAADnBwAAOwgAAE8IAACfCAAArQgAAMcIAAD4CAAABAkAAB4JAABZCQAAZQkAAGwJAAAQCgAAPAoAAJAKAACkCgAA9AoAAAgLAABYCwAAZAsAAH4LAAC5CwAAxQsAAN8LAAAaDAAAJgwAAC0MAADRDAAA/QwAAFENAABhDQAApQ0AALkNAAD9DQAACQ4AACMOAABUDgAAYA4AAHoOAACrDgAATw8AAFQPAABaDwAAZg8AAIoPAAC/DwAA9A8AAM8RAACvEwAA6BMAAGYUAAB9FAAAshQAADYVAAAsFgAAWBYAAJoWAADPFgAABBcAAJkYAAAuGgAAZxoAAKAaAADgGgAALhsAAIsbAADZGwAAXRwAAOEcAACIHQAAyh0AAAweAABBHgAA1h8AAA8gAAC2IAAA6yAAADkhAACgIQAAsSEAABgiAABmIgAABiMAAPwjAACAJAAAeiUAAMMlAAAFJgAAOiYAAG8mAABNKAAA4ikAABsqAACeKgAAtSoAAOoqAABuKwAAZCwAAJAsAADFLAAA+iwAANguAAAfMAAAWDAAAJEwAADGMAAAFDEAAHExAAC/MQAAQzIAAMcyAABuMwAAsDMAANwzAAARNAAARjQAAB02AAD9NwAANjgAAMY4AADdOAAAJDoAAIs6AADyOgAAHjsAAEo7AAB/OwAAtDsAAIs9AABrPwAApD8AADRAAABLQAAAckAAANlAAABAQQAAbEEAAJBBAADFQQAA+kEAAM9DAABkRQAAnUUAACxGAABDRgAAfEYAAPhGAABfRwAAi0cAAK9HAADkRwAAGUgAAOhJAAB9SwAAtksAAEdMAABeTAAAl0wAADdNAADeTQAACk4AAC5OAABjTgAAmE4AAGtQAAAAUgAAOVIAAMpSAADhUgAASFMAAOhTAACPVAAAu1QAAP1UAAAyVQAAZ1UAADpXAADPWAAACFkAAEFZAAB2WQAAxFkAABJaAABgWgAAx1oAAEtbAADyWwAANFwAAHZcAACrXAAA4FwAAKteAABAYAAAeWAAALJgAADnYAAANWEAAINhAADRYQAAVWIAANliAACAYwAAwmMAAARkAAA5ZAAAbmQAADpmAADPZwAACGgAAEFoAAB2aAAAxGgAACFpAABvaQAAvWkAADlqAABvagAAsWoAAPNqAAA1awAAamsAAP9sAAA4bQAA320AABRuAABibgAAyW4AAOBuAABcbwAAqm8AAEpwAABAcQAAeXEAAHNyAACocgAA6nIAACxzAABhcwAAqHQAAOF0AACIdQAAvXUAAAt2AABydgAAiXYAAPB2AAA+dwAA3ncAANR4AABYeQAAUnoAAJV6AADBegAA9noAACt7AAADfQAA5H4AAB1/AACqfwAAwX8AAAiBAABvgQAA1oEAAPqBAABkhQAAzYUAAPGFAAAnhgAAy4YAAACHAABOhwAAvIcAANOHAAAIiAAAjIgAAIKJAADEiQAABooAAHCNAADZjQAA/Y0AADOOAADXjgAADI8AAFqPAADJjwAA4I8AAEeQAADLkAAAwZEAAAOSAABFkgAAX5IAABCTAABBkwAAu5MAAPCTAAA+lAAAkZQAAKiUAAAklQAAcpUAABKWAAAIlwAAr5cAAKmYAADfmAAAIZkAAIucAAD0nAAAGJ0AAE6dAADynQAAJ54AAHWeAADhngAA+J4AAC2fAACxnwAAp6AAAOmgAABTpAAAuaQAAN2kAAATpQAAt6UAAOylAAA6pgAAqaYAAMCmAAAnpwAAx6cAAL2oAAD/qAAANakAAJ+sAAAkrQAAja0AALStAADtrQAAlK4AAMmuAAAXrwAAhq8AAJ2vAAAEsAAAgLAAACexAABpsQAAn7EAAAm1AACOtQAA97UAAB62AABXtgAA/rYAADO3AACBtwAA8LcAAAe4AABuuAAADrkAALW5AAD3uQAALboAAJe9AAAcvgAAhb4AAKy+AADlvgAAjL8AAMG/AAAPwAAAfsAAAJXAAAD8wAAAnMEAAJLCAADUwgAACsMAAHTGAAD5xgAAYscAAInHAADCxwAAacgAAJ7IAADsyAAAW8kAAHLJAAD2yQAAwcoAALfLAAD5ywAAO8wAAGvMAAB8zQAAsM0AAC3OAABizgAAsM4AAAPPAAAazwAAls8AAOTPAACE0AAAetEAAOHRAABd0gAAoNIAAOLSAAAY0wAASNMAAFnUAACN1AAACtUAAD/VAACN1QAA4NUAAPfVAABz1gAAwdYAAGHXAABX2AAAvtgAADrZAAB92QAAv9kAAPXZAAAl2gAANtsAAGrbAADn2wAAHNwAAGrcAAC93AAA1NwAAFDdAACe3QAAPt4AADTfAADb3wAA1eAAAArhAABM4QAAguEAALLhAADD4gAA9+IAAHTjAACp4wAA9+MAAErkAABh5AAA3eQAACvlAADL5QAAweYAAI7nAACI6AAAvegAAP/oAAA16QAAn+wAAAjtAAAs7QAAYu0AAAbuAAA77gAAie4AAPjuAAAP7wAAVvAAANLwAAB58QAAr/EAAOXxAABP9QAAuPUAAN/1AAAY9gAAv/YAAPT2AABC9wAAsfcAAMj3AAAB+AAAffgAACT5AABa+QAAhvkAAPD8AABZ/QAAf/0AALX9AABZ/gAAjv4AANz+AABL/wAAYv8AAMn/AABFAAEA7AABACIBAQBOAQEAuAQBACEFAQBIBQEAgQUBACgGAQBdBgEAqwYBABoHAQAxBwEAmAcBABQIAQC7CAEA8QgBACcJAQCRDAEA+gwBAB4NAQBUDQEA+A0BAC0OAQB7DgEA6g4BAAEPAQBIEAEArxABAFYRAQCMEQEAwhEBACwVAQCVFQEAvBUBAPUVAQCcFgEA0RYBAB8XAQCOFwEApRcBAN4XAQBaGAEAARkBADcZAQA=";
function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
const CODEBOOK_BYTES = base64ToUint8Array(CODEBOOK_B64);

// Expose ra global để các trang (vd. index.html) gọi trực tiếp window.wemToOgg(...)
if (typeof window !== 'undefined') {
  window.WemOgg = WemOgg;
  window.wemToOgg = function(wemBytes, codebookLibBytes, opts) {
    return WemOgg.wemToOgg(wemBytes, codebookLibBytes || CODEBOOK_BYTES, opts);
  };
  window.WEMOGG_CODEBOOK = CODEBOOK_BYTES;
}
