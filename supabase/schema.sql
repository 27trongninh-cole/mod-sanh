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
  added_at timestamptz DEFAULT now()
);

-- ── Thư viện video (cho user chọn sẵn, ngoài ra user có thể tự upload video khác) ──
CREATE TABLE IF NOT EXISTS video_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  video_url text NOT NULL,               -- link Catbox
  thumbnail_url text,                    -- ảnh preview trong lưới (optional)
  keywords text[] DEFAULT '{}',          -- từ khoá tìm kiếm thêm (admin tự nhập)
  added_at timestamptz DEFAULT now()
);

-- ── Cấu hình Music_Login.bnk đang active (bnk lưu trên GitHub) ──
CREATE TABLE IF NOT EXISTS bnk_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- luôn chỉ 1 dòng
  bnk_url text NOT NULL,                 -- link raw GitHub
  source_id bigint NOT NULL,             -- ID slot nhạc gốc trong bnk (luôn cố định, không đổi theo bài)
  replacement_id bigint NOT NULL,        -- ID mới gán cho track đã mod (để không ghi đè ID gốc)
  video_filename text NOT NULL,          -- tên file video game đọc (đổi theo từng phiên bản game)
  updated_at timestamptz DEFAULT now(),
  updated_by text
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

-- ── RLS: đọc công khai thư viện + config, ghi phải qua server (service role) ──
ALTER TABLE wem_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE bnk_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE wem_requests ENABLE ROW LEVEL SECURITY;

-- Không cấp policy nào cho anon/authenticated => chỉ service role (server) mới
-- đọc/ghi được các bảng này. Client (trình duyệt) không gọi thẳng Supabase,
-- mà gọi qua API của server mình (giống lofinity) — an toàn hơn, và cũng
-- tránh phải lộ Supabase key ra trình duyệt.
