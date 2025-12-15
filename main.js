const Apify = require('apify');

Apify.main(async () => {
    // 1. Get Input
    const input = await Apify.getInput();
    const address = input && input.address;

    if (!address) {
        throw new Error('Input must contain "address" field.');
    }

    console.log(`Starting ASCE Wind Speed Lookup for: ${address}`);

    // 2. Launch Puppeteer
    // Apify manages the browser launch (headless, stealth, proxies etc.)
    const browser = await Apify.launchPuppeteer({
        useChrome: true,
        stealth: true,
        launchOptions: {
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
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 1000));

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

            await page.evaluate((selectors) => {
                for (const sel of selectors) {
                    const els = document.querySelectorAll(sel);
                    els.forEach(el => {
                        el.click();
                    });
                }
            }, closeSelectors);

            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.log("Popup close sequence warning: " + e.message);
        }

        // --- 4. Input Address ---
        console.log(`Searching for address: ${address}`);
        const inputSelector = 'input[placeholder="Enter Location"], input[type="text"].esri-input';

        try {
            // Attempt standard wait
            try {
                await page.waitForSelector(inputSelector, { visible: true, timeout: 5000 });
            } catch (e) { console.log("Input not visible/interactable, attempting forced injection."); }

            // Force inject value even if covered
            await page.evaluate((selector, addr) => {
                const el = document.querySelector(selector);
                if (el) {
                    el.value = addr;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.focus();
                }
            }, inputSelector, address);

            // Also try standard type if possible
            try { await page.type(inputSelector, ' ', { delay: 100 }); } catch (e) { }

        } catch (e) {
            console.error("Error interacting with input: " + e.message);
            throw new Error("Could not input address");
        }

        // Wait for suggestions
        const suggestionSelector = '.esri-search__suggestions-list li, ul[role="listbox"] li';
        try {
            await page.waitForSelector(suggestionSelector, { timeout: 8000 });
            const suggestion = await page.$(suggestionSelector);
            if (suggestion) {
                await suggestion.click();
            } else {
                await page.keyboard.press('Enter');
            }
        } catch (e) {
            console.log("No suggestions, using Enter...");
            await page.keyboard.press('Enter');
        }

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
            await Apify.pushData({
                address: address,
                wind_speed: windSpeed,
                status: 'success'
            });
        } else {
            throw new Error("Vmph not found on page.");
        }

    } catch (error) {
        console.error("Scraping failed: " + error.message);
        await Apify.pushData({
            address: address,
            status: 'failed',
            error: error.message
        });
        throw error;
    } finally {
        await browser.close();
    }
});
