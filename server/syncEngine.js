/**
 * Sync & Conflict Resolution Engine for 20yr Budgeting
 *
 * Conflict Resolution Rule:
 * "if there is conflicting changes, then accepting the user's changes who is the first ever logged in before the other user."
 *
 * How it works:
 * - Every user receives a permanent `firstLoginAt` (epoch ms) and `firstLoginOrder` (monotonic integer: 1, 2, 3...)
 *   the very first time they ever log in.
 * - When a client syncs, it sends:
 *   - `baseBudgets`: the last synced snapshot the client had before making offline edits (or null if first sync)
 *   - `clientBudgets`: the client's current budgets tree (including any offline edits)
 *   - `deletedIds`: optional explicit tombstones { budgets: [], subBudgets: [], transactions: [] }
 * - We compare `baseBudgets` vs `clientBudgets` (client's changes) and `baseBudgets` vs `serverBudgets` (server's current state,
 *   which includes changes from other users and metadata tracking who last modified each entity since base).
 * - If only the client changed an entity (and the server version hasn't been modified by another user since base),
 *   the client's change is applied cleanly.
 * - If only the server changed an entity (the client did not touch it relative to base), the server's version is kept.
 * - If BOTH the client and another user on the server changed the same entity (or one deleted and the other modified,
 *   or both modified the same budget/sub-budget/transaction differently):
 *   A CONFLICT exists!
 *   We compare the seniority (`firstLoginOrder` / `firstLoginAt`) of the current syncing user (`clientUser`)
 *   against the user who made the conflicting server change (`serverModifierUser`).
 *   The user who logged in first EVER (smaller `firstLoginOrder` / earlier `firstLoginAt`) wins, and their changes are accepted!
 */

function normalizeAmount(val) {
    const n = parseFloat(val);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function normalizeTransaction(tx) {
    if (!tx) return null;
    return {
        id: String(tx.id),
        date: tx.date || '',
        bank: tx.bank || '',
        amount: normalizeAmount(tx.amount),
        note: tx.note || '',
        tags: Array.isArray(tx.tags) ? [...tx.tags].map(String) : [],
        reconciled: tx.reconciled || null,
        planned: !!tx.planned,
        recurring: !!tx.recurring
    };
}

function transactionsEqual(a, b) {
    if (!a || !b) return a === b;
    const na = normalizeTransaction(a);
    const nb = normalizeTransaction(b);
    return (
        na.id === nb.id &&
        na.date === nb.date &&
        na.bank === nb.bank &&
        na.amount === nb.amount &&
        na.note === nb.note &&
        na.reconciled === nb.reconciled &&
        na.planned === nb.planned &&
        na.recurring === nb.recurring &&
        JSON.stringify(na.tags) === JSON.stringify(nb.tags)
    );
}

/**
 * Flatten a budgets tree into indexed maps of budgets, subBudgets, and transactions
 */
function indexBudgetTree(budgets = []) {
    const budgetMap = new Map();
    const subBudgetMap = new Map();
    const txMap = new Map();

    if (!Array.isArray(budgets)) return { budgetMap, subBudgetMap, txMap };

    budgets.forEach((b, bOrder) => {
        if (!b || !b.id) return;
        budgetMap.set(b.id, {
            id: b.id,
            name: b.name || '',
            order: bOrder,
            raw: b
        });

        const subs = Array.isArray(b.subBudgets) ? b.subBudgets : [];
        subs.forEach((s, sOrder) => {
            if (!s || !s.id) return;
            subBudgetMap.set(s.id, {
                id: s.id,
                budgetId: b.id,
                name: s.name || '',
                order: sOrder,
                raw: s
            });

            const txs = Array.isArray(s.transactions) ? s.transactions : [];
            txs.forEach((t, tOrder) => {
                if (!t || !t.id) return;
                txMap.set(t.id, {
                    id: t.id,
                    budgetId: b.id,
                    subBudgetId: s.id,
                    order: tOrder,
                    tx: normalizeTransaction(t),
                    raw: t
                });
            });
        });
    });

    return { budgetMap, subBudgetMap, txMap };
}

/**
 * Determine if userA logged in first EVER before userB.
 * Returns true if userA has priority over userB.
 */
function isUserMoreSenior(userA, userB) {
    if (!userB) return true;
    if (!userA) return false;
    if (userA.username && userB.username && userA.username === userB.username) {
        // Same user on another session/device: latest change from same user applies
        return true;
    }

    const orderA = Number(userA.firstLoginOrder);
    const orderB = Number(userB.firstLoginOrder);
    if (Number.isFinite(orderA) && Number.isFinite(orderB) && orderA !== orderB) {
        return orderA < orderB;
    }

    const timeA = Number(userA.firstLoginAt);
    const timeB = Number(userB.firstLoginAt);
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
        return timeA < timeB;
    }

    return false;
}

