require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('./db');
const { mergeBudgetState, isUserMoreSenior } = require('./syncEngine');

const JWT_SECRET = process.env.JWT_SECRET || '20yr-budgeting-railway-secret-key-2026';

function createApp() {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));

    // Serve static frontend files so opening the Railway URL also serves the web app
    const rootDir = path.join(__dirname, '..');
    app.use(express.static(rootDir));

    app.get('/', (req, res) => {
        res.sendFile(path.join(rootDir, 'start.html'));
    });

    // Health check endpoint for Railway
    app.get('/api/health', async (req, res) => {
        const hasPostgres = Boolean(
            process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL || process.env.POSTGRES_URL
        );
        const users = await db.getAllUsers();
        res.json({
            status: 'ok',
            service: '20yr-budgeting-railway-sync',
            storageMode: hasPostgres ? 'railway-postgresql' : 'local-persistent-store',
            registeredUsers: users.length,
            timestamp: new Date().toISOString()
        });
    });

    /**
     * POST /api/auth/login
     * Authenticates a user with username & password.
     * If the username does not exist yet (or `autoRegister` is enabled, default true),
     * registers the user and records their permanent `firstLoginAt` and `firstLoginOrder`.
     * The first user who ever logs in gets `firstLoginOrder = 1`, the second gets `2`, etc.
     */
    app.post('/api/auth/login', async (req, res) => {
        try {
            const { username, password } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password are required' });
            }

            const cleanUsername = String(username).trim();
            if (cleanUsername.length < 2) {
                return res.status(400).json({ error: 'Username must be at least 2 characters' });
            }

            let user = await db.getUserByUsername(cleanUsername);
            let isFirstEverLoginForUser = false;

            if (!user) {
                const passwordHash = await bcrypt.hash(String(password), 10);
                user = await db.createUser({
                    id: crypto.randomUUID(),
                    username: cleanUsername,
                    passwordHash,
                    firstLoginAt: Date.now()
                });
                isFirstEverLoginForUser = true;
            } else {
                const valid = await bcrypt.compare(String(password), user.passwordHash);
                if (!valid) {
                    return res.status(401).json({ error: 'Invalid username or password' });
                }
                user = await db.touchUserLogin(cleanUsername);
            }

            const token = jwt.sign(
                {
                    id: user.id,
                    username: user.username,
                    firstLoginAt: user.firstLoginAt,
                    firstLoginOrder: user.firstLoginOrder
                },
                JWT_SECRET,
                { expiresIn: '365d' }
            );

            const allUsers = await db.getAllUsers();
            const firstEverUser = allUsers[0] || user;

            return res.json({
                token,
                isFirstEverLoginForUser,
                user: {
                    id: user.id,
                    username: user.username,
                    firstLoginAt: user.firstLoginAt,
                    firstLoginOrder: user.firstLoginOrder,
                    isSeniorMostUser: user.firstLoginOrder === firstEverUser.firstLoginOrder
                },
                seniorMostUser: {
                    username: firstEverUser.username,
                    firstLoginAt: firstEverUser.firstLoginAt,
                    firstLoginOrder: firstEverUser.firstLoginOrder
                }
            });
        } catch (err) {
            console.error('Login error:', err);
            return res.status(500).json({ error: 'Authentication failed', details: err.message });
        }
    });

    // Middleware to verify JWT or user header
    async function authenticate(req, res, next) {
        try {
            const authHeader = req.headers.authorization || '';
            if (authHeader.startsWith('Bearer ')) {
                const token = authHeader.slice(7);
                const decoded = jwt.verify(token, JWT_SECRET);
                const dbUser = await db.getUserByUsername(decoded.username);
                req.user = dbUser || decoded;
                return next();
            }
            return res.status(401).json({ error: 'Authentication token required' });
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
    }

    /**
     * GET /api/auth/me
     * Used after biometric unlock to verify session and retrieve user seniority info.
     */
    app.get('/api/auth/me', authenticate, async (req, res) => {
        const allUsers = await db.getAllUsers();
        const firstEverUser = allUsers[0] || req.user;
        res.json({
            user: {
                id: req.user.id,
                username: req.user.username,
                firstLoginAt: req.user.firstLoginAt,
                firstLoginOrder: req.user.firstLoginOrder,
                isSeniorMostUser: req.user.firstLoginOrder === firstEverUser.firstLoginOrder
            },
            seniorMostUser: {
                username: firstEverUser.username,
                firstLoginAt: firstEverUser.firstLoginAt,
                firstLoginOrder: firstEverUser.firstLoginOrder
            },
            users: allUsers
        });
    });

    /**
     * GET /api/budgets
     * Fetch the latest budgets state and metadata from the Railway database.
     */
    app.get('/api/budgets', authenticate, async (req, res) => {
        try {
            const state = await db.getBudgetState();
            res.json({
                budgets: state.budgets || [],
                meta: state.meta || {},
                updatedAt: state.updatedAt || 0
            });
        } catch (err) {
            console.error('GET /api/budgets error:', err);
            res.status(500).json({ error: 'Failed to load budgets' });
        }
    });

    /**
     * POST /api/sync
     * Synchronize offline & online budget data with seniority-based conflict resolution:
     * "if there is conflicting changes, then accepting the user's changes who is the first ever logged in before the other user."
     */
    app.post('/api/sync', authenticate, async (req, res) => {
        try {
            const { clientBudgets, baseBudgets } = req.body || {};
            if (!Array.isArray(clientBudgets)) {
                return res.status(400).json({ error: 'clientBudgets array is required' });
            }

            const currentState = await db.getBudgetState();
            const clientUser = {
                username: req.user.username,
                firstLoginOrder: req.user.firstLoginOrder,
                firstLoginAt: req.user.firstLoginAt
            };

            const { mergedBudgets, updatedMeta, conflictsResolved } = mergeBudgetState({
                serverBudgets: currentState.budgets || [],
                serverMeta: currentState.meta || {},
                baseBudgets: Array.isArray(baseBudgets) ? baseBudgets : null,
                clientBudgets,
                clientUser
            });

            const savedState = await db.saveBudgetState({
                budgets: mergedBudgets,
                meta: updatedMeta
            });

            return res.json({
                budgets: savedState.budgets,
                meta: savedState.meta,
                updatedAt: savedState.updatedAt,
                conflictsResolved,
                syncedBy: clientUser
            });
        } catch (err) {
            console.error('POST /api/sync error:', err);
            return res.status(500).json({ error: 'Sync failed', details: err.message });
        }
    });

    return app;
}

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    const app = createApp();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`20yr Budgeting Railway API & App server listening on port ${PORT}`);
    });
}

module.exports = { createApp, isUserMoreSenior };
