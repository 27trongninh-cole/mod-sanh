-- Chạy nếu Supabase project của bồ đã tồn tại từ trước, chưa có bảng
-- device_licenses (Device-based Manual License Activation cho tính năng
-- "tự tải nhạc lên" trong app APK melo-ninstaller).
-- Nếu bồ CHƯA từng chạy schema.sql (project Supabase mới), KHÔNG cần file
-- này — chỉ cần chạy schema.sql bản mới nhất là đủ.

CREATE TABLE IF NOT EXISTS device_licenses (
  device_id text PRIMARY KEY,
  label text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE device_licenses ENABLE ROW LEVEL SECURITY;

-- CHỈ ĐỌC cho anon — APK cần đọc thẳng bảng này (không qua server Node) để tự
-- kiểm tra máy mình đã được duyệt chưa. KHÔNG cấp insert/update/delete cho
-- anon — mọi thêm/sửa/xoá device_licenses đều đi qua trang /admin (service
-- role), APK không có đường tự ghi.
DROP POLICY IF EXISTS "public read device_licenses" ON device_licenses;
CREATE POLICY "public read device_licenses" ON device_licenses
  FOR SELECT USING (true);
