'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const supabaseStore = require('./lib/supabaseStore');
const bnkCache = require('./lib/bnkCache');
const { patchIdAndDuration } = require('./lib/bnkPatcher');
const { stripAudio } = require('./lib/stripAudio');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

// Đường dẫn trong zip trả về cho user — khớp cấu trúc app game
const BASE_DIR = 'com.garena.game.kgvn/files/Extra/2022.V3/';
const WEM_DIR = BASE_DIR + 'Sound_DLC/Android/';
const VIDEO_DIR = BASE_DIR + 'ISPDiff/LobbyMovie/';
// Tên file video KHÔNG cố định — mỗi sảnh (lobby_profiles) có 1 tên riêng,
// cập nhật trong /admin. Zip trả về sẽ chứa N file video (1 cho mỗi sảnh
// đang bật), cùng nội dung nhưng khác tên.

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/api/health', (req, res) => res.json({ ok: true, supabaseConfigured: supabaseStore.isConfigured() }));

// ── admin auth (giống lofinity) ──
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD chưa được cấu hình trên server (Environment Variable).' });
  }
  const supplied = req.header('X-Admin-Password');
  if (supplied !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Sai mật khẩu admin' });
  }
  next();
}

// ═══════════════════════ THƯ VIỆN (public, đọc) ═══════════════════════

