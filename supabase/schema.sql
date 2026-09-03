-- ═══════════════════════════════════════════════════════════
--  WEB MỚI — Chạy toàn bộ file này trong Supabase SQL Editor
--  Không dùng Supabase Auth — admin đăng nhập bằng mật khẩu
--  (giống web lofinity cũ, qua header X-Admin-Password)
-- ═══════════════════════════════════════════════════════════

-- ── Thư viện nhạc (wem chuẩn do admin upload sẵn) ──
CREATE TABLE IF NOT EXISTS wem_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,                    -- tên hiển thị cho user chọn
  wem_url text NOT NULL,                 -- link Catbox file .wem chuẩn
  preview_mp3_url text,                  -- link Catbox mp3 để "nghe thử" (optional)
  duration_ms integer,                   -- đo sẵn lúc thêm, khỏi cần ffprobe lúc build
  keywords text[] DEFAULT '{}',          -- từ khoá tìm kiếm thêm (admin tự nhập)
  category text,                         -- từ khoá chính, dùng làm bộ lọc nhóm ở trang chọn nhạc
  added_at timestamptz DEFAULT now()
);

-- ── Thư viện video (cho user chọn sẵn, ngoài ra user có thể tự upload video khác) ──
CREATE TABLE IF NOT EXISTS video_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  video_url text NOT NULL,               -- link Catbox
  thumbnail_url text,                    -- ảnh preview trong lưới (optional)
  keywords text[] DEFAULT '{}',          -- từ khoá tìm kiếm thêm (admin tự nhập)
  category text,                         -- từ khoá chính, dùng làm bộ lọc nhóm ở trang chọn video
  added_at timestamptz DEFAULT now()
);

-- ── Cấu hình chung: link bnk (dùng chung) + Replacement ID (chung cho mọi sảnh) ──
CREATE TABLE IF NOT EXISTS bnk_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- luôn chỉ 1 dòng
  bnk_url text NOT NULL,                 -- link raw GitHub, dùng chung cho mọi sảnh
  replacement_id bigint NOT NULL,        -- ID chung gán cho file .wem đã mod (mọi sảnh đều trỏ vào ID này)
  updated_at timestamptz DEFAULT now(),
  updated_by text
);

-- ── Danh sách các "sảnh" game luân phiên (thường/sự kiện/...) ──
-- Mỗi dòng là 1 sảnh: ID nhạc gốc riêng (source_id) + tên file video riêng.
-- Lúc build, TẤT CẢ sảnh đang active đều được patch vào chung 1 file bnk,
-- và mỗi sảnh có 1 file video (cùng nội dung, khác tên) trong zip trả về —
-- để dù game đang xoay sang sảnh nào, mod vẫn hiển thị đúng.
CREATE TABLE IF NOT EXISTS lobby_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,                    -- tên gợi nhớ cho admin, vd "Sảnh thường", "Sảnh Trung Thu"
  source_id bigint NOT NULL,             -- ID slot nhạc gốc trong bnk của riêng sảnh này
  video_filename text NOT NULL,          -- tên file video game đọc cho riêng sảnh này
  active boolean NOT NULL DEFAULT true,  -- tắt tạm khi hết sự kiện, khỏi cần xoá
  created_at timestamptz DEFAULT now()
);

-- ── Yêu cầu wem từ user (không cần tài khoản, chỉ cần cách liên hệ) ──
CREATE TABLE IF NOT EXISTS wem_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_name text NOT NULL,          -- tên/nickname user tự nhập
  contact text NOT NULL,                 -- Zalo/Discord/FB... để admin liên hệ lại
  song_title text NOT NULL,              -- tên bài nhạc muốn xin
  note text DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'wip', 'done', 'rejected')),
  admin_note text DEFAULT '',            -- admin phản hồi, user xem lại bằng cách nào đó (xem bước sau)
  created_at timestamptz DEFAULT now()
);

-- ── Device-based Manual License Activation cho tính năng "tự tải nhạc lên"
--    trong app APK (melo-ninstaller) — admin duyệt từng máy qua trang /admin,
--    APK tự đọc thẳng bảng này bằng anon key (không qua server Node) để
--    kiểm tra máy mình có được duyệt chưa. ──
CREATE TABLE IF NOT EXISTS device_licenses (
  device_id text PRIMARY KEY,            -- ANDROID_ID lấy từ app, admin không tự bịa
  label text,                            -- ghi chú của admin, vd tên người dùng/Zalo
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz DEFAULT now()
);

-- ── RLS: đọc công khai thư viện + config, ghi phải qua server (service role) ──
ALTER TABLE wem_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE bnk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lobby_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wem_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_licenses ENABLE ROW LEVEL SECURITY;

-- Không cấp policy nào cho anon/authenticated => chỉ service role (server) mới
-- đọc/ghi được các bảng này. Client (trình duyệt) không gọi thẳng Supabase,
-- mà gọi qua API của server mình (giống lofinity) — an toàn hơn, và cũng
-- tránh phải lộ Supabase key ra trình duyệt.
--
-- NGOẠI LỆ: bnk_settings, lobby_profiles, device_licenses cần APK đọc THẲNG
-- bằng anon key (build mod offline ngay trên máy + kiểm tra kích hoạt) — nếu
-- app đã cần tính năng đó, chạy thêm 3 policy CHỈ-ĐỌC dưới đây (không cấp
-- insert/update/delete cho anon bao giờ — mọi ghi vẫn qua /admin):
--
-- create policy "public read bnk_settings" on bnk_settings for select using (true);
-- create policy "public read active lobby_profiles" on lobby_profiles for select using (active = true);
-- create policy "public read device_licenses" on device_licenses for select using (true);
