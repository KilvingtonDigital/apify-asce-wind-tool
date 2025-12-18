const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    console.log("Starting Local Logic Verification...");
    const address = "411 Crusaders Drive, Sanford, NC 27330";
    console.log(`Target Address: ${address}`);

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--window-size=1280,800', '--start-maximized']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
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
        if (!inputHandle.asElement()) { // Check provided handle
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
        await page.waitForFunction(() => document.body.innerText.includes('Vmph'), { timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

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
            fs.writeFileSync('result_success.json', JSON.stringify({ windSpeed }));
        } else {
            throw new Error("Vmph not found on page.");
        }

    } catch (error) {
        console.error("Scraping failed: " + error.message);
        fs.writeFileSync('result_error.log', error.stack || error.message);
        try {
            await page.screenshot({ path: 'test_failure.png' });
        } catch (e) { }
    } finally {
        // Keep browser open for a few seconds to see result
        await new Promise(r => setTimeout(r, 5000));
        await browser.close();
    }
})();
