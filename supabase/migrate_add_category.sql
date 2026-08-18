-- Chạy nếu bảng wem_library / video_library đã tồn tại từ trước, chưa có
-- cột category (từ khoá chính, dùng làm bộ lọc nhóm ở trang chọn nhạc/video).
-- Nếu bồ CHƯA từng chạy schema.sql (project Supabase mới), KHÔNG cần file này —
-- chỉ cần chạy schema.sql bản mới nhất là đủ.

ALTER TABLE wem_library ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE video_library ADD COLUMN IF NOT EXISTS category text;
