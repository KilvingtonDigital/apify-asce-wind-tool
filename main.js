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

    // --- Helper: Nuke Modals ---
    const nukeModals = async () => {
        await page.evaluate(() => {
            console.log("Nuking modals...");
            const selectors = ['calcite-modal', '.modal', '.popup', 'calcite-scrim', '.modal-backdrop', '.esri-popup'];
            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => el.remove());
            });
            // Try to force close Esri popups via API if exposed (unlikely, but defensive)
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
                // Search deeply if possible, or just standard querySelectorAll
                const elements = Array.from(document.querySelectorAll(t));
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

        // --- 5. Settings (UI Interaction Fix) ---
        console.log("[DEBUG] Setting Risk Category (UI Click)...");
        // 1. Click the dropdown to open it
        // Try looking for the visible text "Select Risk"
        const dropdownClicked = await clickByText('*', 'Select Risk');
        if (!dropdownClicked) {
            console.log("[DEBUG] 'Select Risk' text not found. Trying Force-Value method just in case...");
            // Fallback to old method if UI click fails, but strictly safer
            await page.evaluate(() => {
                const selects = document.querySelectorAll('calcite-select');
                if (selects.length > 0) {
                    selects[0].value = "II";
                }
            });
        }
        await new Promise(r => setTimeout(r, 1000));

        // 2. Click the option "Risk Category II"
        console.log("[DEBUG] Selecting 'Risk Category II'...");
        const optionClicked = await clickByText('*', 'Risk Category II');
        if (!optionClicked) {
            console.log("[DEBUG] 'Risk Category II' not found via click. Trying 'II'...");
            await clickByText('*', 'II');
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

        // Try multiple button text variations
        let resultsClicked = await clickByText('button', 'View Results');
        if (!resultsClicked) resultsClicked = await clickByText('span', 'View Results');
        if (!resultsClicked) {
            console.log("[DEBUG] 'View Results' text click failed. Searching for button attribute...");
            resultsClicked = await page.evaluate(() => {
                const btn = document.querySelector('button[title="View Results"]');
                if (btn) { btn.click(); return true; }
                return false;
            });
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
