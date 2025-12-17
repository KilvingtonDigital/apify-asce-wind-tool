const { Actor } = require('apify');
const { launchPuppeteer } = require('crawlee');

Actor.main(async () => {
    // 1. Get Input with Local Fallback
    let input = await Actor.getInput();
    const isLocal = !process.env.APIFY_IS_AT_HOME;

    if (!input && isLocal) {
        try { input = require('./local_input.json'); } catch (e) { }
    }

    const address = input && input.address;
    if (!address) throw new Error('Input must contain "address" field.');

    console.log(`[DEBUG] Starting ASCE Wind Speed Lookup for: ${address}`);

    // 2. Launch Puppeteer
    const browser = await launchPuppeteer({
        useChrome: true,
        launchOptions: {
            headless: isLocal ? false : 'new',
            args: ['--window-size=1280,800', '--start-maximized']
        }
    });

    const page = await browser.newPage();

    // --- Helper: Save Debug Assets ---
    const saveDebugAssets = async (prefix) => {
        try {
            if (page) {
                const html = await page.content();
                await Actor.setValue(`${prefix}_HTML`, html.substring(0, 500000), { contentType: 'text/html' });
                const buffer = await page.screenshot();
                await Actor.setValue(`${prefix}_SCREENSHOT`, buffer, { contentType: 'image/png' });
                console.log(`[DEBUG] Saved assets for ${prefix}`);
            }
        } catch (e) { console.log(`[DEBUG] Failed to save assets: ${e.message}`); }
    };

    // --- Helper: Nuke Modals (Nuclear Option) ---
    const nukeModals = async () => {
        // 1. CSS Injection
        await page.addStyleTag({ content: 'calcite-modal, .modal, .popup, .esri-popup, calcite-scrim, .modal-backdrop { display: none !important; opacity: 0 !important; pointer-events: none !important; z-index: -9999 !important; }' });

        // 2. DOM Removal (Selector & Text Based)
        await page.evaluate(() => {
            console.log("Nuking modals via DOM removal...");
            const selectors = ['calcite-modal', '.modal', '.popup', 'calcite-scrim', '.modal-backdrop', '.esri-popup'];
            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => el.remove());
            });

            // Text-based Seek & Destroy (for stubborn "Welcome" modal)
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
                if (el.shadowRoot) continue;
                if (el.textContent && el.textContent.includes("Welcome to the ASCE Hazard Tool")) {
                    let container = el;
                    while (container && container.parentElement && container !== document.body) {
                        if (container.tagName.includes('MODAL') || container.tagName.includes('POPUP') || container.classList.contains('modal') || container.style.position === 'absolute' || container.style.position === 'fixed') {
                            console.log(`Removing specific modal container: ${container.tagName}`);
                            container.remove();
                            break;
                        }
                        container = container.parentElement;
                    }
                }
            }

            const closeBtns = document.querySelectorAll('button[title="Close"], .esri-popup__button--close');
            closeBtns.forEach(b => b.click());
        });
    };

    try {
        await page.setViewport({ width: 1280, height: 800 });

        console.log('[DEBUG] Navigating to ASCE Hazard Tool...');
        await page.goto('https://ascehazardtool.org/', { waitUntil: 'networkidle2', timeout: 60000 });

        // --- Helper: Click by Text ---
        const clickByText = async (tag, text) => {
            const result = await page.evaluate((t, txt) => {
                // Search all elements if tag is '*'
                const elements = Array.from(document.querySelectorAll(t === '*' ? '*' : t));
                // Try exact match first, then includes
                let found = elements.find(el => el.textContent.trim() === txt);
                if (!found) found = elements.find(el => el.textContent.includes(txt));

                if (found) {
                    found.scrollIntoView();
                    found.click();
                    return { success: true, count: elements.length, matched: found.outerHTML.substring(0, 50) };
                }
                return { success: false, count: elements.length };
            }, tag, text);
            console.log(`[DEBUG] clickByText('${tag}', '${text}') => Success:${result.success}`);
            return result.success;
        };

        // --- 3. Handle Popups (Nuke Strategy) ---
        console.log("[DEBUG] Handling popups...");
        await new Promise(r => setTimeout(r, 3000));
        await clickByText('button', 'Got it!');
        await nukeModals();

        // --- 4. Input Address ---
        console.log("[DEBUG] Waiting 5s for Map Widget Hydration (Critical)...");
        await new Promise(r => setTimeout(r, 5000));
        await nukeModals(); // Nuke again just in case

        // Deep Shadow Walker with Logging
        const findDeepInput = async () => {
            return await page.evaluateHandle(() => {
                let count = 0;
                function traverse(node) {
                    if (!node) return null;
                    count++;
                    if (node.nodeType === 1 && (
                        node.matches('input[placeholder*="Find address"]') ||
                        node.matches('input[placeholder*="place"]') ||
                        node.matches('input[placeholder*="Location"]') ||
                        node.matches('input.esri-input')
                    )) {
                        return node;
                    }
                    if (node.shadowRoot) {
                        const found = traverse(node.shadowRoot);
                        if (found) return found;
                    }
                    if (node.children) {
                        for (let child of node.children) {
                            const found = traverse(child);
                            if (found) return found;
                        }
                    }
                    return null;
                }
                return traverse(document.body);
            });
        };

        console.log(`[DEBUG] Searching for input field...`);
        let inputHandle = await findDeepInput();

        if (!inputHandle.id && !inputHandle.asElement()) {
            console.log("[DEBUG] Input not found initially, retrying...");
            await new Promise(r => setTimeout(r, 2000));
            inputHandle = await findDeepInput();
        }

        if (inputHandle && inputHandle.asElement()) {
            console.log("[DEBUG] Found input via Deep Shadow Walker!");
            await inputHandle.focus();
            // Just force type
            await page.keyboard.type(address, { delay: 100 });
        } else {
            console.log("[DEBUG] Deep Walker failed completely. Saving state...");
            await saveDebugAssets('INPUT_FAILURE');
            console.log("[DEBUG] Trying Tab Fallback...");
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            await page.keyboard.type(address, { delay: 100 });
        }

        // Suggestions
        console.log("[DEBUG] Waiting for suggestions...");
        await new Promise(r => setTimeout(r, 2000));
        await nukeModals();

        try {
            await page.waitForSelector('.esri-search__suggestions-list li', { timeout: 4000 });
            await page.click('.esri-search__suggestions-list li');
            console.log("[DEBUG] Clicked suggestion.");
        } catch (e) {
            console.log("[DEBUG] No suggestions found. Pressing Enter.");
            await page.keyboard.press('Enter');
        }

        console.log("[DEBUG] Waiting 5s for map update...");
        await new Promise(r => setTimeout(r, 5000));
        await nukeModals();

        // --- 5. Settings (Risk Category) ---
        console.log("[DEBUG] Setting Risk Category...");
        // Strategy A: UI Click
        let riskSuccess = false;
        await clickByText('*', 'Select Risk');
        await new Promise(r => setTimeout(r, 1000));

        riskSuccess = await clickByText('*', 'Risk Category II');
        if (!riskSuccess) riskSuccess = await clickByText('*', 'II');

        // Verification: Check if UI updated
        const isVerified = await page.evaluate(() => {
            const html = document.body.innerHTML;
            // If we see "Select Risk" still dominant or don't see "Risk Category II" as selected value
            // It's safer to assume failure and let DOM manipulate it.
            return document.body.innerText.includes("Risk Category II");
        });

        if (!isVerified && riskSuccess) {
            console.log("[DEBUG] Click reported success but 'Risk Category II' text is missing. Forcing Deep DOM Set.");
            riskSuccess = false;
        }

        // Strategy B: Force Value via DOM/ShadowDOM if Click Failed
        if (!riskSuccess) {
            console.log("[DEBUG] UI Click failed. Attempting deep DOM set...");
            riskSuccess = await page.evaluate(() => {
                function findCalciteSelect(node) {
                    if (!node) return null;
                    if (node.tagName === 'CALCITE-SELECT' || (node.classList && node.classList.contains('hazard-select'))) return node;
                    if (node.shadowRoot) {
                        const found = findCalciteSelect(node.shadowRoot);
                        if (found) return found;
                    }
                    if (node.children) {
                        for (let child of node.children) {
                            const found = findCalciteSelect(child);
                            if (found) return found;
                        }
                    }
                    return null;
                }

                // Try finding any select first
                let select = document.querySelector('calcite-select');
                if (!select) select = findCalciteSelect(document.body);

                if (select) {
                    select.value = 'II'; // Set value directly
                    return true;
                }
                return false;
            });
            console.log(`[DEBUG] Deep DOM Set result: ${riskSuccess}`);
        }

        // --- 6. Wind Load ---
        console.log("[DEBUG] Selecting Wind Load...");
        const windSelected = await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('label'));
            const windLabel = labels.find(l => l.textContent.includes('Wind'));
            if (windLabel) { windLabel.click(); return "Label Clicked"; }

            const input = document.querySelector('input[value="Wind"], input[name="Wind"]');
            if (input) { input.click(); return "Input Clicked"; }

            return "Failed";
        });
        console.log(`[DEBUG] Wind Selection Result: ${windSelected}`);

        // Force update just in case
        await new Promise(r => setTimeout(r, 1000));

        // --- 7. Results ---
        console.log("[DEBUG] Clicking View Results...");
        await nukeModals();

        // Try multiple button text variations with global search
        let resultsClicked = await clickByText('*', 'View Results');
        if (!resultsClicked) {
            console.log("[DEBUG] 'View Results' text click failed. Searching specific selector...");
            resultsClicked = await page.evaluate(() => {
                const btn = document.querySelector('button[title="View Results"], div[title="View Results"], span[title="View Results"]');
                if (btn) { btn.click(); return true; }
                // Try looking for button with text content manually
                const allBtns = Array.from(document.querySelectorAll('button'));
                const textBtn = allBtns.find(b => b.textContent && b.textContent.includes('View Result'));
                if (textBtn) { textBtn.click(); return true; }
                return false;
            });
        }
        console.log(`[DEBUG] View Results Clicked: ${resultsClicked}`);

        if (!resultsClicked) {
            console.log("[DEBUG] CRITICAL: Could not click View Results. Dumping state.");
            await saveDebugAssets('VIEW_RESULTS_FAIL');
            throw new Error("Could not click View Results button");
        }

        console.log("[DEBUG] Waiting for 'Vmph'...");
        try {
            await page.waitForFunction(() => document.body.innerText.includes('Vmph'), { timeout: 60000 });
        } catch (e) {
            console.log("[DEBUG] Timed out waiting for Vmph. Saving dump...");
            await saveDebugAssets('TIMEOUT_DUMP');
            throw e;
        }

        const windSpeed = await page.evaluate(() => {
            const element = Array.from(document.querySelectorAll('*'))
                .find(el => el.childNodes.length === 1 && el.textContent.includes('Vmph'));
            return element ? element.textContent.trim() : null;
        });

        if (windSpeed) {
            console.log(`[DEBUG] SUCCESS: ${windSpeed}`);
            await Actor.pushData({ address, wind_speed: windSpeed, status: 'success' });
        } else {
            console.log("[DEBUG] Vmph not found in final check.");
            await saveDebugAssets('MISSING_DATA');
            throw new Error("Vmph not found.");
        }

    } catch (error) {
        console.error("[CRITICAL FAILURE] " + error.message);
        await saveDebugAssets('FINAL_ERROR');
        try {
            require('fs').writeFileSync('error.log', error.stack || error.message);
        } catch (e) { }

        await Actor.pushData({
            address,
            status: 'failed',
            error: error.message,
            stack: error.stack
        });
        throw error;
    } finally {
        if (browser) await browser.close();
    }
});
