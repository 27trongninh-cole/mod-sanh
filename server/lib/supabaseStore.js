'use strict';

// Toàn bộ truy cập Supabase đi qua đây, dùng SERVICE ROLE key (secret key).
// Trình duyệt KHÔNG BAO GIỜ nói chuyện thẳng với Supabase — chỉ gọi API
// của server mình, giống cách lofinity làm với Music_Login.bnk config.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || null;

let client = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function isConfigured() {
  return !!client;
}

function requireClient() {
  if (!client) throw new Error('Supabase chưa được cấu hình (thiếu SUPABASE_URL / SUPABASE_SERVICE_KEY trên server)');
  return client;
}

// ───────────────────────── wem_library ─────────────────────────

// publicFields=true -> chỉ trả field an toàn cho trang user (ẩn wem_url, source_id)
async function listWems({ publicFields = false } = {}) {
  const db = requireClient();
  const cols = publicFields
    ? 'id, name, preview_mp3_url, duration_ms, keywords, category, added_at'
    : '*';
  const { data, error } = await db.from('wem_library').select(cols).order('added_at', { ascending: false });
  if (error) throw new Error('Supabase lỗi khi đọc wem_library: ' + error.message);
  return data;
}

async function getWemById(id) {
  const db = requireClient();
  const { data, error } = await db.from('wem_library').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('Supabase lỗi khi đọc wem: ' + error.message);
  return data;
}

async function addWem({ name, wemUrl, previewMp3Url, sourceId, durationMs, keywords, category }) {
  const db = requireClient();
  const { data, error } = await db.from('wem_library').insert({
    name, wem_url: wemUrl, preview_mp3_url: previewMp3Url || null,
    source_id: sourceId != null ? sourceId : null,
    duration_ms: durationMs != null ? durationMs : null,
    keywords: Array.isArray(keywords) ? keywords : [],
    category: category || null
  }).select().single();
  if (error) throw new Error('Supabase lỗi khi thêm wem: ' + error.message);
  return data;
}

async function deleteWem(id) {
  const db = requireClient();
  const { error } = await db.from('wem_library').delete().eq('id', id);
  if (error) throw new Error('Supabase lỗi khi xoá wem: ' + error.message);
}

async function updateWem(id, { name, wemUrl, previewMp3Url, durationMs, keywords, category }) {
  const db = requireClient();
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (wemUrl !== undefined) patch.wem_url = wemUrl;
  if (previewMp3Url !== undefined) patch.preview_mp3_url = previewMp3Url || null;
  if (durationMs !== undefined) patch.duration_ms = durationMs;
  if (keywords !== undefined) patch.keywords = Array.isArray(keywords) ? keywords : [];
  if (category !== undefined) patch.category = category || null;
  const { data, error } = await db.from('wem_library').update(patch).eq('id', id).select().single();
  if (error) throw new Error('Supabase lỗi khi cập nhật wem: ' + error.message);
  return data;
}

// ───────────────────────── video_library ─────────────────────────

async function listVideos() {
  const db = requireClient();
  const { data, error } = await db.from('video_library').select('*').order('added_at', { ascending: false });
  if (error) throw new Error('Supabase lỗi khi đọc video_library: ' + error.message);
  return data;
}

async function getVideoById(id) {
  const db = requireClient();
  const { data, error } = await db.from('video_library').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('Supabase lỗi khi đọc video: ' + error.message);
  return data;
}

async function addVideo({ name, videoUrl, thumbnailUrl, keywords, category }) {
  const db = requireClient();
  const { data, error } = await db.from('video_library').insert({
    name, video_url: videoUrl, thumbnail_url: thumbnailUrl || null,
    keywords: Array.isArray(keywords) ? keywords : [],
    category: category || null
  }).select().single();
  if (error) throw new Error('Supabase lỗi khi thêm video: ' + error.message);
  return data;
}

async function deleteVideo(id) {
  const db = requireClient();
  const { error } = await db.from('video_library').delete().eq('id', id);
  if (error) throw new Error('Supabase lỗi khi xoá video: ' + error.message);
}

async function updateVideo(id, { name, videoUrl, thumbnailUrl, keywords, category }) {
  const db = requireClient();
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (videoUrl !== undefined) patch.video_url = videoUrl;
  if (thumbnailUrl !== undefined) patch.thumbnail_url = thumbnailUrl || null;
  if (keywords !== undefined) patch.keywords = Array.isArray(keywords) ? keywords : [];
  if (category !== undefined) patch.category = category || null;
  const { data, error } = await db.from('video_library').update(patch).eq('id', id).select().single();
  if (error) throw new Error('Supabase lỗi khi cập nhật video: ' + error.message);
  return data;
}

// ───────────────────────── bnk_settings (chung: link bnk + Replacement ID) ─────────────────────────

