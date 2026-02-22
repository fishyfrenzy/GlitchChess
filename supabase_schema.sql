CREATE TABLE IF NOT EXISTS games (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    room_code TEXT UNIQUE NOT NULL,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anonymous insert" ON games FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anonymous select" ON games FOR SELECT USING (true);
CREATE POLICY "Allow anonymous update" ON games FOR UPDATE USING (true);
