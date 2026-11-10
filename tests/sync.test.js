const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Point local db to a temporary test file before loading server modules
const tempDbFile = path.join(__dirname, 'test_railway_store.json');
process.env.LOCAL_DB_FILE = tempDbFile;

const { isUserMoreSenior, mergeBudgetState } = require('../server/syncEngine');
const { createApp } = require('../server/index');

function cleanupTestDb() {
    if (fs.existsSync(tempDbFile)) {
        fs.unlinkSync(tempDbFile);
    }
}

function requestJson(server, method, urlPath, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const payload = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const req = http.request(
            {
                hostname: '127.0.0.1',
                port: addr.port,
                path: urlPath,
                method,
                headers
            },
            (res) => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test('Seniority comparison: user who logged in first ever has higher priority', () => {
    const firstUser = { username: 'alice', firstLoginOrder: 1, firstLoginAt: 1000 };
    const secondUser = { username: 'bob', firstLoginOrder: 2, firstLoginAt: 2000 };

    assert.equal(isUserMoreSenior(firstUser, secondUser), true);
    assert.equal(isUserMoreSenior(secondUser, firstUser), false);
});

test('Conflict resolution: when both users edit the same transaction, the first-ever logged-in user wins', () => {
    const firstUser = { username: 'alice_first', firstLoginOrder: 1, firstLoginAt: 1000 };
    const secondUser = { username: 'bob_second', firstLoginOrder: 2, firstLoginAt: 5000 };

    const baseBudgets = [
        {
            id: 'b-1',
            name: '1 - Tithe',
            subBudgets: [
                {
                    id: 's-1',
                    name: 'General',
                    transactions: [
                        {
                            id: 'tx-1',
                            date: '2026-11-01',
                            bank: 'Checking',
                            amount: 100,
                            note: 'Initial Note',
                            tags: ['init'],
                            reconciled: null,
                            planned: false,
                            recurring: false
                        }
                    ]
                }
            ]
        }
    ];

    // Scenario A: Alice (User #1) already synced her change to server ($250, 'Alice Note').
    // Now Bob (User #2) syncs a conflicting offline edit ($999, 'Bob Conflicting Note') with the same baseBudgets.
    // Because Alice logged in first ever before Bob, Alice's changes MUST be kept!
    const aliceBudgetsOnServer = JSON.parse(JSON.stringify(baseBudgets));
    aliceBudgetsOnServer[0].subBudgets[0].transactions[0].amount = 250;
    aliceBudgetsOnServer[0].subBudgets[0].transactions[0].note = 'Alice Note';

    const serverMetaAfterAlice = {
        budgets: { 'b-1': { updatedBy: 'alice_first', firstLoginOrder: 1, firstLoginAt: 1000 } },
        subBudgets: { 's-1': { updatedBy: 'alice_first', firstLoginOrder: 1, firstLoginAt: 1000 } },
        transactions: { 'tx-1': { updatedBy: 'alice_first', firstLoginOrder: 1, firstLoginAt: 1000 } },
        lastEditor: firstUser
    };

    const bobClientBudgets = JSON.parse(JSON.stringify(baseBudgets));
    bobClientBudgets[0].subBudgets[0].transactions[0].amount = 999;
    bobClientBudgets[0].subBudgets[0].transactions[0].note = 'Bob Conflicting Note';

    const resWhenBobSyncsAfterAlice = mergeBudgetState({
        serverBudgets: aliceBudgetsOnServer,
        serverMeta: serverMetaAfterAlice,
        baseBudgets,
        clientBudgets: bobClientBudgets,
        clientUser: secondUser
    });

    const txAfterBob = resWhenBobSyncsAfterAlice.mergedBudgets[0].subBudgets[0].transactions[0];
    assert.equal(txAfterBob.amount, 250, 'First-ever user (Alice) amount must win over second user (Bob)');
    assert.equal(txAfterBob.note, 'Alice Note', 'First-ever user (Alice) note must win over second user (Bob)');
    assert.equal(resWhenBobSyncsAfterAlice.conflictsResolved.length, 1);
    assert.equal(resWhenBobSyncsAfterAlice.conflictsResolved[0].winner, 'alice_first');

    // Scenario B: Bob (User #2) synced his change to server first while Alice (User #1) was offline.
    // Later, Alice (User #1) comes online and syncs her conflicting offline change ($250, 'Alice Note').
    // Because Alice logged in first ever before Bob, Alice's offline changes MUST overwrite Bob's conflicting change!
    const serverMetaAfterBob = {
        budgets: { 'b-1': { updatedBy: 'bob_second', firstLoginOrder: 2, firstLoginAt: 5000 } },
        subBudgets: { 's-1': { updatedBy: 'bob_second', firstLoginOrder: 2, firstLoginAt: 5000 } },
        transactions: { 'tx-1': { updatedBy: 'bob_second', firstLoginOrder: 2, firstLoginAt: 5000 } },
        lastEditor: secondUser
    };

    const resWhenAliceSyncsAfterBob = mergeBudgetState({
        serverBudgets: bobClientBudgets,
        serverMeta: serverMetaAfterBob,
        baseBudgets,
        clientBudgets: aliceBudgetsOnServer,
        clientUser: firstUser
    });

    const txAfterAlice = resWhenAliceSyncsAfterBob.mergedBudgets[0].subBudgets[0].transactions[0];
    assert.equal(txAfterAlice.amount, 250, 'Alice (User #1) must overwrite Bob (User #2) on conflict');
    assert.equal(txAfterAlice.note, 'Alice Note');
    assert.equal(resWhenAliceSyncsAfterBob.conflictsResolved.length, 1);
    assert.equal(resWhenAliceSyncsAfterBob.conflictsResolved[0].winner, 'alice_first');
});

test('End-to-end API: login order registration, non-conflicting merge, and seniority conflict resolution', async () => {
    cleanupTestDb();
    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
        // 1. First user ever logs in -> gets firstLoginOrder = 1
        const login1 = await requestJson(server, 'POST', '/api/auth/login', {
            username: 'founder_user',
            password: 'password123'
        });
        assert.equal(login1.status, 200);
        assert.equal(login1.body.user.firstLoginOrder, 1);
        assert.equal(login1.body.user.isSeniorMostUser, true);

        // 2. Second user logs in afterwards -> gets firstLoginOrder = 2
        const login2 = await requestJson(server, 'POST', '/api/auth/login', {
            username: 'second_user',
            password: 'password456'
        });
        assert.equal(login2.status, 200);
        assert.equal(login2.body.user.firstLoginOrder, 2);
        assert.equal(login2.body.user.isSeniorMostUser, false);
        assert.equal(login2.body.seniorMostUser.username, 'founder_user');

        // 3. Initial sync by founder_user
        const initialBudgets = [
            {
                id: 'budget-main',
                name: 'Household',
                subBudgets: [
                    {
                        id: 'sub-groceries',
                        name: 'Groceries',
                        transactions: [
                            {
                                id: 'tx-100',
                                date: '2026-11-09',
                                bank: 'Ally',
                                amount: -50.25,
                                note: 'Weekly market',
                                tags: ['food'],
                                reconciled: null,
                                planned: false,
                                recurring: false
                            }
                        ]
                    }
                ]
            }
        ];

        const sync1 = await requestJson(
            server,
            'POST',
            '/api/sync',
            { clientBudgets: initialBudgets, baseBudgets: null },
            login1.body.token
        );
        assert.equal(sync1.status, 200);
        assert.equal(sync1.body.budgets.length, 1);

        // 4. Both users start from `initialBudgets` offline.
        // `second_user` (priority #2) syncs an edit to `tx-100` while `founder_user` (priority #1) is offline.
        const secondUserEdit = JSON.parse(JSON.stringify(initialBudgets));
        secondUserEdit[0].subBudgets[0].transactions[0].amount = -999.99;
        secondUserEdit[0].subBudgets[0].transactions[0].note = 'Second user edit';

        const sync2 = await requestJson(
            server,
            'POST',
            '/api/sync',
            { clientBudgets: secondUserEdit, baseBudgets: initialBudgets },
            login2.body.token
        );
        assert.equal(sync2.status, 200);
        assert.equal(sync2.body.budgets[0].subBudgets[0].transactions[0].amount, -999.99);

        // 5. Now `founder_user` (priority #1) reconnects and syncs their conflicting offline edit to `tx-100`.
        // Since `founder_user` logged in first ever, their change (-75.50, 'Founder verified') must win!
        const founderOfflineEdit = JSON.parse(JSON.stringify(initialBudgets));
        founderOfflineEdit[0].subBudgets[0].transactions[0].amount = -75.5;
        founderOfflineEdit[0].subBudgets[0].transactions[0].note = 'Founder verified';

        const sync3 = await requestJson(
            server,
            'POST',
            '/api/sync',
            { clientBudgets: founderOfflineEdit, baseBudgets: initialBudgets },
            login1.body.token
        );
        assert.equal(sync3.status, 200);
        assert.equal(sync3.body.budgets[0].subBudgets[0].transactions[0].amount, -75.5);
        assert.equal(sync3.body.budgets[0].subBudgets[0].transactions[0].note, 'Founder verified');
        assert.equal(sync3.body.conflictsResolved[0].winner, 'founder_user');

        // 6. Non-conflicting offline additions by both users merge cleanly without data loss
        const baseForMerge = sync3.body.budgets;
        const founderAddsTx = JSON.parse(JSON.stringify(baseForMerge));
        founderAddsTx[0].subBudgets[0].transactions.push({
            id: 'tx-founder-new',
            date: '2026-11-10',
            bank: 'Ally',
            amount: -20,
            note: 'Founder new item',
            tags: [],
            reconciled: null,
            planned: false,
            recurring: false
        });

        await requestJson(
            server,
            'POST',
            '/api/sync',
            { clientBudgets: founderAddsTx, baseBudgets: baseForMerge },
            login1.body.token
        );

        const secondAddsTx = JSON.parse(JSON.stringify(baseForMerge));
        secondAddsTx[0].subBudgets[0].transactions.push({
            id: 'tx-second-new',
            date: '2026-11-10',
            bank: 'Ally',
            amount: -15,
            note: 'Second user non-conflicting item',
            tags: [],
            reconciled: null,
            planned: false,
            recurring: false
        });

        const syncNonConflicting = await requestJson(
            server,
            'POST',
            '/api/sync',
            { clientBudgets: secondAddsTx, baseBudgets: baseForMerge },
            login2.body.token
        );
        assert.equal(syncNonConflicting.status, 200);
        const mergedTxIds = syncNonConflicting.body.budgets[0].subBudgets[0].transactions.map(t => t.id);
        assert.ok(mergedTxIds.includes('tx-100'));
        assert.ok(mergedTxIds.includes('tx-founder-new'));
        assert.ok(mergedTxIds.includes('tx-second-new'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        cleanupTestDb();
    }
});
