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
        // optimized to fail fast (3s) so fallbacks trigger quickly
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

            // Check once quickly before entering loop
            const needsPopupHandling = await page.evaluate((selectors) => {
                return selectors.some(s => document.querySelector(s));
            }, closeSelectors);

            if (needsPopupHandling) {
                // Aggressive loop only if needed
                for (let i = 0; i < 3; i++) {
                    await page.keyboard.press('Escape');
                    await new Promise(r => setTimeout(r, 500));
                    await page.evaluate((selectors) => {
                        selectors.forEach(sel => { document.querySelectorAll(sel).forEach(el => el.click()); });
                        const modals = document.querySelectorAll('calcite-modal, .modal, .popup');
                        modals.forEach(m => m.style.display = 'none');
                    }, closeSelectors);
                    await new Promise(r => setTimeout(r, 500));
                }
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
            await new Promise(r => setTimeout(r, 500)); // Short wait for expansion
        } catch (e) { }

        let inputHandle = await findDeepInput();

        // Retry logic for finding input
        if (!inputHandle.id && !inputHandle.asElement()) {
            console.log("Input not found instantly, waiting 2s...");
            await new Promise(r => setTimeout(r, 2000));
            inputHandle = await findDeepInput();
        }

        if (inputHandle && inputHandle.asElement()) {
            console.log("Found input via Deep Shadow Walker!");
            await inputHandle.focus();
            await page.keyboard.type(address, { delay: 50 }); // Faster typing
        } else {
            console.log("Deep Walker failed. Trying Tab Navigation Fallback...");
            // Tab Navigation Fallback
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            await page.keyboard.type(address, { delay: 50 });
        }

        // Wait for suggestions or force Enter
        const suggestionSelector = '.esri-search__suggestions-list li, ul[role="listbox"] li';
        try {
            console.log("Waiting for address suggestions...");
            // Fast timeout - if they aren't there in 3s, they probably won't show
            await page.waitForSelector(suggestionSelector, { timeout: 3000 });
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
            try { await inputHandle.focus(); } catch (e) { }
            await page.keyboard.press('Enter');
        }

        // Critical: Wait after address submission for map to zoom/update
        console.log("Waiting for map update...");
        // Replaced static 5s wait with smart wait? 
        // Logic: Wait for the address text to effectively "settle" or the UI to change. 
        // For safety/Map loading, a static wait is still safest, but we can reduce it if we detect success.
        await new Promise(r => setTimeout(r, 3000));

        // --- 5. Select Risk Category II ---
        console.log("Setting Risk Category...");
        try {
            // Try explicit risk selector first
            const riskSelect = await page.$('select[aria-label*="Risk"], select');
            if (riskSelect) await riskSelect.select('II');
        } catch (e) { }

        // --- 6. Select Load Type: Wind ---
        console.log("Selecting Wind Load...");
        try {
            // FIXED: This logic was truncated previously. 
            // 1. Try clicking the "Wind" text
            const windClicked = await clickByText('label', 'Wind');
            if (!windClicked) {
                console.log("Label click failed, trying checkbox input directly...");
                // 2. Fallback: Try clicking the input checkbox
                const windCheckbox = await page.$('input[value="Wind"], input[name="Wind"]');
                if (windCheckbox) {
                    await windCheckbox.click();
                } else {
                    console.log("Could not find Wind checkbox!");
                }
            }
        } catch (e) {
            console.log("Error selecting Wind Load: " + e.message);
        }

        // --- 7. View Results ---
        console.log("Clicking View Results...");
        await clickByText('button', 'View Results');

        // --- 8. Extract Result ---
        console.log("Waiting for results...");
        // 60s timeout for results to appear
        await page.waitForFunction(() => document.body.innerText.includes('Vmph'), { timeout: 60000 });

        // Wait a tiny bit for the overlay to stabilize
        await new Promise(r => setTimeout(r, 1000));

        const windSpeed = await page.evaluate(() => {
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
            }
        } catch (e) { }

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
