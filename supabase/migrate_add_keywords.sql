-- Chỉ cần chạy nếu bồ đã tạo bảng wem_library / video_library từ bản schema.sql
-- CŨ HƠN (chưa có cột keywords để tìm kiếm).
-- Nếu bồ CHƯA từng chạy schema.sql (project Supabase mới), KHÔNG cần file này —
-- chỉ cần chạy schema.sql bản mới nhất là đủ.

ALTER TABLE wem_library ADD COLUMN IF NOT EXISTS keywords text[] DEFAULT '{}';
ALTER TABLE video_library ADD COLUMN IF NOT EXISTS keywords text[] DEFAULT '{}';
