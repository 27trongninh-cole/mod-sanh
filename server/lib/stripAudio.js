'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Nhận buffer video, trả về buffer video đã xoá âm thanh (giữ nguyên chất lượng, chỉ -c copy nên rất nhanh).
// Nếu ffmpeg lỗi (video hỏng, codec lạ...) thì trả nguyên buffer gốc kèm cờ ok:false để caller tự quyết định.
async function stripAudio(inputBuffer) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(tmpDir, `stripaudio-in-${id}.mp4`);
  const outPath = path.join(tmpDir, `stripaudio-out-${id}.mp4`);

  await fs.promises.writeFile(inPath, inputBuffer);

  try {
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-y',
        '-i', inPath,
        '-c', 'copy',
        '-an',
        outPath
      ], { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr ? stderr.toString().slice(-500) : err.message));
        else resolve();
      });
    });
    const outBuffer = await fs.promises.readFile(outPath);
    return { ok: true, buffer: outBuffer };
  } catch (err) {
    return { ok: false, buffer: inputBuffer, reason: err.message };
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

module.exports = { stripAudio };