/**
 * Perform 3-way / seniority-aware merge between server state and client state.
 *
 * @param {Object} params
 * @param {Array} params.serverBudgets - Current budgets array on server
 * @param {Object} params.serverMeta - Metadata map on server:
 *   {
 *     budgets: { [id]: { updatedBy, firstLoginOrder, firstLoginAt, updatedAt, deleted } },
 *     subBudgets: { [id]: { updatedBy, firstLoginOrder, firstLoginAt, updatedAt, deleted } },
 *     transactions: { [id]: { updatedBy, firstLoginOrder, firstLoginAt, updatedAt, deleted } },
 *     lastEditor: { username, firstLoginOrder, firstLoginAt }
 *   }
 * @param {Array|null} params.baseBudgets - Client's last known synced budgets snapshot (optional)
 * @param {Array} params.clientBudgets - Client's current budgets array
 * @param {Object} params.clientUser - { username, firstLoginOrder, firstLoginAt }
 * @returns {Object} { mergedBudgets, updatedMeta, conflictsResolved }
 */
function mergeBudgetState({
    serverBudgets = [],
    serverMeta = {},
    baseBudgets = null,
    clientBudgets = [],
    clientUser
}) {
    const now = Date.now();
    const meta = {
        budgets: { ...(serverMeta.budgets || {}) },
        subBudgets: { ...(serverMeta.subBudgets || {}) },
        transactions: { ...(serverMeta.transactions || {}) },
        lastEditor: serverMeta.lastEditor || null
    };

    const conflictsResolved = [];

    // If server has no data yet and no history, accept clientBudgets directly
    const serverIsEmpty =
        (!Array.isArray(serverBudgets) || serverBudgets.length === 0) &&
        Object.keys(meta.budgets).length === 0 &&
        Object.keys(meta.transactions).length === 0;

    if (serverIsEmpty) {
        const clientIdx = indexBudgetTree(clientBudgets);
        for (const [id] of clientIdx.budgetMap) {
            meta.budgets[id] = {
                updatedBy: clientUser.username,
                firstLoginOrder: clientUser.firstLoginOrder,
                firstLoginAt: clientUser.firstLoginAt,
                updatedAt: now,
                deleted: false
            };
        }
        for (const [id] of clientIdx.subBudgetMap) {
            meta.subBudgets[id] = {
                updatedBy: clientUser.username,
                firstLoginOrder: clientUser.firstLoginOrder,
                firstLoginAt: clientUser.firstLoginAt,
                updatedAt: now,
                deleted: false
            };
        }
        for (const [id] of clientIdx.txMap) {
            meta.transactions[id] = {
                updatedBy: clientUser.username,
                firstLoginOrder: clientUser.firstLoginOrder,
                firstLoginAt: clientUser.firstLoginAt,
                updatedAt: now,
                deleted: false
            };
        }
        meta.lastEditor = {
            username: clientUser.username,
            firstLoginOrder: clientUser.firstLoginOrder,
            firstLoginAt: clientUser.firstLoginAt
        };
        return {
            mergedBudgets: JSON.parse(JSON.stringify(clientBudgets || [])),
            updatedMeta: meta,
            conflictsResolved
        };
    }

    const serverIdx = indexBudgetTree(serverBudgets);
    const clientIdx = indexBudgetTree(clientBudgets);
    const hasBase = Array.isArray(baseBudgets);
    const baseIdx = hasBase ? indexBudgetTree(baseBudgets) : null;

    const getEntityModifier = (type, id) => {
        const entry = meta[type] && meta[type][id];
        if (entry && entry.updatedBy) {
            return {
                username: entry.updatedBy,
                firstLoginOrder: entry.firstLoginOrder,
                firstLoginAt: entry.firstLoginAt
            };
        }
        return meta.lastEditor || null;
    };

    const recordClientWin = (type, id) => {
        meta[type][id] = {
            updatedBy: clientUser.username,
            firstLoginOrder: clientUser.firstLoginOrder,
            firstLoginAt: clientUser.firstLoginAt,
            updatedAt: now,
            deleted: false
        };
    };

    const recordClientDelete = (type, id) => {
        meta[type][id] = {
            updatedBy: clientUser.username,
            firstLoginOrder: clientUser.firstLoginOrder,
            firstLoginAt: clientUser.firstLoginAt,
            updatedAt: now,
            deleted: true
        };
    };

    // 1. Resolve Budgets
    const allBudgetIds = new Set([
        ...serverIdx.budgetMap.keys(),
        ...clientIdx.budgetMap.keys(),
        ...(baseIdx ? baseIdx.budgetMap.keys() : [])
    ]);

    const resolvedBudgetsMap = new Map();

    for (const bId of allBudgetIds) {
        const sB = serverIdx.budgetMap.get(bId) || null;
        const cB = clientIdx.budgetMap.get(bId) || null;
        const bB = baseIdx ? baseIdx.budgetMap.get(bId) || null : null;
        const sMeta = meta.budgets[bId];

        const serverChanged = hasBase
            ? (!bB && !!sB) || (!!bB && !sB) || (!!bB && !!sB && bB.name !== sB.name)
            : true;
        const clientChanged = hasBase
            ? (!bB && !!cB) || (!!bB && !cB) || (!!bB && !!cB && bB.name !== cB.name)
            : true;

        if (sB && cB) {
            if (sB.name === cB.name) {
                resolvedBudgetsMap.set(bId, { id: bId, name: cB.name, order: cB.order, subBudgets: [] });
            } else if (hasBase && !serverChanged && clientChanged) {
                resolvedBudgetsMap.set(bId, { id: bId, name: cB.name, order: cB.order, subBudgets: [] });
                recordClientWin('budgets', bId);
            } else if (hasBase && serverChanged && !clientChanged) {
                resolvedBudgetsMap.set(bId, { id: bId, name: sB.name, order: sB.order, subBudgets: [] });
            } else {
                // Both changed or no base: conflict!
                const serverMod = getEntityModifier('budgets', bId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'budget',
                    entityId: bId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    resolvedBudgetsMap.set(bId, { id: bId, name: cB.name, order: cB.order, subBudgets: [] });
                    recordClientWin('budgets', bId);
                } else {
                    resolvedBudgetsMap.set(bId, { id: bId, name: sB.name, order: sB.order, subBudgets: [] });
                }
            }
        } else if (cB && !sB) {
            // Client has budget, server does not
            const wasDeletedOnServer = (hasBase && !!bB) || (sMeta && sMeta.deleted);
            if (!wasDeletedOnServer) {
                // Newly created by client
                resolvedBudgetsMap.set(bId, { id: bId, name: cB.name, order: cB.order, subBudgets: [] });
                recordClientWin('budgets', bId);
            } else if (hasBase && !clientChanged) {
                // Deleted on server and client didn't touch it -> stay deleted
            } else {
                // Conflict between server deletion and client modification/existence
                const serverMod = getEntityModifier('budgets', bId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'budget',
                    entityId: bId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    resolvedBudgetsMap.set(bId, { id: bId, name: cB.name, order: cB.order, subBudgets: [] });
                    recordClientWin('budgets', bId);
                }
            }
        } else if (sB && !cB) {
            // Server has budget, client does not
            const wasDeletedOnClient = hasBase && !!bB;
            if (!wasDeletedOnClient && hasBase) {
                // Newly created on server while client was offline -> keep server's new budget
                resolvedBudgetsMap.set(bId, { id: bId, name: sB.name, order: sB.order, subBudgets: [] });
            } else if (wasDeletedOnClient && !serverChanged) {
                // Client deleted it and server didn't change it -> accept client delete
                recordClientDelete('budgets', bId);
            } else {
                // Conflict (client deleted vs server modified, or no-base full state conflict)
                const serverMod = getEntityModifier('budgets', bId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'budget',
                    entityId: bId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    recordClientDelete('budgets', bId);
                } else {
                    resolvedBudgetsMap.set(bId, { id: bId, name: sB.name, order: sB.order, subBudgets: [] });
                }
            }
        }
    }

    // 2. Resolve Sub-Budgets
    const allSubBudgetIds = new Set([
        ...serverIdx.subBudgetMap.keys(),
        ...clientIdx.subBudgetMap.keys(),
        ...(baseIdx ? baseIdx.subBudgetMap.keys() : [])
    ]);

    const resolvedSubBudgetsMap = new Map();

    const ensureBudgetExists = (budgetId, fallbackSource) => {
        if (!resolvedBudgetsMap.has(budgetId)) {
            const bInfo =
                serverIdx.budgetMap.get(budgetId) ||
                clientIdx.budgetMap.get(budgetId) ||
                (baseIdx && baseIdx.budgetMap.get(budgetId)) ||
                fallbackSource;
            if (bInfo) {
                resolvedBudgetsMap.set(budgetId, {
                    id: budgetId,
                    name: bInfo.name || 'Recovered Budget',
                    order: bInfo.order ?? 999,
                    subBudgets: []
                });
            }
        }
    };

    for (const sId of allSubBudgetIds) {
        const sS = serverIdx.subBudgetMap.get(sId) || null;
        const cS = clientIdx.subBudgetMap.get(sId) || null;
        const bS = baseIdx ? baseIdx.subBudgetMap.get(sId) || null : null;
        const sMeta = meta.subBudgets[sId];

        const subEqual = (a, b) => a && b && a.name === b.name && a.budgetId === b.budgetId;
        const serverChanged = hasBase
            ? (!bS && !!sS) || (!!bS && !sS) || (!!bS && !!sS && !subEqual(bS, sS))
            : true;
        const clientChanged = hasBase
            ? (!bS && !!cS) || (!!bS && !cS) || (!!bS && !!cS && !subEqual(bS, cS))
            : true;

        let chosen = null;

        if (sS && cS) {
            if (subEqual(sS, cS)) {
                chosen = cS;
            } else if (hasBase && !serverChanged && clientChanged) {
                chosen = cS;
                recordClientWin('subBudgets', sId);
            } else if (hasBase && serverChanged && !clientChanged) {
                chosen = sS;
            } else {
                const serverMod = getEntityModifier('subBudgets', sId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'subBudget',
                    entityId: sId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    chosen = cS;
                    recordClientWin('subBudgets', sId);
                } else {
                    chosen = sS;
                }
            }
        } else if (cS && !sS) {
            const wasDeletedOnServer = (hasBase && !!bS) || (sMeta && sMeta.deleted);
            if (!wasDeletedOnServer) {
                chosen = cS;
                recordClientWin('subBudgets', sId);
            } else if (hasBase && !clientChanged) {
                chosen = null;
            } else {
                const serverMod = getEntityModifier('subBudgets', sId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'subBudget',
                    entityId: sId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    chosen = cS;
                    recordClientWin('subBudgets', sId);
                }
            }
        } else if (sS && !cS) {
            const wasDeletedOnClient = hasBase && !!bS;
            if (!wasDeletedOnClient && hasBase) {
                chosen = sS;
            } else if (wasDeletedOnClient && !serverChanged) {
                recordClientDelete('subBudgets', sId);
                chosen = null;
            } else {
                const serverMod = getEntityModifier('subBudgets', sId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'subBudget',
                    entityId: sId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    recordClientDelete('subBudgets', sId);
                    chosen = null;
                } else {
                    chosen = sS;
                }
            }
        }

        if (chosen && resolvedBudgetsMap.has(chosen.budgetId)) {
            resolvedSubBudgetsMap.set(sId, {
                id: sId,
                budgetId: chosen.budgetId,
                name: chosen.name,
                order: chosen.order,
                transactions: []
            });
        }
    }

    // 3. Resolve Transactions
    const allTxIds = new Set([
        ...serverIdx.txMap.keys(),
        ...clientIdx.txMap.keys(),
        ...(baseIdx ? baseIdx.txMap.keys() : [])
    ]);

    const txEntryEqual = (a, b) =>
        a && b && a.subBudgetId === b.subBudgetId && transactionsEqual(a.tx, b.tx);

    for (const tId of allTxIds) {
        const sT = serverIdx.txMap.get(tId) || null;
        const cT = clientIdx.txMap.get(tId) || null;
        const bT = baseIdx ? baseIdx.txMap.get(tId) || null : null;
        const sMeta = meta.transactions[tId];

        const serverChanged = hasBase
            ? (!bT && !!sT) || (!!bT && !sT) || (!!bT && !!sT && !txEntryEqual(bT, sT))
            : true;
        const clientChanged = hasBase
            ? (!bT && !!cT) || (!!bT && !cT) || (!!bT && !!cT && !txEntryEqual(bT, cT))
            : true;

        let chosen = null;

        if (sT && cT) {
            if (txEntryEqual(sT, cT)) {
                chosen = cT;
            } else if (hasBase && !serverChanged && clientChanged) {
                chosen = cT;
                recordClientWin('transactions', tId);
            } else if (hasBase && serverChanged && !clientChanged) {
                chosen = sT;
            } else {
                // Both modified the same transaction differently!
                const serverMod = getEntityModifier('transactions', tId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'transaction',
                    entityId: tId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    chosen = cT;
                    recordClientWin('transactions', tId);
                } else {
                    chosen = sT;
                }
            }
        } else if (cT && !sT) {
            const wasDeletedOnServer = (hasBase && !!bT) || (sMeta && sMeta.deleted);
            if (!wasDeletedOnServer) {
                chosen = cT;
                recordClientWin('transactions', tId);
            } else if (hasBase && !clientChanged) {
                chosen = null;
            } else {
                const serverMod = getEntityModifier('transactions', tId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'transaction',
                    entityId: tId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    chosen = cT;
                    recordClientWin('transactions', tId);
                }
            }
        } else if (sT && !cT) {
            const wasDeletedOnClient = hasBase && !!bT;
            if (!wasDeletedOnClient && hasBase) {
                chosen = sT;
            } else if (wasDeletedOnClient && !serverChanged) {
                recordClientDelete('transactions', tId);
                chosen = null;
            } else {
                const serverMod = getEntityModifier('transactions', tId);
                const clientWins = isUserMoreSenior(clientUser, serverMod);
                conflictsResolved.push({
                    entityType: 'transaction',
                    entityId: tId,
                    winner: clientWins ? clientUser.username : (serverMod?.username || 'server'),
                    clientUser: clientUser.username,
                    serverUser: serverMod?.username || 'server'
                });
                if (clientWins) {
                    recordClientDelete('transactions', tId);
                    chosen = null;
                } else {
                    chosen = sT;
                }
            }
        }

        if (chosen) {
            // Ensure parent subBudget exists if transaction won
            if (!resolvedSubBudgetsMap.has(chosen.subBudgetId)) {
                const subInfo =
                    serverIdx.subBudgetMap.get(chosen.subBudgetId) ||
                    clientIdx.subBudgetMap.get(chosen.subBudgetId) ||
                    (baseIdx && baseIdx.subBudgetMap.get(chosen.subBudgetId));
                if (subInfo) {
                    ensureBudgetExists(subInfo.budgetId);
                    if (resolvedBudgetsMap.has(subInfo.budgetId)) {
                        resolvedSubBudgetsMap.set(chosen.subBudgetId, {
                            id: chosen.subBudgetId,
                            budgetId: subInfo.budgetId,
                            name: subInfo.name,
                            order: subInfo.order ?? 999,
                            transactions: []
                        });
                    }
                }
            }

            const parentSub = resolvedSubBudgetsMap.get(chosen.subBudgetId);
            if (parentSub) {
                parentSub.transactions.push({
                    ...chosen.tx,
                    _order: chosen.order ?? 0
                });
            }
        }
    }

    // 4. Assemble final tree
    for (const sub of resolvedSubBudgetsMap.values()) {
        sub.transactions.sort((a, b) => (a._order ?? 0) - (b._order ?? 0));
        sub.transactions = sub.transactions.map(({ _order, ...rest }) => rest);
        const parentBudget = resolvedBudgetsMap.get(sub.budgetId);
        if (parentBudget) {
            parentBudget.subBudgets.push(sub);
        }
    }

    const mergedBudgets = Array.from(resolvedBudgetsMap.values())
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(b => ({
            id: b.id,
            name: b.name,
            subBudgets: b.subBudgets
                .sort((a, s2) => (a.order ?? 0) - (s2.order ?? 0))
                .map(s => ({
                    id: s.id,
                    name: s.name,
                    transactions: s.transactions
                }))
        }));

    meta.lastEditor = {
        username: clientUser.username,
        firstLoginOrder: clientUser.firstLoginOrder,
        firstLoginAt: clientUser.firstLoginAt
    };

    return {
        mergedBudgets,
        updatedMeta: meta,
        conflictsResolved
    };
}

module.exports = {
    isUserMoreSenior,
    mergeBudgetState,
    indexBudgetTree,
    transactionsEqual
};
