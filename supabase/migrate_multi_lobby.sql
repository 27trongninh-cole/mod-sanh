-- Chạy 1 LẦN DUY NHẤT nếu bồ đang có sẵn bảng bnk_config (bản cũ, chỉ 1 sảnh).
-- Migration này tạo 2 bảng mới (bnk_settings, lobby_profiles) và tự chuyển
-- dữ liệu cấu hình hiện tại sang thành "sảnh mặc định" đầu tiên — không mất
-- cấu hình đang chạy.
--
-- Nếu bồ CHƯA từng chạy schema.sql (project Supabase mới), KHÔNG cần file
-- này — chỉ cần chạy schema.sql bản mới nhất là đủ.

CREATE TABLE IF NOT EXISTS bnk_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bnk_url text NOT NULL,
  replacement_id bigint NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS lobby_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source_id bigint NOT NULL,
  video_filename text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Chuyển dữ liệu từ bnk_config cũ sang (chỉ chạy nếu bnk_config có dữ liệu và
-- bnk_settings/lobby_profiles đang trống, tránh chạy 2 lần bị nhân đôi).
INSERT INTO bnk_settings (id, bnk_url, replacement_id, updated_at, updated_by)
SELECT 1, bnk_url, replacement_id, updated_at, updated_by
FROM bnk_config
WHERE id = 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO lobby_profiles (name, source_id, video_filename, active)
SELECT 'Sảnh mặc định', source_id, video_filename, true
FROM bnk_config
WHERE id = 1
AND NOT EXISTS (SELECT 1 FROM lobby_profiles);

ALTER TABLE bnk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lobby_profiles ENABLE ROW LEVEL SECURITY;

-- Bảng bnk_config cũ CHƯA bị xoá (an toàn, phòng khi cần đối chiếu lại).
-- Sau khi xác nhận web chạy ổn định với cấu hình mới, bồ có thể tự xoá bằng:
--   DROP TABLE bnk_config;
