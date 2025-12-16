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

    console.log(`Starting ASCE Wind Speed Lookup for: ${address} `);

    // 2. Launch Puppeteer
    const browser = await launchPuppeteer({
        useChrome: true,
        launchOptions: {
            headless: isLocal ? false : 'new',
            args: ['--window-size=1280,800', '--start-maximized']
        }
    });

    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1280, height: 800 });

        console.log('Navigating to ASCE Hazard Tool...');
        await page.goto('https://ascehazardtool.org/', { waitUntil: 'networkidle2', timeout: 60000 });

        // --- Helper: Click by Text (Client-Side for Speed) ---
        const clickByText = async (tag, text) => {
            return await page.evaluate((t, txt) => {
                const elements = Array.from(document.querySelectorAll(t));
                const found = elements.find(el => el.textContent.includes(txt));
                if (found) {
                    found.click();
                    return true;
                }
                return false;
            }, tag, text);
        };

        // --- 3. Handle Popups ---
        console.log("Handling popups...");
        await new Promise(r => setTimeout(r, 2000)); // Let popups appear
        await clickByText('button', 'Got it!');

        // Defensive Popup Closing
        const closeSelectors = [
            'calcite-action[icon="x"]', 'button[title="Close"]', '.modal-close', 'span.esri-icon-close',
            'div[role="button"][aria-label="Close"]', '.calcite-action', 'button.close', 'calcite-modal .close'
        ];
        // Quick burst of Escape keys
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 300));
            await page.evaluate((sels) => {
                sels.forEach(s => document.querySelectorAll(s).forEach(el => el.click()));
            }, closeSelectors);
        }

        // --- 4. Input Address ---
        console.log("Waiting 5s for Map Widget Hydration (Critical)...");
        await new Promise(r => setTimeout(r, 5000));

        console.log(`Searching for address: ${address} `);

        // Deep Shadow Walker (Simpler & More Robust)
        const findDeepInput = async () => {
            return await page.evaluateHandle(() => {
                function traverse(node) {
                    if (!node) return null;
                    if (node.nodeType === 1 && (node.matches('input[placeholder*="Location"]') || node.matches('input.esri-input'))) {
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

        // Attempt to expand widget first
        await page.evaluate(() => {
            const btn = document.querySelector('.esri-icon-search, .esri-search__submit-button');
            if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        let inputHandle = await findDeepInput();

        // Retry Loop
        if (!inputHandle.id && !inputHandle.asElement()) {
            console.log("Input not found, retrying walker...");
            await new Promise(r => setTimeout(r, 2000));
            inputHandle = await findDeepInput();
        }

        if (inputHandle && inputHandle.asElement()) {
            console.log("Found input!");
            await inputHandle.focus();
            // Clear existing text just in case
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');

            await page.keyboard.type(address, { delay: 100 });
        } else {
            console.log("Deep Walker failed. Using Tab Fallback.");
            await page.keyboard.press('Tab');
            await page.keyboard.press('Tab');
            await page.keyboard.type(address, { delay: 100 });
        }

        // Suggestions
        console.log("Waiting for suggestions...");
        try {
            await page.waitForSelector('.esri-search__suggestions-list li', { timeout: 4000 });
            await page.click('.esri-search__suggestions-list li');
        } catch (e) {
            console.log("No suggestions. Pressing Enter.");
            await page.keyboard.press('Enter');
        }

        console.log("Waiting 5s for map update...");
        await new Promise(r => setTimeout(r, 5000));

        // --- 5. Settings ---
        console.log("Setting Risk Category...");
        const riskSelected = await page.evaluate(() => {
            const sels = Array.from(document.querySelectorAll('select'));
            const risk = sels.find(s => s.ariaLabel && s.ariaLabel.includes('Risk')) || sels[0];
            if (risk) {
                risk.value = 'II';
                risk.dispatchEvent(new Event('change'));
                return true;
            }
            return false;
        });

        // --- 6. Wind Load ---
        console.log("Selecting Wind Load...");
        // Use evaluate to avoid 3-minute Puppeteer hang
        const windSelected = await page.evaluate(() => {
            // Try label
            const labels = Array.from(document.querySelectorAll('label'));
            const windLabel = labels.find(l => l.textContent.includes('Wind'));
            if (windLabel) {
                windLabel.click();
                return true;
            }
            // Try input
            const input = document.querySelector('input[value="Wind"], input[name="Wind"]');
            if (input) {
                input.click();
                return true;
            }
            return false;
        });
        if (!windSelected) console.log("Warning: Could not select Wind Load.");

        // --- 7. Results ---
        console.log("Clicking View Results...");
        await clickByText('button', 'View Results');

        console.log("Waiting for 'Vmph'...");
        await page.waitForFunction(() => document.body.innerText.includes('Vmph'), { timeout: 60000 });

        const windSpeed = await page.evaluate(() => {
            const element = Array.from(document.querySelectorAll('*'))
                .find(el => el.childNodes.length === 1 && el.textContent.includes('Vmph'));
            return element ? element.textContent.trim() : null;
        });

        if (windSpeed) {
            console.log(`SUCCESS: ${windSpeed} `);
            await Actor.pushData({ address, wind_speed: windSpeed, status: 'success' });
        } else {
            throw new Error("Vmph not found.");
        }

    } catch (error) {
        console.error("Failed: " + error.message);
        try {
            if (page) {
                const buffer = await page.screenshot();
                await Actor.setValue('ERROR_SCREENSHOT', buffer, { contentType: 'image/png' });
            }
        } catch (e) { }
        await Actor.pushData({ address, status: 'failed', error: error.message });
        throw error;
    } finally {
        if (browser) await browser.close();
    }
});
