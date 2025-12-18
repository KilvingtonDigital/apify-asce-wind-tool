const { Actor } = require('apify');
const { launchPlaywright } = require('crawlee');

Actor.main(async () => {
    // 1. Get Input
    let input = await Actor.getInput();
    const isLocal = !process.env.APIFY_IS_AT_HOME;

    if (!input && isLocal) {
        try { input = require('./local_input.json'); } catch (e) { }
    }

    const address = input && input.address;
    if (!address) throw new Error('Input must contain "address" field.');

    console.log(`[DEBUG] Starting ASCE Wind Speed Lookup for: ${address}`);

    let browser, page;

    try {
        // 2. Launch Playwright Browser using Crawlee
        browser = await launchPlaywright({
            headless: isLocal ? false : true,
            launchOptions: {
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        page = await browser.newPage();

        // 3. Network Monitoring
        const networkLog = [];
        page.on('request', request => {
            const url = request.url();
            if (url.includes('hazard') || url.includes('api') || url.includes('wind')) {
                console.log(`[NETWORK →] ${request.method()} ${url}`);
                networkLog.push({ type: 'request', method: request.method(), url });
            }
        });

        page.on('response', async response => {
            const url = response.url();
            if (url.includes('hazard') || url.includes('api') || url.includes('wind')) {
                console.log(`[NETWORK ←] ${response.status()} ${url}`);
                networkLog.push({ type: 'response', status: response.status(), url });
            }
        });

        // Helper: Capture DOM structure and element details
        const captureDOMSnapshot = async (label) => {
            console.log(`\n=== DOM SNAPSHOT: ${label} ===`);
            const snapshot = await page.evaluate(() => {
                const result = {
                    buttons: [],
                    selects: [],
                    inputs: [],
                    visibleText: document.body.innerText.substring(0, 500)
                };

                // Capture all buttons with their attributes
                document.querySelectorAll('button').forEach((btn, i) => {
                    if (i < 15) {
                        result.buttons.push({
                            index: i,
                            text: btn.textContent.trim().substring(0, 100),
                            id: btn.id,
                            class: btn.className,
                            title: btn.getAttribute('title'),
                            ariaLabel: btn.getAttribute('aria-label'),
                            disabled: btn.disabled,
                            visible: btn.offsetParent !== null,
                            outerHTML: btn.outerHTML.substring(0, 200)
                        });
                    }
                });

                // Capture all select elements
                document.querySelectorAll('select').forEach((sel, i) => {
                    result.selects.push({
                        index: i,
                        id: sel.id,
                        class: sel.className,
                        name: sel.name,
                        value: sel.value,
                        options: Array.from(sel.options).map(o => ({
                            value: o.value,
                            text: o.text,
                            selected: o.selected
                        }))
                    });
                });

                // Capture inputs
                document.querySelectorAll('input').forEach((inp, i) => {
                    if (i < 10) {
                        result.inputs.push({
                            index: i,
                            type: inp.type,
                            id: inp.id,
                            class: inp.className,
                            name: inp.name,
                            placeholder: inp.placeholder,
                            value: inp.value,
                            checked: inp.checked
                        });
                    }
                });

                return result;
            });

            console.log('Buttons:', JSON.stringify(snapshot.buttons, null, 2));
            console.log('Selects:', JSON.stringify(snapshot.selects, null, 2));
            console.log('Inputs:', JSON.stringify(snapshot.inputs, null, 2));
            console.log('Visible Text Preview:', snapshot.visibleText);
            console.log('=== END SNAPSHOT ===\n');

            return snapshot;
        };

        // 4. Navigate to ASCE Hazard Tool
        console.log('[DEBUG] Navigating to ASCE Hazard Tool...');
        await page.goto('https://ascehazardtool.org/', { waitUntil: 'networkidle', timeout: 60000 });

        // 5. Handle Cookie Banner
        console.log('[DEBUG] Handling cookie banner...');
        try {
            await page.click('button:has-text("Got it!")', { timeout: 5000 });
            console.log('[DEBUG] Clicked "Got it!" button');
        } catch (e) {
            console.log('[DEBUG] No cookie banner found or already dismissed');
        }

        // Wait for map to load
        await page.waitForTimeout(5000);

        // 6. Find and Fill Address Input (Shadow DOM)
        console.log('[DEBUG] Searching for address input...');

        const inputFilled = await page.evaluate((addr) => {
            function findInput(root) {
                // Check current level
                const inputs = root.querySelectorAll('input');
                for (const input of inputs) {
                    const placeholder = input.getAttribute('placeholder') || '';
                    if (placeholder.toLowerCase().includes('address') ||
                        placeholder.toLowerCase().includes('location') ||
                        placeholder.toLowerCase().includes('place') ||
                        input.classList.contains('esri-input')) {
                        return input;
                    }
                }

                // Check shadow roots
                const elements = root.querySelectorAll('*');
                for (const el of elements) {
                    if (el.shadowRoot) {
                        const found = findInput(el.shadowRoot);
                        if (found) return found;
                    }
                }
                return null;
            }

            const input = findInput(document.body);
            if (input) {
                input.focus();
                input.value = addr;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            return false;
        }, address);

        if (!inputFilled) {
            throw new Error('Could not find address input field');
        }

        console.log('[DEBUG] Address input filled');

        // Type the address character by character for better reliability
        await page.keyboard.type(address, { delay: 50 });
        await page.waitForTimeout(2000);

        // Try to click suggestion or press Enter
        try {
            await page.click('.esri-search__suggestions-list li', { timeout: 4000 });
            console.log('[DEBUG] Clicked address suggestion');
        } catch (e) {
            console.log('[DEBUG] No suggestions, pressing Enter');
            await page.keyboard.press('Enter');
        }

        // Wait for map to update
        await page.waitForTimeout(5000);

        // Capture DOM before setting Risk Category
        await captureDOMSnapshot('Before Risk Category Selection');

        // 7. Set Risk Category II
        console.log('[DEBUG] Setting Risk Category to II...');

        const riskResult = await page.evaluate(() => {
            const select = document.querySelector('select.risk-level-selector');
            if (!select) return { success: false, reason: 'select not found' };

            // Find option with text "II"
            const option = Array.from(select.options).find(opt => opt.text.trim() === 'II');
            if (!option) return { success: false, reason: 'option II not found' };

            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));

            return { success: true, value: option.value };
        });

        console.log(`[DEBUG] Risk Category result:`, riskResult);
        if (!riskResult.success) {
            throw new Error(`Failed to set Risk Category: ${riskResult.reason}`);
        }

        await page.waitForTimeout(1000);

        // 8. Select Wind Load
        console.log('[DEBUG] Selecting Wind load...');

        await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('label'));
            const windLabel = labels.find(l => l.textContent.includes('Wind'));
            if (windLabel) windLabel.click();
        });

        await page.waitForTimeout(1000);

        // Capture DOM before clicking View Results
        await captureDOMSnapshot('Before View Results Click');

        // 9. Click "View Results" and Wait for Response
        console.log('[DEBUG] Clicking View Results...');

        // Take screenshot before clicking
        await page.screenshot({ path: 'before_view_results.png', fullPage: true });

        try {
            // Wait for both the click and network response
            await Promise.all([
                page.waitForResponse(response =>
                    response.url().includes('hazard') || response.url().includes('wind'),
                    { timeout: 10000 }
                ).catch(() => console.log('[DEBUG] No network response detected')),
                page.click('button:has-text("View Results")').catch(() =>
                    page.click('*:has-text("View Results")')
                )
            ]);

            console.log('[DEBUG] View Results clicked');
        } catch (e) {
            console.log(`[DEBUG] Error clicking View Results: ${e.message}`);
            await page.screenshot({ path: 'view_results_error.png', fullPage: true });
        }

        // Wait for results to load
        console.log('[DEBUG] Waiting for wind speed results...');

        try {
            await page.waitForFunction(
                () => document.body.innerText.includes('Vmph'),
                { timeout: 30000 }
            );

            console.log('[DEBUG] Wind speed data appeared');
        } catch (e) {
            console.log('[DEBUG] Timeout waiting for Vmph');
            await page.screenshot({ path: 'timeout.png', fullPage: true });

            // Log current page content
            const content = await page.content();
            console.log('[DEBUG] Page content length:', content.length);
            console.log('[DEBUG] Network log:', JSON.stringify(networkLog, null, 2));

            throw new Error('Wind speed data did not appear');
        }

        // 10. Extract Wind Speed
        const windSpeed = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            const vmphElement = elements.find(el =>
                el.childNodes.length === 1 &&
                el.textContent.includes('Vmph')
            );
            return vmphElement ? vmphElement.textContent.trim() : null;
        });

        if (!windSpeed) {
            throw new Error('Could not extract wind speed value');
        }

        console.log(`[DEBUG] SUCCESS: Extracted wind speed: ${windSpeed}`);

        // 11. Save Results
        await Actor.pushData({
            address,
            wind_speed: windSpeed,
            status: 'success',
            timestamp: new Date().toISOString()
        });

        // Save final screenshot
        await page.screenshot({ path: 'success.png', fullPage: true });

    } catch (error) {
        console.error(`[CRITICAL FAILURE] ${error.message}`);
        console.error(error.stack);

        // Save error screenshot
        if (page) {
            await page.screenshot({ path: 'error.png', fullPage: true });
        }

        // Push error to dataset
        await Actor.pushData({
            address,
            status: 'failed',
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });

        throw error;
    } finally {
        // Upload screenshots
        const fs = require('fs');
        const screenshots = ['before_view_results.png', 'success.png', 'error.png', 'timeout.png', 'view_results_error.png'];
        for (const screenshot of screenshots) {
            if (fs.existsSync(screenshot)) {
                const buffer = fs.readFileSync(screenshot);
                await Actor.setValue(screenshot.replace('.png', '').toUpperCase(), buffer, { contentType: 'image/png' });
            }
        }

        // Close browser
        if (browser) {
            await browser.close();
        }
    }
});
