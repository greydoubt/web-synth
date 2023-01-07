ALTER TABLE looper_presets DROP FOREIGN KEY IF EXISTS looper_presets_ibfk_1;
ALTER TABLE looper_presets DROP COLUMN IF EXISTS author;
ALTER TABLE looper_presets ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
