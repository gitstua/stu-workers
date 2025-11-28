import { v4 as uuidv4 } from 'uuid';

async function ensureSchema(db) {
    await db.prepare(`
        CREATE TABLE IF NOT EXISTS polls (
            id TEXT PRIMARY KEY,
            question TEXT NOT NULL,
            open TEXT NOT NULL,
            close TEXT NOT NULL,
            durationSeconds INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `).run();

    await db.prepare(`
        CREATE TABLE IF NOT EXISTS poll_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            poll_id TEXT NOT NULL,
            name TEXT NOT NULL,
            url TEXT,
            votes INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
        );
    `).run();

    await db.prepare(`
        CREATE TABLE IF NOT EXISTS poll_voters (
            poll_id TEXT NOT NULL,
            voter_hash TEXT NOT NULL,
            UNIQUE(poll_id, voter_hash)
        );
    `).run();
}

export async function createPoll(params, db) {
    await ensureSchema(db);
    if (!params?.options || !Array.isArray(params.options) || params.options.length === 0) {
        throw new Error('Poll options are required');
    }

    const question = (params.question || '').trim() || 'Untitled poll';
    const durationSecondsRaw = Number(params.durationSeconds);
    const durationSeconds = Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
        ? Math.floor(durationSecondsRaw)
        : 30;
    const id = params.id || uuidv4();
    const now = Date.now();
    const open = params.open ? new Date(params.open).toISOString() : new Date(now).toISOString();
    const close = params.close ? new Date(params.close).toISOString() : new Date(now + durationSeconds * 1000).toISOString();

    await db.prepare(`
        INSERT INTO polls (id, question, open, close, durationSeconds, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, question, open, close, durationSeconds, new Date(now).toISOString(), new Date(now).toISOString()).run();

    const optionStatements = params.options
        .map(opt => [opt.name, opt.url || ''])
        .filter(([name]) => name && name.trim().length > 0)
        .map(([name, url]) =>
            db.prepare('INSERT INTO poll_options (poll_id, name, url, votes) VALUES (?, ?, ?, 0)').bind(id, name, url)
        );
    if (optionStatements.length === 0) {
        throw new Error('Poll options are required');
    }
    await db.batch(optionStatements);

    return await getPoll(id, db);
}

export async function vote(pollId, optionIndex, db, voterHash) {
    await ensureSchema(db);
    const poll = await getPoll(pollId, db);
    const now = Date.now();

    if (new Date(poll.open).getTime() > now) {
        throw new Error('Poll has not opened yet');
    }
    if (new Date(poll.close).getTime() < now) {
        throw new Error('Poll has closed');
    }
    if (optionIndex < 0 || optionIndex >= poll.options.length) {
        throw new Error('Invalid option index');
    }

    const targetOption = poll.options[optionIndex];

    try {
        const statements = [];
        if (voterHash) {
            statements.push(
                db.prepare('INSERT INTO poll_voters (poll_id, voter_hash) VALUES (?, ?)').bind(pollId, voterHash)
            );
        }
        statements.push(
            db.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id = ? AND poll_id = ?').bind(targetOption.id, pollId)
        );
        await db.batch(statements);
    } catch (err) {
        if (err && err.message && err.message.toLowerCase().includes('unique')) {
            throw new Error('You have already voted on this poll');
        }
        throw err;
    }

    return await getPoll(pollId, db);
}

export async function getPoll(pollId, db) {
    await ensureSchema(db);
    const pollRow = await db.prepare('SELECT * FROM polls WHERE id = ?').bind(pollId).first();
    if (!pollRow) {
        throw new Error('Poll not found');
    }
    const options = await db.prepare('SELECT id, name, url, votes FROM poll_options WHERE poll_id = ? ORDER BY id ASC').bind(pollId).all();
    const poll = {
        id: pollRow.id,
        question: pollRow.question,
        durationSeconds: pollRow.durationSeconds,
        open: pollRow.open,
        close: pollRow.close,
        options: options.results || []
    };
    return poll;
}

export async function listPolls(db) {
    await ensureSchema(db);
    const polls = await db.prepare('SELECT * FROM polls ORDER BY created_at DESC').all();
    const pollRows = polls.results || [];
    if (pollRows.length === 0) return [];

    const ids = pollRows.map(p => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const optionResults = await db.prepare(
        `SELECT id, poll_id, name, url, votes FROM poll_options WHERE poll_id IN (${placeholders}) ORDER BY id ASC`
    ).bind(...ids).all();
    const options = optionResults.results || [];

    const grouped = {};
    for (const opt of options) {
        grouped[opt.poll_id] = grouped[opt.poll_id] || [];
        grouped[opt.poll_id].push(opt);
    }

    return pollRows.map(p => ({
        id: p.id,
        question: p.question,
        durationSeconds: p.durationSeconds,
        open: p.open,
        close: p.close,
        options: grouped[p.id] || [],
        totalVotes: (grouped[p.id] || []).reduce((s, o) => s + (o.votes || 0), 0)
    }));
}

export async function resetPoll(pollId, db) {
    await ensureSchema(db);
    const poll = await getPoll(pollId, db);
    const now = Date.now();
    const newOpen = new Date(now).toISOString();
    const newClose = new Date(now + (poll.durationSeconds || 30) * 1000).toISOString();

    await db.batch([
        db.prepare('UPDATE polls SET open = ?, close = ?, updated_at = ? WHERE id = ?').bind(newOpen, newClose, new Date(now).toISOString(), pollId),
        db.prepare('UPDATE poll_options SET votes = 0 WHERE poll_id = ?').bind(pollId),
        db.prepare('DELETE FROM poll_voters WHERE poll_id = ?').bind(pollId)
    ]);

    return await getPoll(pollId, db);
}

export async function deletePoll(pollId, db) {
    await ensureSchema(db);
    await db.batch([
        db.prepare('DELETE FROM poll_voters WHERE poll_id = ?').bind(pollId),
        db.prepare('DELETE FROM poll_options WHERE poll_id = ?').bind(pollId),
        db.prepare('DELETE FROM polls WHERE id = ?').bind(pollId)
    ]);
}
