document.addEventListener('alpine:init', () => {
    Alpine.data('budgetApp', () => ({
        // State
        themeColors: JSON.parse(localStorage.getItem('budgetColors')) || {
            'bg-tan': '#2d241e',
            'card-tan': '#3d3228',
            'light-tan': '#f5e6d3',
            'border-tan': '#5c4a3c'
        },
        themeFonts: JSON.parse(localStorage.getItem('budgetFonts')) || {
            'headers': { family: 'system-ui', size: '' },
            'report-headers': { family: 'system-ui', size: '' },
            'body': { family: 'system-ui', size: '' },
            'report-body': { family: 'system-ui', size: '' }
        },
        budgets: [],
        fileHandle: null,
        isSyncing: false,
        isLoading: false,
        searchQuery: '',
        subBudgetSearchQuery: '',
        bankingSearchQuery: '',
        bankingSelectedTags: [],
        bankingTagInput: '',
        showBankingTagSuggestions: false,
        currentTagInput: '',
        showTagSuggestions: false,
        currentPage: 'home', // 'home', 'banking', 'paycheck'
        selectedBudget: null,
        selectedSubBudget: null,
        paycheckSelectedBudget: null,
        paycheckSelectedSubBudget: null,
        banks: [],
        paycheckBank: '',
        paycheckDate: new Date().toISOString().split('T')[0],
        deleteMode: false,
        pendingDelete: { type: null, id: null, subId: null },
        deleteTimer: null,
        undoHistory: [],
        lastState: null,
        flashingId: null,
        displayedBalances: {}, // budgetId -> amount

        // Report Page State
        reportYear: new Date().getFullYear().toString(),
        reportStartDate: '', // Will be set to 2 weeks ago initially
        reportEndDate: new Date().toISOString().split('T')[0],

        // Scan Page State
        scanSearchQuery: '',
        scanSelectedTags: [],
        scanCheckedTransactions: [], // Array of IDs
        allScanTransactionsChecked: false,
        scanNewTransaction: {
            bank: '',
            targetId: '',
            date: new Date().toISOString().split('T')[0],
            amount: '',
            note: '',
            tags: []
        },

        // Sorting
        sortByAmount: false,
        
        draggingBank: null,
        draggingBudget: null,
        draggingSubBudget: null,
        
        // Initial Data
        init() {
            this.loadData();
            this.lastState = JSON.stringify(this.budgets);
            this.refreshBanks();
            
            // Set default report start date to 2 weeks ago
            let twoWeeksAgo = new Date();
            twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
            this.reportStartDate = twoWeeksAgo.toISOString().split('T')[0];

            // load navigation state
            const savedPage = localStorage.getItem('current_page');
            if (savedPage) this.currentPage = savedPage;

            const savedBudgetId = localStorage.getItem('selected_budget_id');
            if (savedBudgetId) {
                this.selectedBudget = this.budgets.find(b => b.id === savedBudgetId) || null;
            }

            const savedSubBudgetId = localStorage.getItem('selected_sub_budget_id');
            if (savedSubBudgetId) {
                this.selectedSubBudget = this.getSubBudgetById(savedSubBudgetId);
            }

            // load sort preference
            const pref = localStorage.getItem('sort_by_amount');
            this.sortByAmount = pref === 'true';

            const delMode = localStorage.getItem('delete_mode');
            this.deleteMode = delMode === 'true';
            
            // Auto-save whenever budgets change
            this.$watch('budgets', async (value) => {
                try {
                    console.log('Budgets changed, triggering watcher');
                    const currentState = JSON.stringify(value);
                    if (currentState !== this.lastState) {
                        if (this.lastState !== null) {
                            this.undoHistory.push(this.lastState);
                            if (this.undoHistory.length > 15) {
                                this.undoHistory.shift();
                            }
                        }
                        this.lastState = currentState;
                    }

                    this.saveData();
                    this.refreshBanks();
                    this.refreshSelections();
                    if (this.refreshSummary && typeof this.refreshSummary === 'function') {
                        this.refreshSummary();
                    }
                    if (this.fileHandle) {
                        this.syncToFile(); // Don't await here to prevent UI hang, let it run in background
                    }
                    console.log('Watcher completed successfully');
                } catch (err) {
                    console.error('Error in budgets watcher:', err);
                } finally {
                    // Extra safety: ensure isLoading is false if it was somehow triggered
                    // though usually the methods themselves handle it.
                    // We don't want to force it to false if another process is legitimately loading,
                    // but if there's an error in the watcher, we should at least report it.
                }
            }, { deep: true });

            // persist sort preference
            this.$watch('sortByAmount', async (val) => {
                localStorage.setItem('sort_by_amount', val ? 'true' : 'false');
                
                // Keep the loader shown for a bit to simulate calculation
                await new Promise(resolve => setTimeout(resolve, 600));
                this.isLoading = false;
            });

            this.$watch('deleteMode', (val) => {
                localStorage.setItem('delete_mode', val ? 'true' : 'false');
            });

            this.$watch('currentPage', (val) => {
                localStorage.setItem('current_page', val);
            });

            this.$watch('selectedBudget', (val) => {
                localStorage.setItem('selected_budget_id', val ? val.id : '');
            });

            this.$watch('selectedSubBudget', (val) => {
                localStorage.setItem('selected_sub_budget_id', val ? val.id : '');
            });

            this.$watch('scanSearchQuery', () => this.updateAllScanTransactionsChecked());
            this.$watch('scanSelectedTags', () => this.updateAllScanTransactionsChecked());
        },

        loadData() {
            const saved = localStorage.getItem('budget_data');
            if (saved) {
                this.budgets = JSON.parse(saved);
            } else {
                // Initial Seed
                this.budgets = [];
            }
        },

        saveData() {
            localStorage.setItem('budget_data', JSON.stringify(this.budgets));
        },

        openEditColorsModal() {
            this.modalType = 'editColors';
            this.modalData = {
                'bg-tan': this.themeColors['bg-tan'],
                'card-tan': this.themeColors['card-tan'],
                'light-tan': this.themeColors['light-tan'],
                'border-tan': this.themeColors['border-tan']
            };
            this.modalOpen = true;
        },

        saveColors() {
            this.themeColors = { ...this.modalData };
            localStorage.setItem('budgetColors', JSON.stringify(this.themeColors));
            this.modalOpen = false;
            window.location.reload();
        },

        openEditFontsModal() {
            this.modalType = 'editFonts';
            // Copy deep to avoid reactive changes before save
            this.modalData = JSON.parse(JSON.stringify(this.themeFonts));
            this.modalOpen = true;
            
            // Try to load system fonts for datalist
            if ('queryLocalFonts' in window) {
                window.queryLocalFonts().then(fonts => {
                    const list = document.getElementById('font-list');
                    if(list && list.options.length < 20) { // simple check to avoid re-adding
                        const added = new Set();
                        fonts.forEach(font => {
                            if (!added.has(font.family)) {
                                let opt = document.createElement('option');
                                opt.value = font.family;
                                list.appendChild(opt);
                                added.add(font.family);
                            }
                        });
                    }
                }).catch(err => console.log("Local font access not available/denied", err));
            }
        },

        saveFonts() {
            this.themeFonts = JSON.parse(JSON.stringify(this.modalData));
            localStorage.setItem('budgetFonts', JSON.stringify(this.themeFonts));
            this.modalOpen = false;
            window.location.reload();
        },

        async exportData() {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            const timestamp = `${year}-${month}-${day}_${hours}${minutes}`;
            const fileName = `budget_export_${timestamp}.json`;

            const data = JSON.stringify(this.budgets, null, 2);

            // Try to use File System Access API if available
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: fileName,
                        types: [{
                            description: 'JSON Files',
                            accept: { 'application/json': ['.json'] },
                        }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(data);
                    await writable.close();
                    return;
                } catch (err) {
                    console.error('Export cancelled or failed:', err);
                    // Fallback to traditional download if user cancels or error occurs
                    if (err.name === 'AbortError') return;
                }
            }

            // Fallback: Traditional download
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
        },

        importData(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.isLoading = true;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    this.budgets = JSON.parse(e.target.result);
                    this.saveData();
                    alert('Data imported successfully!');
                } catch (err) {
                    alert('Failed to import data: Invalid JSON');
                } finally {
                    this.isLoading = false;
                }
            };
            reader.readAsText(file);
        },

        async undo() {
            if (this.undoHistory.length > 0) {
                this.isLoading = true;
                try {
                    const prevState = this.undoHistory.pop();
                    this.budgets = JSON.parse(prevState);
                    this.lastState = prevState;
                    this.saveData();
                    
                    // Allow some time for the loading animation to be seen
                    await new Promise(resolve => setTimeout(resolve, 500));
                    window.location.reload();
                } finally {
                    this.isLoading = false;
                }
            }
        },

        async linkSyncFile() {
            if (!window.showSaveFilePicker) {
                alert('Your browser does not support the File System Access API. Sync to local file is only available in modern browsers like Chrome or Edge.');
                return;
            }
            try {
                this.fileHandle = await window.showSaveFilePicker({
                    suggestedName: 'budgets.json',
                    types: [{
                        description: 'JSON Files',
                        accept: { 'application/json': ['.json'] },
                    }],
                });
                this.isLoading = true;
                await this.syncToFile();
                this.isLoading = false;
            } catch (err) {
                console.error('Sync file selection cancelled or failed:', err);
                this.isLoading = false;
            }
        },

        async syncToFile() {
            if (!this.fileHandle) return;
            
            // Note: Not setting isLoading = true here anymore as it's called from watcher frequently
            try {
                const writable = await this.fileHandle.createWritable();
                await writable.write(JSON.stringify(this.budgets, null, 2));
                await writable.close();
                // Removed 800ms artificial delay
            } catch (err) {
                console.error('Sync failed:', err);
                if (err.name === 'NotAllowedError') {
                    this.fileHandle = null;
                    alert('Permission to write to the sync file was denied.');
                }
            }
        },

        printReport() {
            window.print();
        },

        // Helper to get all transactions
        getAllTransactions() {
            let txs = [];
            this.budgets.forEach(b => {
                b.subBudgets.forEach(s => {
                    s.transactions.forEach(t => {
                        txs.push({ 
                            ...t, 
                            budgetId: b.id, 
                            budgetName: b.name, 
                            subBudgetId: s.id, 
                            subBudgetName: s.name 
                        });
                    });
                });
            });
            return txs.sort((a, b) => b.date.localeCompare(a.date));
        },

        refreshBanks() {
            const txs = this.getAllTransactions();
            const bankSet = new Set(txs.map(t => t.bank));
            bankSet.add('Transfers');
            // keep as simple list; presentation sorting handled by sortedBanks()
            this.banks = Array.from(bankSet).filter(b => b);
        },

        refreshSelections() {
            if (this.selectedBudget) {
                this.selectedBudget = this.budgets.find(b => b.id === this.selectedBudget.id) || null;
            }
            if (this.selectedSubBudget) {
                this.selectedSubBudget = this.getSubBudgetById(this.selectedSubBudget.id);
            }
            if (this.paycheckSelectedBudget) {
                this.paycheckSelectedBudget = this.budgets.find(b => b.id === this.paycheckSelectedBudget.id) || null;
            }
            if (this.paycheckSelectedSubBudget) {
                this.paycheckSelectedSubBudget = this.getSubBudgetById(this.paycheckSelectedSubBudget.id);
            }
        },

        flashElement(id) {
            this.flashingId = id;
            setTimeout(() => {
                if (this.flashingId === id) this.flashingId = null;
            }, 2000);
        },

        // Sorting helpers
        compareNames(a, b) {
            return a.localeCompare ? a.localeCompare(b) : (a.name || '').localeCompare(b.name || '');
        },

        sortedBudgets(planned = false) {
            const arr = this.budgets.slice();
            return arr.sort((a, b) => {
                if (this.sortByAmount) {
                    const diff = Math.abs(this.getBudgetTotal(b, planned)) - Math.abs(this.getBudgetTotal(a, planned));
                    if (diff !== 0) return diff;
                }
                return (a.name || '').localeCompare(b.name || '');
            });
        },

        sortedSubBudgets(budget, planned = false) {
            const arr = (budget?.subBudgets || []).slice();
            return arr.sort((a, b) => {
                if (this.sortByAmount) {
                    const diff = Math.abs(this.getSubBudgetTotal(b, planned)) - Math.abs(this.getSubBudgetTotal(a, planned));
                    if (diff !== 0) return diff;
                }
                return (a.name || '').localeCompare(b.name || '');
            });
        },

        chunkForColumns(arr, numCols) {
            const total = arr.length;
            const res = [];
            const minItemsPerCol = Math.floor(total / numCols);
            const extraItems = total % numCols;
            
            let current = 0;
            for (let i = 0; i < numCols; i++) {
                const count = minItemsPerCol + (i < extraItems ? 1 : 0);
                res.push(arr.slice(current, current + count));
                current += count;
            }
            return res;
        },

        sortedTransactions(subBudget) {
            const q = (this.subBudgetSearchQuery || '').toLowerCase();
            return (subBudget?.transactions || [])
                .filter(t => !t.planned)
                .filter(t => {
                    if (!q) return true;
                    return (t.bank || '').toLowerCase().includes(q) || 
                           (t.note || '').toLowerCase().includes(q) || 
                           (t.tags || []).some(tag => tag.toLowerCase().includes(q)) ||
                           (t.date || '').includes(q) || 
                           (t.amount || '').toString().includes(q);
                })
                .slice()
                .sort((a, b) => b.date.localeCompare(a.date));
        },

        getFilteredTransactionsTotal(subBudget) {
            const txs = this.sortedTransactions(subBudget);
            const val = txs.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
            return Math.round(val * 100) / 100;
        },

        getBankBalance(bankName) {
            const val = this.getTransactionsForBank(bankName).reduce((s, t) => s + parseFloat(t.amount || 0), 0);
            return Math.round(val * 100) / 100;
        },

        sortedBanks() {
            const arr = this.banks.slice();
            return arr.sort((a, b) => {
                if (this.sortByAmount) {
                    const diff = Math.abs(this.getBankBalance(b)) - Math.abs(this.getBankBalance(a));
                    if (diff !== 0) return diff;
                }
                return (a || '').localeCompare(b || '');
            });
        },

        // Totals
        getSubBudgetTotal(subBudget, planned = false) {
            const val = subBudget.transactions
                .filter(t => !!t.planned === planned)
                .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
            return Math.round(val * 100) / 100;
        },

        getBudgetTotal(budget, planned = false) {
            const val = budget.subBudgets.reduce((sum, s) => sum + this.getSubBudgetTotal(s, planned), 0);
            return Math.round(val * 100) / 100;
        },

        getDisplayedBudgetTotal(budget) {
            if (this.displayedBalances[budget.id] !== undefined) {
                return this.displayedBalances[budget.id];
            }
            return this.getBudgetTotal(budget);
        },

        getTotalBankBalance() {
            return this.banks.reduce((sum, bank) => sum + this.getBankBalance(bank), 0);
        },

        getTotalBudgetBalance() {
            return this.budgets
                .filter(b => b.name !== 'Unlinked')
                .reduce((sum, budget) => sum + this.getDisplayedBudgetTotal(budget), 0);
        },

        // Report Logic
        getReportData() {
            const year = parseInt(this.reportYear) || new Date().getFullYear();
            const start = this.reportStartDate;
            const end = this.reportEndDate;
            const yearStart = `${year}-01-01`;

            let beginningYearBalance = 0;
            let totalYearIncome = 0;
            let budgetExpenses = []; 
            let finalOverallBalance = 0;
            let periodBudgets = [];

            for (const budget of this.budgets) {
                if (budget.name === 'Unlinked') continue;
                
                let budgetYearExp = 0;
                let budgetStartBalance = 0;
                let budgetEndBalance = 0;
                let budgetPeriodTxs = [];
                let subBudgetTotals = [];

                for (const sub of budget.subBudgets) {
                    let subEndBalance = 0;
                    for (const tx of sub.transactions) {
                        if (tx.planned) continue;
                        const amt = parseFloat(tx.amount || 0);
                        
                        if (tx.date <= end) {
                            subEndBalance += amt;
                        }

                        if (tx.date < yearStart) {
                            beginningYearBalance += amt;
                        }
                        
                        if (tx.date >= yearStart && tx.date <= end) {
                            if (amt > 0) {
                                totalYearIncome += amt;
                            } else {
                                budgetYearExp += Math.abs(amt);
                            }
                        }

                        if (tx.date < start) {
                            budgetStartBalance += amt;
                        }
                        
                        if (tx.date >= start && tx.date <= end) {
                            budgetPeriodTxs.push({
                                ...tx,
                                subBudget: sub.name,
                                subBudgetId: sub.id,
                                budgetId: budget.id
                            });
                        }
                        
                        if (tx.date <= end) {
                            budgetEndBalance += amt;
                            finalOverallBalance += amt;
                        }
                    }
                    subBudgetTotals.push({
                        name: sub.name,
                        endBalance: subEndBalance
                    });
                }
                
                budgetExpenses.push({ name: budget.name, amount: budgetYearExp });
                
                periodBudgets.push({
                    id: budget.id,
                    name: budget.name,
                    startBalance: budgetStartBalance,
                    endBalance: budgetEndBalance,
                    subBudgetTotals: subBudgetTotals,
                    transactions: budgetPeriodTxs.sort((a, b) => a.date.localeCompare(b.date))
                });
            }
            
            let unreconciledByBank = {};
            let totalUnreconciled = 0;
            let currentBankBalance = this.getTotalBankBalance();
            
            for (const budget of this.budgets) {
                for (const sub of budget.subBudgets) {
                    for (const tx of sub.transactions) {
                        if (tx.planned) continue;
                        if (!tx.reconciled) {
                            const bank = (tx.bank || '').trim();
                            if (!bank) continue; // consider no bank transactions to be reconciled

                            if (!unreconciledByBank[bank]) unreconciledByBank[bank] = [];
                            unreconciledByBank[bank].push({
                                ...tx,
                                subBudget: sub.name,
                                subBudgetId: sub.id,
                                budgetId: budget.id
                            });
                            totalUnreconciled += parseFloat(tx.amount || 0);
                        }
                    }
                }
            }
            
            const expectedBudgetTotal = currentBankBalance - totalUnreconciled;
            const actualBudgetTotal = this.budgets.reduce((sum, budget) => sum + this.getDisplayedBudgetTotal(budget), 0);
            const discrepancy = actualBudgetTotal - expectedBudgetTotal;

            return {
                year,
                start,
                end,
                beginningYearBalance,
                totalYearIncome,
                budgetExpenses,
                finalOverallBalance,
                periodBudgets,
                unreconciledByBank,
                totalUnreconciled,
                currentBankBalance,
                expectedBudgetTotal,
                actualBudgetTotal,
                discrepancy
            };
        },
        
        setReportDates(range) {
            const today = new Date();
            if (range === 'weekPlusLast') {
                // this week to date plus full last week
                // assuming week starts on Sunday
                const dayOfWeek = today.getDay(); 
                const start = new Date(today);
                start.setDate(today.getDate() - dayOfWeek - 7); // Go back to Sunday of last week
                this.reportStartDate = start.toISOString().split('T')[0];
                this.reportEndDate = today.toISOString().split('T')[0];
            } else if (range === 'monthToDate') {
                const start = new Date(today.getFullYear(), today.getMonth(), 1);
                this.reportStartDate = start.toISOString().split('T')[0];
                this.reportEndDate = today.toISOString().split('T')[0];
            } else if (range === 'lastMonth') {
                const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                const end = new Date(today.getFullYear(), today.getMonth(), 0);
                this.reportStartDate = start.toISOString().split('T')[0];
                this.reportEndDate = end.toISOString().split('T')[0];
            } else if (range === 'thisYear') {
                const start = new Date(today.getFullYear(), 0, 1);
                this.reportStartDate = start.toISOString().split('T')[0];
                this.reportEndDate = today.toISOString().split('T')[0];
                this.reportYear = today.getFullYear().toString();
            }
        },

        // CRUD Budgets
        async createBudget(name) {
            this.isLoading = true;
            await new Promise(resolve => setTimeout(resolve, 600));
            const id = crypto.randomUUID();
            const budget = {
                id,
                name,
                subBudgets: [
                    { id: crypto.randomUUID(), name: 'General', transactions: [] }
                ]
            };
            this.budgets = [...this.budgets, budget];
            this.isLoading = false;
            this.modalOpen = false;
        },

        async updateBudget(id, name) {
            this.isLoading = true;
            await new Promise(resolve => setTimeout(resolve, 600));
            this.budgets = this.budgets.map(b => b.id === id ? { ...b, name } : b);
            this.isLoading = false;
            this.modalOpen = false;
        },

        mergeBudgets(sourceId, targetId) {
            if (!sourceId || !targetId || sourceId === targetId) return;
            const source = this.budgets.find(b => b.id === sourceId);
            const target = this.budgets.find(b => b.id === targetId);
            
            if (source && target) {
                if (!this.deleteMode && !confirm(`Merge budget "${source.name}" into "${target.name}"? This will move all sub-budgets and transactions.`)) return;
                
                const newBudgets = this.budgets.filter(b => b.id !== sourceId).map(b => {
                    if (b.id === targetId) {
                        const newTarget = { ...b, subBudgets: [...b.subBudgets] };
                        source.subBudgets.forEach(sourceSub => {
                            const targetSubIdx = newTarget.subBudgets.findIndex(s => s.name === sourceSub.name);
                            if (targetSubIdx !== -1) {
                                newTarget.subBudgets[targetSubIdx] = {
                                    ...newTarget.subBudgets[targetSubIdx],
                                    transactions: [...newTarget.subBudgets[targetSubIdx].transactions, ...sourceSub.transactions]
                                };
                            } else {
                                newTarget.subBudgets.push(sourceSub);
                            }
                        });
                        return newTarget;
                    }
                    return b;
                });

                this.budgets = newBudgets;
                this.modalOpen = false;
                this.goHome();
            }
        },

        deleteBudget(id) {
            this.confirmDelete('budget', id);
        },

        // CRUD SubBudgets
        async createSubBudget(budgetId, name) {
            this.isLoading = true;
            await new Promise(resolve => setTimeout(resolve, 600));
            this.budgets = this.budgets.map(b => {
                if (b.id === budgetId) {
                    return { ...b, subBudgets: [...b.subBudgets, { id: crypto.randomUUID(), name, transactions: [] }] };
                }
                return b;
            });
            this.isLoading = false;
            this.modalOpen = false;
        },

        async updateSubBudget(budgetId, subBudgetId, name) {
            this.isLoading = true;
            await new Promise(resolve => setTimeout(resolve, 600));
            this.budgets = this.budgets.map(b => {
                if (b.id === budgetId) {
                    return {
                        ...b,
                        subBudgets: b.subBudgets.map(s => s.id === subBudgetId ? { ...s, name } : s)
                    };
                }
                return b;
            });
            this.isLoading = false;
            this.modalOpen = false;

            // Update selection if it was the edited sub-budget
            if (this.selectedSubBudget && this.selectedSubBudget.id === subBudgetId) {
                this.selectedSubBudget = this.getSubBudgetById(subBudgetId);
            }
        },

        async moveSubBudget(sourceBudgetId, subBudgetId, targetBudgetId, newName) {
            if (!sourceBudgetId || !targetBudgetId || !subBudgetId) return;
            if (sourceBudgetId === targetBudgetId) {
                return this.updateSubBudget(sourceBudgetId, subBudgetId, newName);
            }

            this.isLoading = true;
            await new Promise(resolve => setTimeout(resolve, 600));

            const sourceB = this.budgets.find(b => b.id === sourceBudgetId);
            const targetB = this.budgets.find(b => b.id === targetBudgetId);

            if (sourceB && targetB) {
                const subBudget = sourceB.subBudgets.find(s => s.id === subBudgetId);
                if (subBudget) {
                    subBudget.name = newName;
                    
                    this.budgets = this.budgets.map(b => {
                        if (b.id === sourceBudgetId) {
                            return { ...b, subBudgets: b.subBudgets.filter(s => s.id !== subBudgetId) };
                        }
                        if (b.id === targetBudgetId) {
                            return { ...b, subBudgets: [...b.subBudgets, subBudget] };
                        }
                        return b;
                    });

                    // Update selection
                    if (this.selectedSubBudget && this.selectedSubBudget.id === subBudgetId) {
                        this.selectedSubBudget = subBudget;
                        this.selectedBudget = targetB;
                    }
                }
            }

            this.isLoading = false;
            this.modalOpen = false;
        },

        mergeSubBudgets(sourceBudgetId, sourceSubId, targetSubId, targetBudgetId) {
            if (!sourceSubId || !targetSubId || sourceSubId === targetSubId) return;
            const sourceB = this.budgets.find(b => b.id === sourceBudgetId);
            const targetB = targetBudgetId ? this.budgets.find(b => b.id === targetBudgetId) : sourceB;
            
            if (sourceB && targetB) {
                const source = sourceB.subBudgets.find(s => s.id === sourceSubId);
                const target = targetB.subBudgets.find(s => s.id === targetSubId);
                
                if (source && target) {
                    if (!this.deleteMode && !confirm(`Merge sub-budget "${source.name}" into "${target.name}"? This will move all transactions.`)) return;
                    
                    this.budgets = this.budgets.map(b => {
                        if (b.id === sourceBudgetId || b.id === targetBudgetId) {
                            let newB = { ...b, subBudgets: [...b.subBudgets] };
                            if (b.id === sourceBudgetId) {
                                newB.subBudgets = newB.subBudgets.filter(s => s.id !== sourceSubId);
                            }
                            if (b.id === targetBudgetId) {
                                // If target already exists in newB (could be same budget as source)
                                const tIdx = newB.subBudgets.findIndex(s => s.id === targetSubId);
                                if (tIdx !== -1) {
                                    newB.subBudgets[tIdx] = {
                                        ...newB.subBudgets[tIdx],
                                        transactions: [...newB.subBudgets[tIdx].transactions, ...source.transactions]
                                    };
                                } else {
                                    // This case shouldn't happen if targetB was found correctly above
                                    newB.subBudgets.push({ ...source, id: targetSubId });
                                }
                            }
                            return newB;
                        }
                        return b;
                    });

                    this.modalOpen = false;
                    // Note: selectSubBudget might need a fresh reference
                    this.selectedSubBudget = this.getSubBudgetById(targetSubId);
                    if (targetBudgetId) this.selectedBudget = this.budgets.find(b => b.id === targetBudgetId);
                }
            }
        },

        deleteSubBudget(budgetId, subBudgetId) {
            this.confirmDelete('subBudget', budgetId, subBudgetId);
        },

        // CRUD Transactions
        addTransaction(subBudget, data = {}) {
            const defaultData = { 
                date: new Date().toISOString().split('T')[0], 
                bank: '', 
                amount: 0, 
                note: '', 
                tags: [],
                planned: false, 
                recurring: false 
            };
            const mergedData = { ...defaultData, ...data };
            const newTx = {
                id: crypto.randomUUID(),
                ...mergedData
            };
            
            // We need to trigger the watcher by reassigning budgets
            const updateBudgets = () => {
                this.budgets = JSON.parse(JSON.stringify(this.budgets));
            };

            if (mergedData.planned) {
                this.isLoading = true;
                setTimeout(() => {
                    subBudget.transactions.push(newTx);
                    updateBudgets();
                    this.isLoading = false;
                }, 400);
            } else {
                subBudget.transactions.push(newTx);
                updateBudgets();
                this.openModal('editTransaction', newTx);
            }
        },

        async updateTransaction(txId, data) {
            console.log('Updating transaction:', txId, data);
            this.isLoading = true;
            try {
                // Reduced delay for better responsiveness
                await new Promise(resolve => setTimeout(resolve, 300));

                // Find current transaction and its parent sub-budget
                let currentTx = null;
                let currentSubBudget = null;

                for (const b of this.budgets) {
                    for (const s of b.subBudgets) {
                        const tx = s.transactions.find(t => t.id === txId);
                        if (tx) {
                            currentTx = tx;
                            currentSubBudget = s;
                            break;
                        }
                    }
                    if (currentTx) break;
                }

                if (!currentTx || !currentSubBudget) {
                    console.warn('Transaction or sub-budget not found for update:', txId);
                    this.modalOpen = false;
                    return;
                }

                // Determine target sub-budget
                let targetSubBudget = null;
                if (data.budgetId && data.subBudgetId) {
                    const b = this.budgets.find(b => b.id === data.budgetId);
                    if (b) {
                        targetSubBudget = b.subBudgets.find(s => s.id === data.subBudgetId);
                    }
                } else if (!data.planned) {
                    // If unlinked, use Unlinked budget
                    let unlinkedBudget = this.budgets.find(b => b.name === 'Unlinked');
                    if (!unlinkedBudget) {
                        unlinkedBudget = { id: crypto.randomUUID(), name: 'Unlinked', subBudgets: [] };
                        this.budgets.push(unlinkedBudget);
                    }
                    targetSubBudget = unlinkedBudget.subBudgets.find(s => s.name === 'General');
                    if (!targetSubBudget) {
                        targetSubBudget = { id: crypto.randomUUID(), name: 'General', transactions: [] };
                        unlinkedBudget.subBudgets.push(targetSubBudget);
                    }
                }

                // If target sub-budget changed, move the transaction
                const updatedTxFields = {
                    date: data.date,
                    bank: data.bank,
                    amount: parseFloat(data.amount || 0),
                    note: data.note,
                    tags: data.tags ? [...data.tags] : [],
                    reconciled: data.reconciled,
                    planned: !!data.planned,
                    recurring: !!data.recurring
                };

                if (targetSubBudget && targetSubBudget.id !== currentSubBudget.id) {
                    console.log('Moving transaction to target sub-budget:', targetSubBudget.id);
                    currentSubBudget.transactions = currentSubBudget.transactions.filter(t => t.id !== txId);
                    targetSubBudget.transactions.push({ ...currentTx, ...updatedTxFields });
                } else {
                    // Otherwise update in place
                    const txIdx = currentSubBudget.transactions.findIndex(t => t.id === txId);
                    if (txIdx !== -1) {
                        currentSubBudget.transactions[txIdx] = { ...currentSubBudget.transactions[txIdx], ...updatedTxFields };
                    }
                }

                // Trigger the watcher by reassigning budgets
                console.log('Triggering budget reassignment');
                this.budgets = JSON.parse(JSON.stringify(this.budgets));
                this.modalOpen = false;
                console.log('Transaction updated successfully');
            } catch (err) {
                console.error('Error updating transaction:', err);
            } finally {
                this.isLoading = false;
            }
        },

        deleteTransaction(txId) {
            this.confirmDelete('transaction', txId);
        },

        // Transfer
        async transfer(fromSubBudgetId, toSubBudgetId, amount, date) {
            this.isLoading = true;
            try {
                await new Promise(resolve => setTimeout(resolve, 800));
                let fromSub, toSub, fromBudget, toBudget;
                
                const actualFromId = fromSubBudgetId && fromSubBudgetId.includes('|') ? fromSubBudgetId.split('|')[1] : fromSubBudgetId;
                const actualToId = toSubBudgetId && toSubBudgetId.includes('|') ? toSubBudgetId.split('|')[1] : toSubBudgetId;

                this.budgets.forEach(b => {
                    b.subBudgets.forEach(s => {
                        if (s.id === actualFromId) { fromSub = s; fromBudget = b; }
                        if (s.id === actualToId) { toSub = s; toBudget = b; }
                    });
                });

                if (!fromSub || !toSub) {
                    return;
                }

                const amountVal = parseFloat(amount);
                const note = `Transfer of ${amountVal} from ${fromBudget.name}:${fromSub.name} to ${toBudget.name}:${toSub.name}`;

                // Add to source
                fromSub.transactions.push({
                    id: crypto.randomUUID(),
                    date,
                    bank: 'Transfers',
                    amount: -amountVal,
                    note: note,
                    reconciled: null,
                    planned: false
                });

                // Add to dest
                toSub.transactions.push({
                    id: crypto.randomUUID(),
                    date,
                    bank: 'Transfers',
                    amount: amountVal,
                    note: note,
                    reconciled: null,
                    planned: false
                });

                this.budgets = JSON.parse(JSON.stringify(this.budgets));
                this.modalOpen = false;
            } finally {
                this.isLoading = false;
            }
        },

        // Banking
        getTransactionsForBank(bankName, unreconciledOnly = false) {
            let txs = this.getAllTransactions().filter(t => (t.bank || '').trim() === (bankName || '').trim() && !t.planned);
            if (unreconciledOnly) {
                txs = txs.filter(t => !t.reconciled);
            }

            // Text search
            const q = (this.bankingSearchQuery || '').toLowerCase().trim();
            if (q) {
                txs = txs.filter(t => 
                    (t.note || '').toLowerCase().includes(q) || 
                    (t.date || '').toLowerCase().includes(q) ||
                    (t.budgetName || '').toLowerCase().includes(q) ||
                    (t.subBudgetName || '').toLowerCase().includes(q) ||
                    (t.bank || '').toLowerCase().includes(q) ||
                    (t.tags || []).some(tag => tag.toLowerCase().includes(q))
                );
            }

            // Tag/Budget/Bank filtering
            if (this.bankingSelectedTags.length > 0) {
                txs = txs.filter(t => 
                    this.bankingSelectedTags.every(filter => 
                        (t.tags || []).includes(filter) ||
                        (t.budgetName || '') === filter ||
                        (t.subBudgetName || '') === filter ||
                        (t.bank || '') === filter
                    )
                );
            }

            return txs.sort((a, b) => b.date.localeCompare(a.date));
        },

        reconcile(txIds) {
            const today = new Date().toISOString().split('T')[0];
            this.budgets = this.budgets.map(b => ({
                ...b,
                subBudgets: b.subBudgets.map(s => ({
                    ...s,
                    transactions: s.transactions.map(t => {
                        if (txIds.includes(t.id)) {
                            return { ...t, reconciled: today };
                        }
                        return t;
                    })
                }))
            }));
        },

        mergeBanks(sourceBank, targetBank) {
            if (!sourceBank || !targetBank || (sourceBank || '').trim() === (targetBank || '').trim()) return;
            if (!this.deleteMode && !confirm(`Merge all transactions from "${sourceBank}" into "${targetBank}"?`)) return;

            this.budgets = this.budgets.map(b => ({
                ...b,
                subBudgets: b.subBudgets.map(s => ({
                    ...s,
                    transactions: s.transactions.map(t => {
                        if ((t.bank || '').trim() === (sourceBank || '').trim()) {
                            return { ...t, bank: targetBank };
                        }
                        return t;
                    })
                }))
            }));
            this.refreshBanks();
        },

        getBankReconciledTotal(bankName) {
            return this.getAllTransactions()
                .filter(t => (t.bank || '').trim() === (bankName || '').trim() && !t.planned && t.reconciled)
                .reduce((s, t) => s + parseFloat(t.amount || 0), 0);
        },

        getBankPreviewTotal(bankName, checkedIds) {
            const reconciled = this.getBankReconciledTotal(bankName);
            const pending = this.getAllTransactions()
                .filter(t => checkedIds.includes(t.id))
                .reduce((s, t) => s + parseFloat(t.amount || 0), 0);
            return reconciled + pending;
        },

        async addBankTransaction(budgetId, subBudgetId, data) {
            console.log('Adding bank transaction:', budgetId, subBudgetId, data);
            this.isLoading = true;
            try {
                // Reduced delay
                await new Promise(resolve => setTimeout(resolve, 300));

                let targetSubBudget = null;

                if (budgetId && subBudgetId) {
                    const b = this.budgets.find(b => b.id === budgetId);
                    if (b) {
                        targetSubBudget = b.subBudgets.find(s => s.id === subBudgetId);
                    }
                }

                if (!targetSubBudget) {
                    console.log('No target sub-budget selected, using Unlinked');
                    // If no budget/sub-budget selected, use "Unlinked"
                    let unlinkedBudget = this.budgets.find(b => b.name === 'Unlinked');
                    if (!unlinkedBudget) {
                        unlinkedBudget = {
                            id: crypto.randomUUID(),
                            name: 'Unlinked',
                            subBudgets: []
                        };
                        this.budgets.push(unlinkedBudget);
                    }
                    
                    targetSubBudget = unlinkedBudget.subBudgets.find(s => s.name === 'General');
                    if (!targetSubBudget) {
                        targetSubBudget = {
                            id: crypto.randomUUID(),
                            name: 'General',
                            transactions: []
                        };
                        unlinkedBudget.subBudgets.push(targetSubBudget);
                    }
                }

                targetSubBudget.transactions.push({
                    id: crypto.randomUUID(),
                    date: data.date,
                    bank: data.bank,
                    amount: parseFloat(data.amount || 0),
                    note: data.note,
                    tags: data.tags ? [...data.tags] : [],
                    reconciled: null,
                    planned: false
                });

                // Trigger the watcher by reassigning budgets
                console.log('Triggering budget reassignment (addBankTransaction)');
                this.budgets = JSON.parse(JSON.stringify(this.budgets));
                this.modalOpen = false;
                console.log('Bank transaction added successfully');
            } catch (err) {
                console.error('Error adding bank transaction:', err);
            } finally {
                this.isLoading = false;
            }
        },

        // Paycheck
        getNextPaycheckId() {
            let maxId = 0;
            this.budgets.forEach(b => {
                b.subBudgets.forEach(s => {
                    s.transactions.forEach(t => {
                        const match = t.note && t.note.match(/PYCH(\d{4})/);
                        if (match) {
                            const id = parseInt(match[1]);
                            if (id > maxId) maxId = id;
                        }
                    });
                });
            });
            return 'PYCH' + (maxId + 1).toString().padStart(4, '0');
        },

        async depositPaycheck(paycheckAmount) {
            this.isLoading = true;
            try {
                const pychId = this.getNextPaycheckId();
                
                // Capture previous balances for animation
                const prevBalances = {};
                this.budgets.forEach(b => {
                    prevBalances[b.id] = this.getBudgetTotal(b);
                });

                // Artificial delay to show the loader
                await new Promise(resolve => setTimeout(resolve, 500));

                // Get all planned transactions and keep track of which budgets they belong to
                const planned = [];
                const fundedBudgetIds = new Set();

                this.budgets.forEach(b => {
                    b.subBudgets.forEach(s => {
                        s.transactions.forEach(t => {
                            if (t.planned) {
                                planned.push({ ...t, subBudget: s, budgetId: b.id });
                                fundedBudgetIds.add(b.id);
                            }
                        });
                    });
                });

                // 1. Deposit one single bank transaction for the entire amount in the "Unlinked" budget
                const bankName = this.paycheckBank || 'Internal';
                let unlinkedBudget = this.budgets.find(b => b.name === 'Unlinked');
                if (!unlinkedBudget) {
                    unlinkedBudget = {
                        id: crypto.randomUUID(),
                        name: 'Unlinked',
                        subBudgets: []
                    };
                    this.budgets.push(unlinkedBudget);
                }
                fundedBudgetIds.add(unlinkedBudget.id);

                let unlinkedSubBudget = unlinkedBudget.subBudgets.find(s => s.name === 'General');
                if (!unlinkedSubBudget) {
                    unlinkedSubBudget = {
                        id: crypto.randomUUID(),
                        name: 'General',
                        transactions: []
                    };
                    unlinkedBudget.subBudgets.push(unlinkedSubBudget);
                }

                unlinkedSubBudget.transactions.push({
                    id: crypto.randomUUID(),
                    date: this.paycheckDate || new Date().toISOString().split('T')[0],
                    bank: bankName,
                    amount: parseFloat(paycheckAmount || 0),
                    note: `Paycheck Deposit (${pychId})`,
                    tags: [pychId],
                    reconciled: null,
                    planned: false
                });

                // 2. Deposit the budget transactions without linking them to that bank
                planned.forEach(pt => {
                    // Create real transaction
                    const tagsWithPych = pt.tags ? [...pt.tags, pychId] : [pychId];

                    pt.subBudget.transactions.push({
                        id: crypto.randomUUID(),
                        date: this.paycheckDate || new Date().toISOString().split('T')[0],
                        bank: '', // Unlinked from bank
                        amount: pt.amount,
                        note: pt.note,
                        tags: tagsWithPych,
                        reconciled: null,
                        planned: false
                    });
                    // Remove planned if not recurring
                    if (!pt.recurring) {
                        const idx = pt.subBudget.transactions.findIndex(t => t.id === pt.id);
                        if (idx !== -1) pt.subBudget.transactions.splice(idx, 1);
                    }
                });
                
                this.budgets = JSON.parse(JSON.stringify(this.budgets));

                // Visual effects
                this.triggerConfetti();
                
                // If we are on the paycheck page, we need to go home to see the budget cards animation
                const wasInPaycheck = this.currentPage === 'paycheck';
                if (wasInPaycheck) {
                    this.goHome();
                    // Wait for the DOM to update so budget cards are visible
                    await this.$nextTick();
                }

                fundedBudgetIds.forEach(budgetId => {
                    this.animateCoins(budgetId);
                    
                    // Animate balance scrolling
                    const startBalance = prevBalances[budgetId] || 0;
                    const targetBudget = this.budgets.find(b => b.id === budgetId);
                    const endBalance = targetBudget ? this.getBudgetTotal(targetBudget) : startBalance;
                    
                    if (startBalance !== endBalance) {
                        this.animateBalance(budgetId, startBalance, endBalance);
                    }
                });
            } finally {
                this.isLoading = false;
            }
        },

        animateBalance(budgetId, start, end) {
            const duration = 2000; // 2 seconds
            const startTime = performance.now();
            
            const step = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // Easing function: easeOutExpo (starts fast, slows down significantly)
                const easeOutExpo = (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
                const currentProgress = easeOutExpo(progress);
                
                const currentBalance = start + (end - start) * currentProgress;
                this.displayedBalances[budgetId] = Math.round(currentBalance * 100) / 100;
                
                if (progress < 1) {
                    requestAnimationFrame(step);
                } else {
                    delete this.displayedBalances[budgetId];
                }
            };
            
            requestAnimationFrame(step);
        },

        // Search
        getfilteredResults() {
            if (!this.searchQuery) return [];
            const q = this.searchQuery.toLowerCase();
            const results = [];

            // Search budgets
            this.budgets.forEach(b => {
                if (b.name.toLowerCase().includes(q)) {
                    results.push({ type: 'Budget', name: b.name, budget: b });
                }
                b.subBudgets.forEach(s => {
                    if (s.name.toLowerCase().includes(q)) {
                        results.push({ type: 'Sub-Budget', name: s.name, budget: b, subBudget: s });
                    }
                    s.transactions.forEach(t => {
                        if (t.bank.toLowerCase().includes(q) || t.note.toLowerCase().includes(q) || 
                            (t.tags || []).some(tag => tag.toLowerCase().includes(q)) ||
                            t.date.includes(q) || t.amount.toString().includes(q)) {
                            results.push({ type: 'Transaction', name: t.note || t.bank, transaction: t, budget: b, subBudget: s });
                        }
                    });
                });
            });
            return results.sort((a, b) => {
                if (a.type === 'Transaction' && b.type === 'Transaction') {
                    return b.transaction.date.localeCompare(a.transaction.date);
                }
                return 0;
            });
        },

        getSubBudgetById(id) {
            if (!id) return null;
            // Handle composite ID "budgetId|subBudgetId" if present
            const subId = id.includes('|') ? id.split('|')[1] : id;
            for (const b of this.budgets) {
                const s = b.subBudgets.find(sb => sb.id === subId);
                if (s) return s;
            }
            return null;
        },

        // UI Helpers
        triggerConfetti() {
            const count = 200;
            const defaults = {
                origin: { y: 0.7 },
                zIndex: 10000
            };

            function fire(particleRatio, opts) {
                confetti({
                    ...defaults,
                    ...opts,
                    particleCount: Math.floor(count * particleRatio)
                });
            }

            fire(0.25, {
                spread: 26,
                startVelocity: 55,
            });
            fire(0.2, {
                spread: 60,
            });
            fire(0.35, {
                spread: 100,
                decay: 0.91,
                scalar: 0.8
            });
            fire(0.1, {
                spread: 120,
                startVelocity: 25,
                decay: 0.92,
                scalar: 1.2
            });
            fire(0.1, {
                spread: 120,
                startVelocity: 45,
            });
        },

        animateCoins(targetBudgetId) {
            const button = document.getElementById('deposit-button');
            const target = document.getElementById('budget-' + targetBudgetId);
            if (!button || !target) return;

            const buttonRect = button.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();

            const startX = buttonRect.left + buttonRect.width / 2;
            const startY = buttonRect.top + buttonRect.height / 2;
            const endX = targetRect.left + targetRect.width / 2;
            const endY = targetRect.top + targetRect.height / 2;

            for (let i = 0; i < 5; i++) {
                setTimeout(() => {
                    const coin = document.createElement('div');
                    coin.className = 'coin';
                    coin.innerText = '$';
                    coin.style.left = startX + 'px';
                    coin.style.top = startY + 'px';
                    
                    const dx = endX - startX;
                    const dy = endY - startY;
                    
                    coin.style.setProperty('--dx', `${dx}px`);
                    coin.style.setProperty('--dy', `${dy}px`);
                    coin.style.animation = `coin-fly ${0.6 + Math.random() * 0.4}s ease-in forwards`;
                    
                    document.body.appendChild(coin);
                    setTimeout(() => coin.remove(), 1000);
                }, i * 100);
            }
        },

        openModal(type, data = {}) {
            this.modalType = type;
            // Clean data to avoid circular references and extra props from scan page
            const cleanData = { ...data };
            if (cleanData.budget) delete cleanData.budget;
            if (cleanData.subBudget) delete cleanData.subBudget;
            
            this.modalData = cleanData;
            this.currentTagInput = '';

            if (type === 'editTransaction' || type === 'bankAddTransaction') {
                if (!this.modalData.tags) this.modalData.tags = [];
            }

            if (type === 'editTransaction' && data.id) {
                // Find parent budget and sub-budget
                let found = false;
                this.budgets.forEach(b => {
                    b.subBudgets.forEach(s => {
                        if (s.transactions.some(t => t.id === data.id)) {
                            found = true;
                            if (b.name === 'Unlinked') {
                                this.modalData.budgetId = null;
                                this.modalData.subBudgetId = null;
                                this.modalData.targetId = "";
                            } else {
                                this.modalData.budgetId = b.id;
                                this.modalData.subBudgetId = s.id;
                                this.modalData.targetId = `${b.id}|${s.id}`;
                            }
                        }
                    });
                });

                // If not found in any budget yet (newly added from home subbudget page)
                // but we have hints in the data
                if (!found && data.budgetId && data.subBudgetId) {
                    this.modalData.budgetId = data.budgetId;
                    this.modalData.subBudgetId = data.subBudgetId;
                    this.modalData.targetId = `${data.budgetId}|${data.subBudgetId}`;
                }
            } else if (type === 'bankAddTransaction') {
                if (this.modalData.budgetId && this.modalData.subBudgetId) {
                    this.modalData.targetId = `${this.modalData.budgetId}|${this.modalData.subBudgetId}`;
                } else {
                    this.modalData.targetId = "";
                }
            }

            if (type === 'transfer' && !this.modalData.date) {
                this.modalData.date = new Date().toISOString().split('T')[0];
            }
            this.modalOpen = true;
        },

        // Scan Page Methods
        getAllTransactionsForScan() {
            const txs = [];
            this.budgets.forEach(b => {
                b.subBudgets.forEach(s => {
                    s.transactions.forEach(t => {
                        if (!t.planned) {
                            txs.push({ ...t, budget: b, subBudget: s });
                        }
                    });
                });
            });
            return txs;
        },

        getFilteredScanTransactions() {
            const q = this.scanSearchQuery.toLowerCase().trim();
            const selectedTags = this.scanSelectedTags.map(t => t.toLowerCase());
            
            return this.getAllTransactionsForScan().filter(t => {
                const matchesSearch = !q || 
                    (t.date && t.date.toLowerCase().includes(q)) ||
                    (t.amount && t.amount.toString().includes(q)) ||
                    (t.note && t.note.toLowerCase().includes(q)) ||
                    (t.bank && t.bank.toLowerCase().includes(q)) ||
                    (t.budget && t.budget.name.toLowerCase().includes(q)) ||
                    (t.subBudget && t.subBudget.name.toLowerCase().includes(q)) ||
                    (t.tags && t.tags.some(tag => tag.toLowerCase().includes(q)));
                
                const matchesTags = selectedTags.length === 0 || 
                    selectedTags.every(st => (t.tags || []).some(tag => tag.toLowerCase() === st));
                
                return matchesSearch && matchesTags;
            }).sort((a, b) => b.date.localeCompare(a.date));
        },

        getScanSubtotal(type = 'all') {
            const filtered = this.getFilteredScanTransactions();
            const val = filtered.reduce((sum, t) => {
                const isBank = !!t.bank;
                if (type === 'all' || (type === 'bank' && isBank) || (type === 'budget' && !isBank)) {
                    return sum + parseFloat(t.amount || 0);
                }
                return sum;
            }, 0);
            return Math.round(val * 100) / 100;
        },

        getScanCheckedSubtotal(type = 'all') {
            const checkedIds = new Set(this.scanCheckedTransactions);
            const filtered = this.getFilteredScanTransactions();
            const val = filtered
                .filter(t => checkedIds.has(t.id))
                .reduce((sum, t) => {
                    const isBank = !!t.bank;
                    if (type === 'all' || (type === 'bank' && isBank) || (type === 'budget' && !isBank)) {
                        return sum + parseFloat(t.amount || 0);
                    }
                    return sum;
                }, 0);
            return Math.round(val * 100) / 100;
        },

        toggleAllScanTransactions() {
            const filtered = this.getFilteredScanTransactions();
            if (this.allScanTransactionsChecked) {
                this.scanCheckedTransactions = filtered.map(t => t.id);
            } else {
                this.scanCheckedTransactions = [];
            }
        },

        updateAllScanTransactionsChecked() {
            const filtered = this.getFilteredScanTransactions();
            if (filtered.length === 0) {
                this.allScanTransactionsChecked = false;
                return;
            }
            const checkedIds = new Set(this.scanCheckedTransactions);
            this.allScanTransactionsChecked = filtered.every(t => checkedIds.has(t.id));
        },

        toggleScanTransaction(id) {
            const index = this.scanCheckedTransactions.indexOf(id);
            if (index === -1) {
                this.scanCheckedTransactions.push(id);
            } else {
                this.scanCheckedTransactions.splice(index, 1);
            }
            this.updateAllScanTransactionsChecked();
        },

        addScanTransaction() {
            console.log('Adding scan transaction');
            const data = this.scanNewTransaction;
            if (!data.targetId || !data.bank || !data.amount) {
                alert('Please fill in bank, budget/sub-budget, and amount');
                return;
            }

            const [budgetId, subBudgetId] = data.targetId.split('|');
            const targetBudget = this.budgets.find(b => b.id === budgetId);
            const targetSubBudget = targetBudget?.subBudgets.find(s => s.id === subBudgetId);

            if (!targetSubBudget) {
                console.warn('Target sub-budget not found for scan transaction');
                return;
            }

            this.isLoading = true;
            setTimeout(() => {
                try {
                    targetSubBudget.transactions.push({
                        id: crypto.randomUUID(),
                        date: data.date,
                        bank: data.bank,
                        amount: parseFloat(data.amount || 0),
                        note: data.note,
                        tags: [...data.tags],
                        reconciled: null,
                        planned: false
                    });

                    // Reset form
                    this.scanNewTransaction = {
                        bank: '',
                        targetId: '',
                        date: new Date().toISOString().split('T')[0],
                        amount: '',
                        note: '',
                        tags: []
                    };
                    
                    console.log('Triggering budget reassignment (addScanTransaction)');
                    this.budgets = JSON.parse(JSON.stringify(this.budgets));
                    this.modalOpen = false;
                    console.log('Scan transaction added successfully');
                } catch (err) {
                    console.error('Error adding scan transaction:', err);
                } finally {
                    this.isLoading = false;
                }
            }, 300); // Reduced delay
        },

        deleteScanTransaction(id) {
            this.isLoading = true;
            setTimeout(() => {
                try {
                    this.budgets.forEach(b => {
                        b.subBudgets.forEach(s => {
                            const idx = s.transactions.findIndex(t => t.id === id);
                            if (idx !== -1) {
                                s.transactions.splice(idx, 1);
                            }
                        });
                    });
                    this.budgets = JSON.parse(JSON.stringify(this.budgets));
                    // Remove from checked if it was there
                    this.scanCheckedTransactions = this.scanCheckedTransactions.filter(cid => cid !== id);
                } finally {
                    this.isLoading = false;
                }
            }, 400);
        },

        // Tags logic
        getAllTags() {
            const tags = new Set();
            this.budgets.forEach(b => {
                b.subBudgets.forEach(s => {
                    s.transactions.forEach(t => {
                        if (t.tags) {
                            t.tags.forEach(tag => tags.add(tag));
                        }
                    });
                });
            });
            return Array.from(tags).sort();
        },

        getSuggestedTags() {
            const q = (this.modalData.note || '').trim().toLowerCase();
            if (!q) return [];
            const allTags = this.getAllTags();
            return allTags.filter(t => t.toLowerCase().includes(q) && !(this.modalData.tags || []).includes(t));
        },

        addTag(tag) {
            const t = tag || (this.modalData.note || '').trim();
            if (t && !(this.modalData.tags || []).includes(t)) {
                if (!this.modalData.tags) this.modalData.tags = [];
                this.modalData.tags.push(t);
            }
            this.modalData.note = '';
            this.showTagSuggestions = false;
        },

        removeTag(index) {
            this.modalData.tags.splice(index, 1);
        },

        getBankingSuggestedTags() {
            const q = (this.bankingTagInput || '').trim().toLowerCase();
            if (!q) return [];
            
            const suggestions = new Set();
            
            // Tags
            this.getAllTags().forEach(tag => suggestions.add(tag));
            
            // Budgets
            this.budgets.forEach(b => {
                suggestions.add(b.name);
                b.subBudgets.forEach(s => suggestions.add(s.name));
            });

            // Banks
            this.banks.forEach(bank => suggestions.add(bank));

            return Array.from(suggestions)
                .filter(t => t.toLowerCase().includes(q) && !(this.bankingSelectedTags || []).includes(t))
                .sort();
        },

        addBankingTag(tag) {
            const t = tag || (this.bankingTagInput || '').trim();
            if (t && !(this.bankingSelectedTags || []).includes(t)) {
                this.bankingSelectedTags.push(t);
            }
            this.bankingTagInput = '';
            this.showBankingTagSuggestions = false;
        },

        removeBankingTag(index) {
            this.bankingSelectedTags.splice(index, 1);
        },

        toggleBankingTag(tag) {
            const index = this.bankingSelectedTags.indexOf(tag);
            if (index === -1) {
                this.bankingSelectedTags.push(tag);
            } else {
                this.bankingSelectedTags.splice(index, 1);
            }
        },

        formatCurrency(val) {
            if (Object.is(val, -0) || (val < 0 && val > -0.005)) val = 0;
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);
        },

        // Navigation
        goHome() {
            this.currentPage = 'home';
            this.selectedBudget = null;
            this.selectedSubBudget = null;
            this.paycheckSelectedBudget = null;
            this.paycheckSelectedSubBudget = null;
            this.subBudgetSearchQuery = '';
            this.bankingSearchQuery = '';
            this.bankingSelectedTags = [];
            this.bankingTagInput = '';
        },
        
        selectBudget(budget) {
            this.selectedBudget = budget;
            this.selectedSubBudget = null;
            this.subBudgetSearchQuery = '';
        },

        selectSubBudget(sub) {
            this.selectedSubBudget = sub;
            this.subBudgetSearchQuery = '';
        },

        // Delete confirmation logic
        confirmDelete(type, id, subId = null) {
            if (this.deleteMode) {
                this.executeDelete(type, id, subId);
                return;
            }
            this.resetDelete();
            this.pendingDelete = { type, id, subId };
            this.deleteTimer = setTimeout(() => {
                this.resetDelete();
            }, 5000);
        },

        resetDelete() {
            if (this.deleteTimer) clearTimeout(this.deleteTimer);
            this.pendingDelete = { type: null, id: null, subId: null };
            this.deleteTimer = null;
        },

        executeDelete(type, id, subId = null) {
            if (type === 'budget') {
                this.budgets = this.budgets.filter(b => b.id !== id);
                if (this.selectedBudget && this.selectedBudget.id === id) this.selectedBudget = null;
            } else if (type === 'subBudget') {
                this.budgets = this.budgets.map(b => {
                    if (b.id === id) {
                        return { ...b, subBudgets: b.subBudgets.filter(s => s.id !== subId) };
                    }
                    return b;
                });
                if (this.selectedSubBudget && this.selectedSubBudget.id === subId) this.selectedSubBudget = null;
            } else if (type === 'transaction') {
                this.budgets = this.budgets.map(b => ({
                    ...b,
                    subBudgets: b.subBudgets.map(s => ({
                        ...s,
                        transactions: s.transactions.filter(t => t.id !== id)
                    }))
                }));
            }
            this.resetDelete();
        }
    }));
});
