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
    ? 'id, name, preview_mp3_url, duration_ms, added_at'
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

async function addWem({ name, wemUrl, previewMp3Url, sourceId, durationMs }) {
  const db = requireClient();
  const { data, error } = await db.from('wem_library').insert({
    name, wem_url: wemUrl, preview_mp3_url: previewMp3Url || null,
    source_id: sourceId != null ? sourceId : null,
    duration_ms: durationMs != null ? durationMs : null
  }).select().single();
  if (error) throw new Error('Supabase lỗi khi thêm wem: ' + error.message);
  return data;
}

async function deleteWem(id) {
  const db = requireClient();
  const { error } = await db.from('wem_library').delete().eq('id', id);
  if (error) throw new Error('Supabase lỗi khi xoá wem: ' + error.message);
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

async function addVideo({ name, videoUrl, thumbnailUrl }) {
  const db = requireClient();
  const { data, error } = await db.from('video_library').insert({
    name, video_url: videoUrl, thumbnail_url: thumbnailUrl || null
  }).select().single();
  if (error) throw new Error('Supabase lỗi khi thêm video: ' + error.message);
  return data;
}

async function deleteVideo(id) {
  const db = requireClient();
  const { error } = await db.from('video_library').delete().eq('id', id);
  if (error) throw new Error('Supabase lỗi khi xoá video: ' + error.message);
}

// ───────────────────────── bnk_config ─────────────────────────

async function getBnkConfig() {
  const db = requireClient();
  const { data, error } = await db.from('bnk_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error('Supabase lỗi khi đọc bnk_config: ' + error.message);
  return data; // null nếu chưa từng set
}

async function setBnkConfig({ bnkUrl, sourceId, replacementId, videoFilename, updatedBy }) {
  const db = requireClient();
  const current = await getBnkConfig();
  const payload = {
    id: 1,
    bnk_url: bnkUrl != null ? bnkUrl : (current && current.bnk_url),
    source_id: sourceId != null ? sourceId : (current && current.source_id),
    replacement_id: replacementId != null ? replacementId : (current && current.replacement_id),
    video_filename: videoFilename != null ? videoFilename : (current && current.video_filename),
    updated_by: updatedBy || null,
    updated_at: new Date().toISOString()
  };
  if (!payload.bnk_url || payload.source_id == null || payload.replacement_id == null || !payload.video_filename) {
    throw new Error('Thiếu bnkUrl / sourceId / replacementId / videoFilename (lần đầu set phải điền đủ)');
  }
  const { data, error } = await db.from('bnk_config').upsert(payload).select().single();
  if (error) throw new Error('Supabase lỗi khi lưu bnk_config: ' + error.message);
  return data;
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

module.exports = {
  isConfigured,
  listWems, getWemById, addWem, deleteWem,
  listVideos, getVideoById, addVideo, deleteVideo,
  getBnkConfig, setBnkConfig,
  addRequest, listRequests, updateRequest
};
