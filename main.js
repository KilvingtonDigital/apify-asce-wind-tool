const { Actor } = require('apify');
const { launchPuppeteer } = require('crawlee');

Actor.main(async () => {
    // 1. Get Input
    const input = await Actor.getInput();
    const address = input && input.address;

    if (!address) {
        throw new Error('Input must contain "address" field.');
    }

    console.log(`Starting ASCE Wind Speed Lookup for: ${address}`);

    // 2. Launch Puppeteer via Crawlee (modern)
    const browser = await launchPuppeteer({
        useChrome: true,
        launchOptions: {
            // Standard stealth args are handled by Crawlee automatically
            args: ['--window-size=1280,800']
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
                'calcite-action[icon="x"]',
                'button[title="Close"]',
                '.modal-close',
                'span.esri-icon-close',
                'div[role="button"][aria-label="Close"]',
                '.calcite-action',
                'button.close',
                'calcite-modal .close'
            ];

            // Aggressive loop to ensure popup is GONE
            for (let i = 0; i < 5; i++) {
                await page.keyboard.press('Escape');
                await new Promise(r => setTimeout(r, 500));

                await page.evaluate((selectors) => {
                    selectors.forEach(sel => {
                        document.querySelectorAll(sel).forEach(el => el.click());
                    });
                    // Force remove generic modal containers if they exist
                    const modals = document.querySelectorAll('calcite-modal, .modal, .popup');
                    modals.forEach(m => m.style.display = 'none');
                }, closeSelectors);

                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) {
            console.log("Popup close sequence warning: " + e.message);
        }

        // --- 4. Input Address ---
        // --- 4. Input Address ---
        console.log(`Searching for address: ${address}`);

        // Use standard and deep selectors to find the input within Esri's Shadow DOM/iframe structure
        const searchWidgetSelectors = [
            'esri-search >>> input',
            '.esri-search__input',
            'input[placeholder="Enter Location"]'
        ];

        let inputFound = false;

        // 1. Try to "Activate" or "Expand" the widget first
        try {
            const expandBtn = await page.$('.esri-icon-search, .esri-search__submit-button');
            if (expandBtn) await expandBtn.click();
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { }

        // 2. Find and Type
        for (const selector of searchWidgetSelectors) {
            try {
                // Check if element exists
                const el = await page.$(selector);
                if (el) {
                    console.log(`Found address input via selector: ${selector}`);
                    await el.focus();

                    // Type slowly
                    await page.keyboard.type(address, { delay: 100 });
                    inputFound = true;
                    break;
                }
            } catch (e) { console.log(`Selector failed: ${selector}`); }
        }

        if (!inputFound) {
            console.log("Could not type using standard Puppeteer. Trying forced injection...");
            // Fallback: Force inject using deep logic
            await page.evaluate((addr) => {
                // Try to find ANY input that looks like a search bar
                const inputs = document.querySelectorAll('input');
                let target = null;
                for (const i of inputs) {
                    if (i.placeholder && i.placeholder.includes('Location')) target = i;
                    if (i.className.includes('esri-input')) target = i;
                }

                if (target) {
                    target.value = addr;
                    target.dispatchEvent(new Event('input', { bubbles: true }));
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    target.focus();
                } else {
                    // Try Shadow DOM
                    const search = document.querySelector('esri-search');
                    if (search && search.shadowRoot) {
                        const shadowInput = search.shadowRoot.querySelector('input');
                        if (shadowInput) {
                            shadowInput.value = addr;
                            shadowInput.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }
                }
            }, address);
        }

        // Wait for suggestions or force Enter
        const suggestionSelector = '.esri-search__suggestions-list li, ul[role="listbox"] li';
        try {
            console.log("Waiting for address suggestions...");
            // Shorter timeout for suggestions, usually they appear fast if working
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
            // Ensure focus is still on input
            await page.focus(inputSelector).catch(() => console.log("Focus warning"));
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
            if (riskSelect) {
                await riskSelect.select('II');
            }
        } catch (e) {
            console.log("Could not auto-select Risk Category.");
        }

        // --- 6. Select Load Type: Wind ---
        console.log("Selecting Wind Load...");
        try {
            const windClicked = await clickByText('label', 'Wind');
            if (!windClicked) {
                const windCheckbox = await page.$('input[value="Wind"], input[name="Wind"]');
                if (windCheckbox) await windCheckbox.click();
            }
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
            // Fallback: TreeWalker
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while (node = walker.nextNode()) {
                if (node.textContent.includes('Vmph')) {
                    return node.textContent.trim();
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

        // Take screenshot on failure
        try {
            const screenshotBuffer = await page.screenshot();
            await Actor.setValue('ERROR_SCREENSHOT', screenshotBuffer, { contentType: 'image/png' });
            console.log('Saved error screenshot to Key-Value Store as "ERROR_SCREENSHOT"');
        } catch (e) { console.log("Could not save screenshot"); }

        await Actor.pushData({
            address: address,
            status: 'failed',
            error: error.message
        });
        throw error;
    } finally {
        await browser.close();
    }
});