app.get('/api/wem-list', async (req, res) => {
  try {
    const wems = await supabaseStore.listWems({ publicFields: true });
    res.json({ ok: true, wems });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Proxy tải raw bytes .wem để client tự convert sang ogg (Web Audio) mà không
// lộ wem_url thật (giữ đúng nguyên tắc ẩn URL như wem-list ở trên).
app.get('/api/wem-preview/:id', async (req, res) => {
  try {
    const wem = await supabaseStore.getWemById(req.params.id);
    if (!wem) return res.status(404).json({ ok: false, error: 'Không tìm thấy bài nhạc' });
    const wemBytes = await bnkCache.fetchBuffer(wem.wem_url);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(wemBytes);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/video-list', async (req, res) => {
  try {
    const videos = await supabaseStore.listVideos();
    res.json({ ok: true, videos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════ BUILD (đóng gói zip) ═══════════════════════
// Body (multipart/form-data):
//   wemId       (required) id trong wem_library
//   videoId     (optional) id trong video_library — dùng CÁI NÀY hoặc field "video"
//   video       (optional) file .mp4 user tự upload — ưu tiên nếu có
app.post('/api/build', upload.fields([{ name: 'video', maxCount: 1 }]), async (req, res) => {
  const uploadedVideo = req.files && req.files.video && req.files.video[0];
  const { wemId, videoId } = req.body || {};

  const cleanup = () => {
    if (uploadedVideo) fs.promises.unlink(uploadedVideo.path).catch(() => {});
  };

  if (!wemId) {
    cleanup();
    return res.status(400).json({ ok: false, error: 'Thiếu wemId' });
  }
  if (!videoId && !uploadedVideo) {
    cleanup();
    return res.status(400).json({ ok: false, error: 'Cần chọn videoId từ thư viện hoặc upload file video' });
  }

  try {
    const wem = await supabaseStore.getWemById(wemId);
    if (!wem) throw new Error('Không tìm thấy bài nhạc đã chọn (có thể đã bị xoá khỏi thư viện)');
    if (wem.duration_ms == null) throw new Error('Bài nhạc này chưa có duration_ms — vào /admin đo lại trước khi dùng');

    let videoBytes, videoSourceLabel;
    if (uploadedVideo) {
      videoBytes = fs.readFileSync(uploadedVideo.path);
      videoSourceLabel = 'upload';
    } else {
      const video = await supabaseStore.getVideoById(videoId);
      if (!video) throw new Error('Không tìm thấy video đã chọn (có thể đã bị xoá khỏi thư viện)');
      videoBytes = await bnkCache.fetchBuffer(video.video_url);
      videoSourceLabel = 'library:' + video.name;
    }

    const wemBytes = await bnkCache.fetchBuffer(wem.wem_url);

    const audioStripResult = await stripAudio(videoBytes);
    videoBytes = audioStripResult.buffer; // dùng bản đã xoá âm thanh; nếu ffmpeg lỗi thì fallback về bản gốc (log lại lý do)
    const audioStripped = audioStripResult.ok;
    if (!audioStripResult.ok) console.warn('[stripAudio] fallback về video gốc:', audioStripResult.reason);

    const { bnkBuffer, config } = await bnkCache.getActive();
    const profiles = await supabaseStore.listLobbyProfiles({ activeOnly: true });
    if (!profiles.length) throw new Error('Chưa có sảnh nào đang bật — vào /admin thêm ít nhất 1 sảnh (Source ID + tên video)');

    // Patch lần lượt TỪNG sảnh đang bật vào cùng 1 buffer bnk — tất cả đều
    // trỏ chung về 1 Replacement ID (chỉ có 1 file .wem duy nhất trong zip).
    let patchedBuffer = bnkBuffer;
    let totalStreamTypeConverted = 0;
    for (const profile of profiles) {
      const patchResult = patchIdAndDuration(patchedBuffer, profile.source_id, config.replacement_id, wem.duration_ms);
      if (!patchResult.ok) {
        throw new Error(`Patch bnk thất bại ở sảnh "${profile.name}" (Source ID ${profile.source_id}): ` + patchResult.reason);
      }
      patchedBuffer = patchResult.buffer;
      totalStreamTypeConverted += patchResult.streamTypeConvertedCount || 0;
    }
    if (totalStreamTypeConverted > 0) {
      console.log(`[build] Đã tự chuyển ${totalStreamTypeConverted} track từ embedded sang streamed (game vừa nhúng thẳng wem vào bnk).`);
    }

    const zipWemName = `${config.replacement_id}.wem`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Nhac_sanh.zip"');
    res.setHeader('X-Build-Report', encodeURIComponent(JSON.stringify({
      wemName: wem.name, durationMs: wem.duration_ms, videoSource: videoSourceLabel,
      replacementId: config.replacement_id, audioStripped,
      lobbies: profiles.map(p => ({ name: p.name, sourceId: p.source_id, videoFilename: p.video_filename })),
      streamTypeConverted: totalStreamTypeConverted
    })));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    archive.append(wemBytes, { name: WEM_DIR + zipWemName });
    archive.append(patchedBuffer, { name: WEM_DIR + 'Music_Login.bnk' });
    // Mỗi sảnh 1 file video (cùng nội dung, khác tên) — để dù game đang xoay
    // sang sảnh nào, file cũng đã có sẵn đúng chỗ.
    for (const profile of profiles) {
      archive.append(videoBytes, { name: VIDEO_DIR + profile.video_filename });
    }
    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  } finally {
    cleanup();
  }
});

// ═══════════════════════ YÊU CẦU WEM (public, ghi) ═══════════════════════

app.post('/api/request', async (req, res) => {
  try {
    const { requesterName, contact, songTitle, note } = req.body || {};
    if (!requesterName || !contact || !songTitle) {
      return res.status(400).json({ ok: false, error: 'Cần điền tên, cách liên hệ, và tên bài nhạc' });
    }
    const saved = await supabaseStore.addRequest({ requesterName, contact, songTitle, note });
    res.json({ ok: true, request: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════ ADMIN ═══════════════════════

app.get('/api/admin/status', requireAdmin, async (req, res) => {
  try {
    const bnkSettings = await supabaseStore.getBnkSettings();
    const lobbyProfiles = await supabaseStore.listLobbyProfiles();
    res.json({ ok: true, supabaseConfigured: supabaseStore.isConfigured(), bnkSettings, lobbyProfiles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- wem library ---
app.get('/api/admin/wem-list', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, wems: await supabaseStore.listWems() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// "vd A, vd B, vd C" hoặc mảng -> mảng string đã trim, bỏ rỗng
function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

app.post('/api/admin/wem', requireAdmin, async (req, res) => {
  try {
    const { name, wemUrl, previewMp3Url, durationMs, keywords, category } = req.body || {};
    if (!name || !wemUrl) return res.status(400).json({ ok: false, error: 'Cần name và wemUrl' });
    const saved = await supabaseStore.addWem({ name, wemUrl, previewMp3Url, durationMs, keywords: parseKeywords(keywords), category: category ? String(category).trim() : null });
    res.json({ ok: true, wem: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/admin/wem/:id', requireAdmin, async (req, res) => {
  try { await supabaseStore.deleteWem(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/admin/wem/:id', requireAdmin, async (req, res) => {
  try {
    const { name, wemUrl, previewMp3Url, durationMs, keywords, category } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (wemUrl !== undefined) patch.wemUrl = wemUrl;
    if (previewMp3Url !== undefined) patch.previewMp3Url = previewMp3Url;
    if (durationMs !== undefined) patch.durationMs = durationMs;
    if (keywords !== undefined) patch.keywords = parseKeywords(keywords);
    if (category !== undefined) patch.category = category ? String(category).trim() : null;
    const saved = await supabaseStore.updateWem(req.params.id, patch);
    res.json({ ok: true, wem: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- video library ---
app.get('/api/admin/video-list', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, videos: await supabaseStore.listVideos() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/admin/video', requireAdmin, async (req, res) => {
  try {
    const { name, videoUrl, thumbnailUrl, keywords, category } = req.body || {};
    if (!name || !videoUrl) return res.status(400).json({ ok: false, error: 'Cần name và videoUrl' });
    const saved = await supabaseStore.addVideo({ name, videoUrl, thumbnailUrl, keywords: parseKeywords(keywords), category: category ? String(category).trim() : null });
    res.json({ ok: true, video: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/admin/video/:id', requireAdmin, async (req, res) => {
  try { await supabaseStore.deleteVideo(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/admin/video/:id', requireAdmin, async (req, res) => {
  try {
    const { name, videoUrl, thumbnailUrl, keywords, category } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (videoUrl !== undefined) patch.videoUrl = videoUrl;
    if (thumbnailUrl !== undefined) patch.thumbnailUrl = thumbnailUrl;
    if (keywords !== undefined) patch.keywords = parseKeywords(keywords);
    if (category !== undefined) patch.category = category ? String(category).trim() : null;
    const saved = await supabaseStore.updateVideo(req.params.id, patch);
    res.json({ ok: true, video: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- cấu hình chung: bnk + Replacement ID ---
app.post('/api/admin/bnk-settings', requireAdmin, async (req, res) => {
  try {
    const { bnkUrl, replacementId, updatedBy } = req.body || {};
    const saved = await supabaseStore.setBnkSettings({
      bnkUrl,
      replacementId: replacementId != null ? parseInt(replacementId, 10) : null,
      updatedBy
    });
    bnkCache.invalidate();
    // Thử tải lại bnk để xác nhận link còn sống — nếu bước này lỗi (mất mạng,
    // GitHub chậm...) thì KHÔNG huỷ kết quả đã lưu, chỉ cảnh báo cho admin biết.
    let verifyWarning = null;
    try {
      await bnkCache.getActive({ forceRefresh: true });
    } catch (verifyErr) {
      verifyWarning = 'Đã lưu cấu hình, nhưng chưa xác nhận được link bnk còn sống: ' + verifyErr.message;
    }
    res.json({ ok: true, settings: saved, warning: verifyWarning });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- danh sách sảnh (lobby_profiles) ---
app.get('/api/admin/lobby-profiles', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, profiles: await supabaseStore.listLobbyProfiles() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/admin/lobby-profiles', requireAdmin, async (req, res) => {
  try {
    const { name, sourceId, videoFilename, active } = req.body || {};
    if (!name || sourceId == null || !videoFilename) {
      return res.status(400).json({ ok: false, error: 'Cần name, sourceId, videoFilename' });
    }
    const saved = await supabaseStore.addLobbyProfile({
      name, sourceId: parseInt(sourceId, 10), videoFilename, active
    });
    res.json({ ok: true, profile: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/admin/lobby-profiles/:id', requireAdmin, async (req, res) => {
  try {
    const { name, sourceId, videoFilename, active } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (sourceId !== undefined) patch.sourceId = parseInt(sourceId, 10);
    if (videoFilename !== undefined) patch.videoFilename = videoFilename;
    if (active !== undefined) patch.active = active;
    const saved = await supabaseStore.updateLobbyProfile(req.params.id, patch);
    res.json({ ok: true, profile: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/admin/lobby-profiles/:id', requireAdmin, async (req, res) => {
  try { await supabaseStore.deleteLobbyProfile(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- yêu cầu wem ---
app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, requests: await supabaseStore.listRequests() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/admin/requests/:id', requireAdmin, async (req, res) => {
  try {
    const { status, adminNote } = req.body || {};
    const saved = await supabaseStore.updateRequest(req.params.id, { status, adminNote });
    res.json({ ok: true, request: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.log('⚠ ADMIN_PASSWORD chưa được set — trang /admin sẽ bị khoá.');
  if (!supabaseStore.isConfigured()) console.log('⚠ SUPABASE_URL/SUPABASE_SERVICE_KEY chưa được set.');
});
