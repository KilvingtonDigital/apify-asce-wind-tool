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

    // Enable video recording via CDP (Chrome DevTools Protocol)
    let videoPath = null;
    if (!isLocal) {
        try {
            const fs = require('fs');
            const path = require('path');
            const client = await page.target().createCDPSession();

            videoPath = path.join(process.cwd(), 'recording.webm');
            const stream = fs.createWriteStream(videoPath);

            await client.send('Page.startScreencast', {
                format: 'png',
                quality: 80,
                everyNthFrame: 1
            });

            client.on('Page.screencastFrame', async ({ data, sessionId }) => {
                try {
                    stream.write(Buffer.from(data, 'base64'));
                    await client.send('Page.screencastFrameAck', { sessionId });
                } catch (e) {
                    console.log(`[DEBUG] Screencast frame error: ${e.message}`);
                }
            });

            console.log('[DEBUG] Screen recording started');
        } catch (e) {
            console.log(`[DEBUG] Failed to start recording: ${e.message}`);
        }
    }



    // --- Helper: Save Debug Assets ---
    const saveDebugAssets = async (prefix) => {
        try {
            if (page) {
                const html = await page.content();
                await Actor.setValue(`${prefix}_HTML`, html.substring(0, 500000), { contentType: 'text/html' });
                const buffer = await page.screenshot({ fullPage: true });
                await Actor.setValue(`${prefix}_SCREENSHOT`, buffer, { contentType: 'image/png' });
                console.log(`[DEBUG] Saved assets for ${prefix}`);
            }
        } catch (e) { console.log(`[DEBUG] Failed to save assets: ${e.message}`); }
    };

    // --- Helper: Inspect Elements ---
    const inspectElements = async (description) => {
        console.log(`\n=== ELEMENT INSPECTION: ${description} ===`);
        const info = await page.evaluate(() => {
            const results = {
                buttons: [],
                selects: [],
                modals: [],
                inputs: [],
                visibleText: document.body.innerText.substring(0, 500)
            };

            // Inspect buttons
            document.querySelectorAll('button').forEach((btn, i) => {
                if (i < 10) { // Limit to first 10
                    results.buttons.push({
                        text: btn.textContent.trim().substring(0, 50),
                        title: btn.getAttribute('title'),
                        disabled: btn.disabled,
                        class: btn.className,
                        visible: btn.offsetParent !== null
                    });
                }
            });

            // Inspect selects (including calcite-select)
            document.querySelectorAll('select, calcite-select').forEach((sel, i) => {
                if (i < 5) {
                    results.selects.push({
                        tagName: sel.tagName,
                        value: sel.value,
                        options: sel.options ? Array.from(sel.options).map(o => o.text) : [],
                        class: sel.className
                    });
                }
            });

            // Inspect modals
            document.querySelectorAll('calcite-modal, .modal, [role="dialog"]').forEach((modal, i) => {
                if (i < 5) {
                    results.modals.push({
                        tagName: modal.tagName,
                        class: modal.className,
                        visible: modal.offsetParent !== null,
                        text: modal.textContent.trim().substring(0, 100)
                    });
                }
            });

            return results;
        });

        console.log('Buttons:', JSON.stringify(info.buttons, null, 2));
        console.log('Selects:', JSON.stringify(info.selects, null, 2));
        console.log('Modals:', JSON.stringify(info.modals, null, 2));
        console.log('Visible Text Preview:', info.visibleText);
        console.log('=== END INSPECTION ===\n');

        return info;
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
        await inspectElements('After Initial Modal Handling');

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
        await inspectElements('Before Risk Category Selection');

        // --- 5. Settings (Risk Category) ---
        console.log("[DEBUG] Setting Risk Category...");

        // This is a standard HTML <select> element, not a custom component
        // Directly set the value
        const riskSetResult = await page.evaluate(() => {
            const select = document.querySelector('select.risk-level-selector');
            if (!select) {
                console.log('[DEBUG] select.risk-level-selector not found');
                return { success: false, reason: 'selector_not_found' };
            }

            console.log(`[DEBUG] Found select, current value: ${select.value}`);
            console.log(`[DEBUG] Available options:`, Array.from(select.options).map(o => ({ value: o.value, text: o.text })));

            // Find the option with text "II" and get its value attribute
            const optionII = Array.from(select.options).find(opt => opt.text.trim() === 'II');
            if (!optionII) {
                console.log('[DEBUG] Option with text "II" not found');
                return { success: false, reason: 'option_not_found' };
            }

            console.log(`[DEBUG] Found option "II" with value: ${optionII.value}`);

            // Set to Risk Category II using the actual value attribute
            select.value = optionII.value;

            // Trigger change events to notify UI
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));

            console.log(`[DEBUG] Set value to '${optionII.value}', new value: ${select.value}`);

            return { success: true, newValue: select.value, optionText: optionII.text };
        });

        console.log(`[DEBUG] Risk Category Set Result:`, JSON.stringify(riskSetResult));

        if (!riskSetResult.success) {
            console.log("[DEBUG] CRITICAL: Failed to set Risk Category");
            await saveDebugAssets('RISK_CATEGORY_FAIL');
            throw new Error(`Failed to set Risk Category: ${riskSetResult.reason}`);
        }

        // Wait for UI to update
        await new Promise(r => setTimeout(r, 2000));

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
        await inspectElements('Before Clicking View Results');

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
        // Save video recording if it exists
        if (!isLocal && videoPath) {
            try {
                const fs = require('fs');

                // Stop recording
                try {
                    const client = await page.target().createCDPSession();
                    await client.send('Page.stopScreencast');
                    console.log('[DEBUG] Screen recording stopped');
                } catch (e) {
                    console.log(`[DEBUG] Error stopping screencast: ${e.message}`);
                }

                // Wait a bit for file to finish writing
                await new Promise(r => setTimeout(r, 2000));

                if (fs.existsSync(videoPath)) {
                    const videoBuffer = fs.readFileSync(videoPath);
                    await Actor.setValue('RUN_VIDEO', videoBuffer, { contentType: 'video/webm' });
                    console.log(`[DEBUG] Uploaded video recording`);
                } else {
                    console.log(`[DEBUG] Video file not found at ${videoPath}`);
                }
            } catch (e) {
                console.log(`[DEBUG] Failed to upload video: ${e.message}`);
            }
        }

        if (browser) await browser.close();
    }
});