async function getBnkSettings() {
  const db = requireClient();
  const { data, error } = await db.from('bnk_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error('Supabase lỗi khi đọc bnk_settings: ' + error.message);
  return data; // null nếu chưa từng set
}

async function setBnkSettings({ bnkUrl, replacementId, updatedBy }) {
  const db = requireClient();
  const current = await getBnkSettings();
  const payload = {
    id: 1,
    bnk_url: bnkUrl != null ? bnkUrl : (current && current.bnk_url),
    replacement_id: replacementId != null ? replacementId : (current && current.replacement_id),
    updated_by: updatedBy || null,
    updated_at: new Date().toISOString()
  };
  if (!payload.bnk_url || payload.replacement_id == null) {
    throw new Error('Thiếu bnkUrl / replacementId (lần đầu set phải điền đủ)');
  }
  const { data, error } = await db.from('bnk_settings').upsert(payload).select().single();
  if (error) throw new Error('Supabase lỗi khi lưu bnk_settings: ' + error.message);
  return data;
}

// ───────────────────────── lobby_profiles (nhiều sảnh) ─────────────────────────

async function listLobbyProfiles({ activeOnly = false } = {}) {
  const db = requireClient();
  let query = db.from('lobby_profiles').select('*').order('created_at', { ascending: true });
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw new Error('Supabase lỗi khi đọc lobby_profiles: ' + error.message);
  return data;
}

async function addLobbyProfile({ name, sourceId, videoFilename, active }) {
  const db = requireClient();
  const { data, error } = await db.from('lobby_profiles').insert({
    name, source_id: sourceId, video_filename: videoFilename,
    active: active != null ? active : true
  }).select().single();
  if (error) throw new Error('Supabase lỗi khi thêm sảnh: ' + error.message);
  return data;
}

async function updateLobbyProfile(id, { name, sourceId, videoFilename, active }) {
  const db = requireClient();
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (sourceId !== undefined) patch.source_id = sourceId;
  if (videoFilename !== undefined) patch.video_filename = videoFilename;
  if (active !== undefined) patch.active = active;
  const { data, error } = await db.from('lobby_profiles').update(patch).eq('id', id).select().single();
  if (error) throw new Error('Supabase lỗi khi cập nhật sảnh: ' + error.message);
  return data;
}

async function deleteLobbyProfile(id) {
  const db = requireClient();
  const { error } = await db.from('lobby_profiles').delete().eq('id', id);
  if (error) throw new Error('Supabase lỗi khi xoá sảnh: ' + error.message);
}

// ───────────────────────── wem_requests ─────────────────────────

async function addRequest({ requesterName, contact, songTitle, note }) {
  const db = requireClient();
  const { data, error } = await db.from('wem_requests').insert({
    requester_name: requesterName, contact, song_title: songTitle, note: note || ''
  }).select().single();
  if (error) throw new Error('Supabase lỗi khi gửi yêu cầu: ' + error.message);
  return data;
}

async function listRequests() {
  const db = requireClient();
  const { data, error } = await db.from('wem_requests').select('*').order('created_at', { ascending: false });
  if (error) throw new Error('Supabase lỗi khi đọc yêu cầu: ' + error.message);
  return data;
}

async function updateRequest(id, { status, adminNote }) {
  const db = requireClient();
  const patch = {};
  if (status !== undefined) patch.status = status;
  if (adminNote !== undefined) patch.admin_note = adminNote;
  const { data, error } = await db.from('wem_requests').update(patch).eq('id', id).select().single();
  if (error) throw new Error('Supabase lỗi khi cập nhật yêu cầu: ' + error.message);
  return data;
}

// ───────────────────────── device_licenses ─────────────────────────
// Device-based Manual License Activation cho tính năng "tự tải nhạc lên"
// trong app APK — app chỉ ĐỌC bảng này bằng anon key; mọi thêm/sửa/xoá đều
// đi qua đây (service role, qua trang /admin), không có đường nào khác.

async function listDeviceLicenses() {
  const db = requireClient();
  const { data, error } = await db.from('device_licenses').select('*').order('created_at', { ascending: false });
  if (error) throw new Error('Supabase lỗi khi đọc device_licenses: ' + error.message);
  return data;
}

async function addDeviceLicense({ deviceId, label, status }) {
  const db = requireClient();
  const { data, error } = await db.from('device_licenses').insert({
    device_id: deviceId, label: label || null, status: status || 'active'
  }).select().single();
  if (error) {
    if (error.code === '23505') throw new Error('Device ID này đã có trong danh sách rồi.');
    throw new Error('Supabase lỗi khi thêm device license: ' + error.message);
  }
  return data;
}

async function updateDeviceLicense(deviceId, { status, label }) {
  const db = requireClient();
  const patch = {};
  if (status !== undefined) patch.status = status;
  if (label !== undefined) patch.label = label;
  const { data, error } = await db.from('device_licenses').update(patch).eq('device_id', deviceId).select().single();
  if (error) throw new Error('Supabase lỗi khi cập nhật device license: ' + error.message);
  return data;
}

async function deleteDeviceLicense(deviceId) {
  const db = requireClient();
  const { error } = await db.from('device_licenses').delete().eq('device_id', deviceId);
  if (error) throw new Error('Supabase lỗi khi xoá device license: ' + error.message);
}

module.exports = {
  isConfigured,
  listWems, getWemById, addWem, deleteWem, updateWem,
  listVideos, getVideoById, addVideo, deleteVideo, updateVideo,
  getBnkSettings, setBnkSettings,
  listLobbyProfiles, addLobbyProfile, updateLobbyProfile, deleteLobbyProfile,
  addRequest, listRequests, updateRequest,
  listDeviceLicenses, addDeviceLicense, updateDeviceLicense, deleteDeviceLicense
};
