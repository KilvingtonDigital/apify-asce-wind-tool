const { Actor } = require('apify');
const { launchPuppeteer } = require('crawlee');

Actor.main(async () => {
    // 1. Get Input with Local Fallback
    let input = await Actor.getInput();

    // Check if running locally (no platform env vars usually means local node run)
    const isLocal = !process.env.APIFY_IS_AT_HOME;

    if (!input && isLocal) {
        console.log("Running locally? Attempting to load 'local_input.json'...");
        try {
            input = require('./local_input.json');
        } catch (e) { console.log("Could not load local_input.json"); }
    }

    const address = input && input.address;

    if (!address) {
        throw new Error('Input must contain "address" field.');
    }

    console.log(`Starting ASCE Wind Speed Lookup for: ${address}`);

    // 2. Launch Puppeteer via Crawlee
    const browser = await launchPuppeteer({
        useChrome: true,
        launchOptions: {
            // Force headful if local dev, otherwise use input setting or default to "new" (headless) in prod
            headless: isLocal ? false : 'new',
            args: ['--window-size=1280,800', '--start-maximized']
        }
    });

    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1280, height: 800 });

        console.log('Navigating to ASCE Hazard Tool...');
        await page.goto('https://ascehazardtool.org/', { waitUntil: 'networkidle2', timeout: 60000 });

        // --- Helper Functions ---
        const clickByText = async (tag, text) => {
            try {
                const element = await page.waitForSelector(`::-p-xpath(//${tag}[contains(text(), "${text}")])`, { timeout: 3000 });
                if (element) {
                    await element.click();
                    return true;
                }
            } catch (e) { }
            return false;
        };

        // --- 3. Handle Popups ---
        console.log("Handling popups...");
        try {
            await clickByText('button', 'Got it!');
        } catch (e) { }

        // Welcome Popup - Try Escape first, then selectors
        try {
            console.log("Waiting for potential popups...");
            const closeSelectors = [
                'calcite-action[icon="x"]', 'button[title="Close"]', '.modal-close', 'span.esri-icon-close',
                'div[role="button"][aria-label="Close"]', '.calcite-action', 'button.close', 'calcite-modal .close'
            ];
            // Aggressive loop
            for (let i = 0; i < 5; i++) {
                await page.keyboard.press('Escape');
                await new Promise(r => setTimeout(r, 500));
                await page.evaluate((selectors) => {
                    selectors.forEach(sel => { document.querySelectorAll(sel).forEach(el => el.click()); });
                    const modals = document.querySelectorAll('calcite-modal, .modal, .popup');
                    modals.forEach(m => m.style.display = 'none');
                }, closeSelectors);
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) { console.log("Popup warning: " + e.message); }

        // --- 4. Input Address ---
        console.log(`Searching for address: ${address}`);

        // Define a helper to pierce Shadow DOM deeply
        const findDeepInput = async () => {
            return await page.evaluateHandle(() => {
                function traverse(root) {
                    if (!root) return null;
                    if (root.querySelectorAll) {
                        const inputs = root.querySelectorAll('input');
                        for (const input of inputs) {
                            if (input.placeholder && input.placeholder.includes('Location')) return input;
                            if (input.classList.contains('esri-input')) return input;
                        }
                    }

                    // Walk children to find shadow roots
                    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
                    let node;
                    while (node = walker.nextNode()) {
                        if (node.shadowRoot) {
                            const found = traverse(node.shadowRoot);
                            if (found) return found;
                        }
                    }
                    return null;
                }
                return traverse(document.body);
            });
        };

        // 1. Try to "Activate" or "Expand" the widget first
        try {
            const expandBtn = await page.$('.esri-icon-search, .esri-search__submit-button');
            if (expandBtn) await expandBtn.click();
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { }

        let inputHandle = await findDeepInput();

        // Retry logic for finding input
        if (!inputHandle.id && !inputHandle.asElement()) {
            console.log("Input not found instantly, waiting 3s...");
            await new Promise(r => setTimeout(r, 3000));
            inputHandle = await findDeepInput();
        }

        if (inputHandle && inputHandle.asElement()) {
            console.log("Found input via Deep Shadow Walker!");
            await inputHandle.focus();
            await page.keyboard.type(address, { delay: 100 });
        } else {
            console.log("Deep Walker failed. Trying Tab Navigation Fallback...");
            // Tab Navigation Fallback
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab'); // Maybe 3 times?
            await page.keyboard.type(address, { delay: 100 });
        }

        // Dump HTML if we suspect failure (for debugging)
        const htmlDump = await page.content();
        await Actor.setValue('DEBUG_HTML', htmlDump, { contentType: 'text/html' });

        // Wait for suggestions or force Enter
        const suggestionSelector = '.esri-search__suggestions-list li, ul[role="listbox"] li';
        try {
            console.log("Waiting for address suggestions...");
            await page.waitForSelector(suggestionSelector, { timeout: 5000 });
            const suggestion = await page.$(suggestionSelector);
            if (suggestion) {
                console.log("Clicking suggestion...");
                await suggestion.click();
            } else {
                console.log("Suggestions found but empty? Pressing Enter.");
                await page.keyboard.press('Enter');
            }
        } catch (e) {
            console.log("No suggestions found (timeout). Force pressing Enter...");
            // Ensure focus is still on input (try first selector as fallback)
            try { await inputHandle.focus(); } catch (e) { }
            await page.keyboard.press('Enter');
        }

        // Critical: Wait after address submission for map to zoom/update
        console.log("Waiting 5s for map to update after address search...");
        await new Promise(r => setTimeout(r, 5000));

        // --- 5. Select Risk Category II ---
        console.log("Setting Risk Category...");
        await new Promise(r => setTimeout(r, 3000));
        try {
            const riskSelect = await page.$('select[aria-label*="Risk"], select');
            if (riskSelect) await riskSelect.select('II');
        } catch (e) { }

        // --- 6. Select Load Type: Wind ---
        console.log("Selecting Wind Load...");
        try {
            const windClicked = await clickByText('label', 'Wind');
        } catch (e) { }

        // --- 7. View Results ---
        console.log("Clicking View Results...");
        await clickByText('button', 'View Results');

        // --- 8. Extract Result ---
        console.log("Waiting for results...");

        // 60s timeout for safety on cloud runners
        await page.waitForFunction(() => document.body.innerText.includes('Vmph'), { timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

        const windSpeed = await page.evaluate(() => {
            // Heuristic: find text containing "Vmph"
            const elements = document.querySelectorAll('*');
            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                if (el.childNodes.length === 1 && el.textContent.includes('Vmph')) {
                    return el.textContent.trim();
                }
            }
            return null;
        });

        if (windSpeed) {
            console.log(`SUCCESS: Found Wind Speed: ${windSpeed}`);
            // Push data to Apify dataset (this is the API response)
            await Actor.pushData({
                address: address,
                wind_speed: windSpeed,
                status: 'success'
            });
        } else {
            throw new Error("Vmph not found on page.");
        }

    } catch (error) {
        console.error("Scraping failed: " + error.message);
        require('fs').writeFileSync('error.log', error.stack || error.message);

        // Take screenshot on failure
        try {
            if (page) {
                const screenshotBuffer = await page.screenshot();
                await Actor.setValue('ERROR_SCREENSHOT', screenshotBuffer, { contentType: 'image/png' });
                console.log('Saved error screenshot to Key-Value Store as "ERROR_SCREENSHOT"');
            }
        } catch (e) { console.log("Could not save screenshot"); }

        await Actor.pushData({
            address: address,
            status: 'failed',
            error: error.message
        });
        throw error;
    } finally {
        if (browser) await browser.close();
    }
});
