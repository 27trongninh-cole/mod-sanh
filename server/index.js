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

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

// Đường dẫn trong zip trả về cho user — khớp cấu trúc app game
const BASE_DIR = 'com.garena.game.kgvn/files/Extra/2022.V3/';
const WEM_DIR = BASE_DIR + 'Sound_DLC/Android/';
const VIDEO_DIR = BASE_DIR + 'ISPDiff/LobbyMovie/';
// Tên file video KHÔNG cố định — lấy từ bnk_config.video_filename (đổi cùng lúc
// với link bnk + source/replacement ID mỗi khi bồ cập nhật cấu hình ở /admin).

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

    const { bnkBuffer, config } = await bnkCache.getActive();
    const patchResult = patchIdAndDuration(bnkBuffer, config.source_id, config.replacement_id, wem.duration_ms);
    if (!patchResult.ok) {
      throw new Error('Patch bnk thất bại: ' + patchResult.reason);
    }

    if (!config.video_filename) throw new Error('Chưa cấu hình tên file video (video_filename) — vào /admin để set');

    const zipWemName = `${config.replacement_id}.wem`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Nhac_sanh.zip"');
    res.setHeader('X-Build-Report', encodeURIComponent(JSON.stringify({
      wemName: wem.name, durationMs: wem.duration_ms, videoSource: videoSourceLabel,
      sourceId: config.source_id, replacementId: config.replacement_id, videoFilename: config.video_filename
    })));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    archive.append(wemBytes, { name: WEM_DIR + zipWemName });
    archive.append(patchResult.buffer, { name: WEM_DIR + 'Music_Login.bnk' });
    archive.append(videoBytes, { name: VIDEO_DIR + config.video_filename });
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
    const bnkConfig = await supabaseStore.getBnkConfig();
    res.json({ ok: true, supabaseConfigured: supabaseStore.isConfigured(), bnkConfig });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- wem library ---
app.get('/api/admin/wem-list', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, wems: await supabaseStore.listWems() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/admin/wem', requireAdmin, async (req, res) => {
  try {
    const { name, wemUrl, previewMp3Url, durationMs } = req.body || {};
    if (!name || !wemUrl) return res.status(400).json({ ok: false, error: 'Cần name và wemUrl' });
    const saved = await supabaseStore.addWem({ name, wemUrl, previewMp3Url, durationMs });
    res.json({ ok: true, wem: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/admin/wem/:id', requireAdmin, async (req, res) => {
  try { await supabaseStore.deleteWem(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- video library ---
app.get('/api/admin/video-list', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, videos: await supabaseStore.listVideos() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/admin/video', requireAdmin, async (req, res) => {
  try {
    const { name, videoUrl, thumbnailUrl } = req.body || {};
    if (!name || !videoUrl) return res.status(400).json({ ok: false, error: 'Cần name và videoUrl' });
    const saved = await supabaseStore.addVideo({ name, videoUrl, thumbnailUrl });
    res.json({ ok: true, video: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/admin/video/:id', requireAdmin, async (req, res) => {
  try { await supabaseStore.deleteVideo(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- bnk config ---
app.post('/api/admin/bnk-config', requireAdmin, async (req, res) => {
  try {
    const { bnkUrl, sourceId, replacementId, videoFilename, updatedBy } = req.body || {};
    const saved = await supabaseStore.setBnkConfig({
      bnkUrl,
      sourceId: sourceId != null ? parseInt(sourceId, 10) : null,
      replacementId: replacementId != null ? parseInt(replacementId, 10) : null,
      videoFilename,
      updatedBy
    });
    bnkCache.invalidate();
    await bnkCache.getActive({ forceRefresh: true }); // xác nhận link tải được ngay
    res.json({ ok: true, config: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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
