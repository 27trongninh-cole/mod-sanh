-- Chỉ cần chạy nếu bồ đã tạo bảng bnk_config từ bản schema.sql CŨ HƠN
-- (chưa có source_id / replacement_id / video_filename).
-- Nếu bồ CHƯA từng chạy schema.sql (project Supabase mới), KHÔNG cần file này —
-- chỉ cần chạy schema.sql bản mới nhất là đủ.

ALTER TABLE bnk_config ADD COLUMN IF NOT EXISTS source_id bigint;
ALTER TABLE bnk_config ADD COLUMN IF NOT EXISTS replacement_id bigint;
ALTER TABLE bnk_config ADD COLUMN IF NOT EXISTS video_filename text;
