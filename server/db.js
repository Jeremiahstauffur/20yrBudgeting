const fs = require('fs');
const path = require('path');

let pgPool = null;
const LOCAL_DB_FILE = process.env.LOCAL_DB_FILE || path.join(__dirname, '..', 'data', 'railway_local_store.json');

async function getPgPool() {
    if (pgPool) return pgPool;
    const dbUrl = process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL || process.env.POSTGRES_URL;
    if (!dbUrl) return null;

    const { Pool } = require('pg');
    pgPool = new Pool({
        connectionString: dbUrl,
        ssl: dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1')
            ? false
            : { rejectUnauthorized: false }
    });

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS app_users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            first_login_at BIGINT NOT NULL,
            first_login_order INTEGER NOT NULL,
            created_at BIGINT NOT NULL,
            last_login_at BIGINT NOT NULL
        );
    `);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS budget_state (
            state_key TEXT PRIMARY KEY,
            budgets_json JSONB NOT NULL,
            meta_json JSONB NOT NULL,
            updated_at BIGINT NOT NULL
        );
    `);

    return pgPool;
}

function readLocalStore() {
    try {
        if (fs.existsSync(LOCAL_DB_FILE)) {
            const raw = fs.readFileSync(LOCAL_DB_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (err) {
        console.error('Error reading local store:', err);
    }
    return {
        users: [],
        state: {
            budgets: [],
            meta: { budgets: {}, subBudgets: {}, transactions: {}, lastEditor: null },
            updatedAt: 0
        }
    };
}

function writeLocalStore(store) {
    try {
        const dir = path.dirname(LOCAL_DB_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
        console.error('Error writing local store:', err);
    }
}

async function getUserByUsername(username) {
    const clean = String(username || '').trim().toLowerCase();
    const pool = await getPgPool();
    if (pool) {
        const res = await pool.query(
            `SELECT id, username, password_hash AS "passwordHash",
                    first_login_at AS "firstLoginAt",
                    first_login_order AS "firstLoginOrder",
                    created_at AS "createdAt",
                    last_login_at AS "lastLoginAt"
             FROM app_users WHERE LOWER(username) = $1 LIMIT 1`,
            [clean]
        );
        if (res.rows.length === 0) return null;
        const row = res.rows[0];
        return {
            ...row,
            firstLoginAt: Number(row.firstLoginAt),
            firstLoginOrder: Number(row.firstLoginOrder),
            createdAt: Number(row.createdAt),
            lastLoginAt: Number(row.lastLoginAt)
        };
    }

    const store = readLocalStore();
    return store.users.find(u => u.username.toLowerCase() === clean) || null;
}

async function createUser({ id, username, passwordHash, firstLoginAt }) {
    const cleanUsername = String(username).trim();
    const now = firstLoginAt || Date.now();
    const pool = await getPgPool();

    if (pool) {
        const countRes = await pool.query(`SELECT COALESCE(MAX(first_login_order), 0) + 1 AS next_order FROM app_users`);
        const firstLoginOrder = Number(countRes.rows[0].next_order) || 1;
        await pool.query(
            `INSERT INTO app_users (id, username, password_hash, first_login_at, first_login_order, created_at, last_login_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, cleanUsername, passwordHash, now, firstLoginOrder, now, now]
        );
        return {
            id,
            username: cleanUsername,
            passwordHash,
            firstLoginAt: now,
            firstLoginOrder,
            createdAt: now,
            lastLoginAt: now
        };
    }

    const store = readLocalStore();
    const maxOrder = store.users.reduce((max, u) => Math.max(max, Number(u.firstLoginOrder) || 0), 0);
    const firstLoginOrder = maxOrder + 1;
    const newUser = {
        id,
        username: cleanUsername,
        passwordHash,
        firstLoginAt: now,
        firstLoginOrder,
        createdAt: now,
        lastLoginAt: now
    };
    store.users.push(newUser);
    writeLocalStore(store);
    return newUser;
}

async function touchUserLogin(username) {
    const clean = String(username || '').trim().toLowerCase();
    const now = Date.now();
    const pool = await getPgPool();
    if (pool) {
        await pool.query(`UPDATE app_users SET last_login_at = $1 WHERE LOWER(username) = $2`, [now, clean]);
        return getUserByUsername(clean);
    }

    const store = readLocalStore();
    const user = store.users.find(u => u.username.toLowerCase() === clean);
    if (user) {
        user.lastLoginAt = now;
        writeLocalStore(store);
    }
    return user || null;
}

async function getAllUsers() {
    const pool = await getPgPool();
    if (pool) {
        const res = await pool.query(
            `SELECT id, username, first_login_at AS "firstLoginAt", first_login_order AS "firstLoginOrder", last_login_at AS "lastLoginAt"
             FROM app_users ORDER BY first_login_order ASC`
        );
        return res.rows.map(r => ({
            ...r,
            firstLoginAt: Number(r.firstLoginAt),
            firstLoginOrder: Number(r.firstLoginOrder),
            lastLoginAt: Number(r.lastLoginAt)
        }));
    }

    const store = readLocalStore();
    return store.users
        .map(({ passwordHash, ...u }) => u)
        .sort((a, b) => a.firstLoginOrder - b.firstLoginOrder);
}

async function getBudgetState() {
    const pool = await getPgPool();
    if (pool) {
        const res = await pool.query(
            `SELECT budgets_json AS budgets, meta_json AS meta, updated_at AS "updatedAt"
             FROM budget_state WHERE state_key = 'global' LIMIT 1`
        );
        if (res.rows.length === 0) {
            return {
                budgets: [],
                meta: { budgets: {}, subBudgets: {}, transactions: {}, lastEditor: null },
                updatedAt: 0
            };
        }
        return {
            budgets: res.rows[0].budgets || [],
            meta: res.rows[0].meta || { budgets: {}, subBudgets: {}, transactions: {}, lastEditor: null },
            updatedAt: Number(res.rows[0].updatedAt) || 0
        };
    }

    const store = readLocalStore();
    return store.state || {
        budgets: [],
        meta: { budgets: {}, subBudgets: {}, transactions: {}, lastEditor: null },
        updatedAt: 0
    };
}

async function saveBudgetState({ budgets, meta }) {
    const now = Date.now();
    const pool = await getPgPool();
    if (pool) {
        await pool.query(
            `INSERT INTO budget_state (state_key, budgets_json, meta_json, updated_at)
             VALUES ('global', $1::jsonb, $2::jsonb, $3)
             ON CONFLICT (state_key) DO UPDATE
             SET budgets_json = EXCLUDED.budgets_json,
                 meta_json = EXCLUDED.meta_json,
                 updated_at = EXCLUDED.updated_at`,
            [JSON.stringify(budgets || []), JSON.stringify(meta || {}), now]
        );
        return { budgets, meta, updatedAt: now };
    }

    const store = readLocalStore();
    store.state = {
        budgets: budgets || [],
        meta: meta || { budgets: {}, subBudgets: {}, transactions: {}, lastEditor: null },
        updatedAt: now
    };
    writeLocalStore(store);
    return store.state;
}

module.exports = {
    getPgPool,
    getUserByUsername,
    createUser,
    touchUserLogin,
    getAllUsers,
    getBudgetState,
    saveBudgetState
};
