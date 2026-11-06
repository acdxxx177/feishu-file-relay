-- 历史文件保持关闭；只有新版本在登记时显式启用的文件参与首次确认通知。
ALTER TABLE files ADD COLUMN first_download_notification INTEGER NOT NULL DEFAULT 0
  CHECK (first_download_notification IN (0, 1));
